const fs = require('node:fs')
const path = require('node:path')

const { rpc, setRpcUrl, getRpcUrl } = require('./lib/rpc')
const aml = require('./lib/aml')
const { buildConfig, buildDir, readDeployment } = require('./lib/env')

const REGISTER_COUNT = readPositiveInt('AML_STRESS_REGISTER_COUNT', 500)
const LIST_COUNT = readPositiveInt('AML_STRESS_LIST_COUNT', 200)
const BATCH_SIZE = Math.min(readPositiveInt('AML_STRESS_BATCH_SIZE', 8), 16)
const LIST_PRICE_BASE = 1000000

function readPositiveInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function unwrap(value) {
  return value && typeof value === 'object' && 'result' in value ? value.result : value
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString()
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

function makeLabels(runId, count) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = index.toString(36).padStart(3, '0')
    return `load-${runId}-${suffix}`
  })
}

async function view(contract, method, params = []) {
  return unwrap(await rpc('contract_call', [contract, method, params]))
}

async function viewInt(contract, method, params = []) {
  return Number(await view(contract, method, params))
}

async function settleTracked(state, phase, labels, contract, predicate, stateFile) {
  const tracked = labels.filter((label) => state[phase][label]?.status === 'submitted')
  if (tracked.length === 0) return

  console.log(`resume ${phase.padEnd(12)} ${tracked.length} submitted transaction(s)`)
  for (const label of tracked) {
    const entry = state[phase][label]
    try {
      await aml.waitForTx(entry.hash, { timeoutMs: 240000 })
    } catch (err) {
      entry.waitError = String(err.message ?? err)
    }
    if (!(await predicate(label))) {
      throw new Error(`${phase} transaction did not produce expected state for ${label}: ${entry.hash}`)
    }
    entry.status = 'confirmed'
    entry.confirmedAt = new Date().toISOString()
    saveState(stateFile, state)
  }
}

async function submitPhase({
  phase,
  labels,
  state,
  stateFile,
  config,
  contract,
  keypair,
  predicate,
  build,
}) {
  await settleTracked(state, phase, labels, contract, predicate, stateFile)

  let pending = labels.filter((label) => state[phase][label]?.status !== 'confirmed')
  const started = Date.now()
  let completed = labels.length - pending.length

  while (pending.length > 0) {
    const batch = pending.slice(0, BATCH_SIZE)
    const account = await aml.getAccountState(config.deployer)
    const recommended = await aml.getRecommendedFee('call')
    const ou = Math.max(recommended, config.callFeeOu)
    const submitted = []

    for (let index = 0; index < batch.length; index += 1) {
      const label = batch[index]
      const nonce = account.pendingNonce + index + 1
      const call = build(label, labels.indexOf(label))
      const tx = aml.buildCallTx({
        caller: config.deployer,
        contract,
        method: call.method,
        params: call.params,
        amount: call.amount,
        nonce,
        ou,
        keypair,
      })
      const hash = await aml.submitTx(tx)
      state[phase][label] = {
        status: 'submitted',
        hash,
        nonce,
        submittedAt: new Date().toISOString(),
      }
      saveState(stateFile, state)
      submitted.push({ label, hash })
    }

    const receipts = await Promise.allSettled(
      submitted.map(({ hash }) => aml.waitForTx(hash, { timeoutMs: 240000 })),
    )

    for (let index = 0; index < submitted.length; index += 1) {
      const { label, hash } = submitted[index]
      const result = receipts[index]
      const stateMatches = await predicate(label)
      if (!stateMatches) {
        const detail = result.status === 'rejected'
          ? `: ${result.reason?.message ?? result.reason}`
          : ''
        throw new Error(`${phase} did not produce expected state for ${label} (${hash})${detail}`)
      }
      state[phase][label].status = 'confirmed'
      state[phase][label].confirmedAt = new Date().toISOString()
      if (result.status === 'rejected') {
        state[phase][label].receiptWarning = String(result.reason?.message ?? result.reason)
      }
      completed += 1
    }

    saveState(stateFile, state)
    const elapsed = Math.max(1, Math.round((Date.now() - started) / 1000))
    const rate = (completed / elapsed).toFixed(2)
    console.log(`${phase.padEnd(12)} ${completed}/${labels.length} (${rate}/s)`)
    pending = labels.filter((label) => state[phase][label]?.status !== 'confirmed')
  }
}

function parseSnapshot(payload) {
  const [header, ...rows] = String(payload).split('#')
  return {
    header: header.split('|'),
    rows: rows.filter(Boolean).map((row) => row.split('|')),
  }
}

async function collectPages(contract, method, prefixParams) {
  const rows = []
  let cursor = 0
  let version = -1
  let total = 0

  do {
    const page = parseSnapshot(await view(contract, method, [...prefixParams, cursor, 25, version]))
    if (page.header[0] !== 'v1') throw new Error(`${method} returned ${page.header[0]}`)
    if (version < 0) version = Number(page.header[1])
    if (Number(page.header[1]) !== version) throw new Error(`${method} version changed during validation`)
    cursor = Number(page.header[2])
    total = Number(page.header[3])
    rows.push(...page.rows)
  } while (cursor < total)

  return { version, total, rows }
}

;(async () => {
  const { config, missing } = buildConfig()
  if (missing.length > 0) throw new Error(`missing required env vars: ${missing.join(', ')}`)
  if (config.network !== 'devnet') throw new Error('stress runner is restricted to devnet')
  if (LIST_COUNT > REGISTER_COUNT) throw new Error('list count cannot exceed register count')

  setRpcUrl(config.rpcUrl)
  const deployment = readDeployment(config.contractName, config.network)
  if (!deployment) throw new Error('deployment metadata not found')

  const contract = deployment.address
  const keypair = aml.keyPairFromBase64(config.privKey)
  const registrationPrice = await viewInt(contract, 'get_price_per_year')
  const callFee = Math.max(await aml.getRecommendedFee('call'), config.callFeeOu)
  const account = await aml.getAccountState(config.deployer)
  const estimatedCost = (REGISTER_COUNT * registrationPrice) + ((REGISTER_COUNT + LIST_COUNT) * callFee)
  if (account.balanceRaw < estimatedCost) {
    throw new Error(`insufficient balance for stress run: ${account.balanceRaw} < ${estimatedCost}`)
  }
  const stateFile = path.join(buildDir(config.contractName), `stress.${config.network}.json`)
  let state

  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (state.contract !== contract || state.deployer !== config.deployer) {
      throw new Error(`stress checkpoint belongs to another deployment: ${state.contract}`)
    }
    if (state.registerCount !== REGISTER_COUNT || state.listCount !== LIST_COUNT) {
      throw new Error('stress checkpoint counts differ from requested counts')
    }
  } else {
    const runId = Date.now().toString(36).slice(-7)
    state = {
      schema: 1,
      network: config.network,
      rpc: getRpcUrl(),
      contract,
      deployer: config.deployer,
      runId,
      registerCount: REGISTER_COUNT,
      listCount: LIST_COUNT,
      registrationPrice,
      labels: makeLabels(runId, REGISTER_COUNT),
      registered: {},
      listed: {},
      baseline: {
        totalNames: await viewInt(contract, 'get_total_names'),
        ownerTotal: await viewInt(contract, 'owner_total', [config.deployer]),
        listingTotal: await viewInt(contract, 'listing_total'),
      },
      createdAt: new Date().toISOString(),
    }
    saveState(stateFile, state)
  }

  const labels = state.labels
  const listedLabels = labels.slice(0, LIST_COUNT)
  const isRegistered = async (label) => String(await view(contract, 'owner_of', [label])) === config.deployer
  const isListed = async (label) => {
    const seller = String(await view(contract, 'listing_seller_of', [label]))
    const price = await viewInt(contract, 'listing_price_of', [label])
    return seller === config.deployer && price > 0
  }

  console.log('--- ONS advanced stress test ---')
  console.log(`network      ${config.network}`)
  console.log(`rpc          ${getRpcUrl()}`)
  console.log(`contract     ${contract}`)
  console.log(`run          ${state.runId}`)
  console.log(`register     ${REGISTER_COUNT}`)
  console.log(`list         ${LIST_COUNT}`)
  console.log(`batch        ${BATCH_SIZE}`)
  console.log(`price/year   ${registrationPrice}`)
  console.log(`est. cost    ${estimatedCost}`)
  console.log(`checkpoint   ${path.relative(process.cwd(), stateFile)}`)

  await submitPhase({
    phase: 'registered',
    labels,
    state,
    stateFile,
    config,
    contract,
    keypair,
    predicate: isRegistered,
    build: (label) => ({
      method: 'register_name',
      params: [label, config.deployer, 1],
      amount: registrationPrice,
    }),
  })

  await submitPhase({
    phase: 'listed',
    labels: listedLabels,
    state,
    stateFile,
    config,
    contract,
    keypair,
    predicate: isListed,
    build: (label, index) => ({
      method: 'list_name',
      params: [label, LIST_PRICE_BASE + index],
      amount: 0,
    }),
  })

  const ownerPage = await collectPages(contract, 'get_owner_page', [config.deployer])
  const listingPage = await collectPages(contract, 'get_listing_page', [])
  const ownerLabels = new Set(ownerPage.rows.map((row) => row[0]))
  const marketLabels = new Set(listingPage.rows.filter((row) => Number(row[2]) > 0).map((row) => row[0]))
  const missingOwned = labels.filter((label) => !ownerLabels.has(label))
  const missingListed = listedLabels.filter((label) => !marketLabels.has(label))
  const totalNames = await viewInt(contract, 'get_total_names')
  const listingTotal = await viewInt(contract, 'listing_total')

  if (missingOwned.length > 0) throw new Error(`owner snapshot missing ${missingOwned.length} stress names`)
  if (missingListed.length > 0) throw new Error(`listing snapshot missing ${missingListed.length} stress names`)
  if (totalNames < state.baseline.totalNames + REGISTER_COUNT) {
    throw new Error(`total_names ${totalNames} < expected ${state.baseline.totalNames + REGISTER_COUNT}`)
  }
  if (listingTotal < state.baseline.listingTotal + LIST_COUNT) {
    throw new Error(`listing_total ${listingTotal} < expected ${state.baseline.listingTotal + LIST_COUNT}`)
  }

  state.completedAt = new Date().toISOString()
  state.result = {
    totalNames,
    ownerTotal: ownerPage.total,
    listingTotal,
    verifiedOwned: labels.length,
    verifiedListed: listedLabels.length,
  }
  saveState(stateFile, state)

  console.log('--- verified ---')
  console.log(`total_names   ${totalNames}`)
  console.log(`owner_total   ${ownerPage.total}`)
  console.log(`listing_total ${listingTotal}`)
  console.log(`owned         ${labels.length}/${labels.length}`)
  console.log(`listed        ${listedLabels.length}/${listedLabels.length}`)
})().catch((err) => {
  console.error('stress error:', err.message)
  if (process.env.AML_DEBUG === '1' && err.stack) console.error(err.stack)
  process.exit(1)
})
