// Deploy the compiled AML contract to the configured network.
//
// Reads bytecode from build/<contract>/bytecode.b64 (run compile.js first).
// Constructor params come from AML_CONSTRUCTOR_ARGS (JSON array). Defaults
// to [] for parameter-less constructors.
//
// Deployment metadata is written to build/<contract>/deployment.<network>.json
// so devnet and mainnet artifacts coexist cleanly.

const fs   = require('node:fs')
const path = require('node:path')

const { rpc, setRpcUrl, getRpcUrl } = require('./lib/rpc')
const aml = require('./lib/aml')
const { buildConfig, buildDir, deploymentPath } = require('./lib/env')

function log(label, value) {
  console.log(`${label.padEnd(18)} ${value}`)
}

function unwrapView(value) {
  return value && typeof value === 'object' && 'result' in value ? value.result : value
}

async function readViewWithRetry(address, method, params = []) {
  let lastError
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return unwrapView(await rpc('contract_call', [address, method, params]))
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  throw lastError ?? new Error(`unable to read ${method}`)
}

async function assertConstructorState({ address, abiPath, deployer, constructorParams }) {
  if (!fs.existsSync(abiPath)) return
  const raw = JSON.parse(fs.readFileSync(abiPath, 'utf8'))
  const functions = Array.isArray(raw) ? raw : (raw?.functions ?? [])
  const names = new Set(functions.map((fn) => typeof fn === 'string' ? fn : fn?.name).filter(Boolean))

  if (names.has('get_owner')) {
    const owner = String(await readViewWithRetry(address, 'get_owner'))
    if (!owner || owner === '0') throw new Error('constructor sanity failed: owner is unset')
    if (owner !== deployer) throw new Error(`constructor sanity failed: owner ${owner} != deployer ${deployer}`)
    log('owner_check', owner)
  }

  if (names.has('get_price_per_year') && constructorParams.length > 0) {
    const price = Number(await readViewWithRetry(address, 'get_price_per_year'))
    if (price !== Number(constructorParams[0])) {
      throw new Error(`constructor sanity failed: price ${price} != ${constructorParams[0]}`)
    }
    log('price_check', String(price))
  }

  if (names.has('get_config_snapshot')) {
    const snapshot = String(await readViewWithRetry(address, 'get_config_snapshot'))
    if (!snapshot.startsWith('v1|')) throw new Error('constructor sanity failed: invalid config snapshot')
    log('snapshot_check', 'v1')
  }
}

;(async () => {
  const { config, missing } = buildConfig()
  if (missing.length) {
    console.error(`missing required env vars: ${missing.join(', ')}`)
    console.error(`set them in .env / .env.${config.network} or as shell overrides.`)
    process.exit(1)
  }
  setRpcUrl(config.rpcUrl)

  const outDir       = buildDir(config.contractName)
  const bytecodePath = path.join(outDir, 'bytecode.b64')

  if (!fs.existsSync(bytecodePath)) {
    console.error(`bytecode not found: ${bytecodePath}`)
    console.error(`run: npm run compile:${config.network}  (or set AML_CONTRACT first)`)
    process.exit(1)
  }
  const bytecodeB64 = fs.readFileSync(bytecodePath, 'utf8').trim()

  const keypair = aml.keyPairFromBase64(config.privKey)
  const constructorParams = config.constructorArgs ?? []

  console.log('─── deploy ──────────────────────────────────────')
  log('network',     config.network)
  log('rpc',         getRpcUrl())
  log('contract',    config.contractName)
  log('deployer',    config.deployer)
  log('bytecode',    `${bytecodeB64.length} b64 chars`)
  log('constructor', JSON.stringify(constructorParams))

  const account = await aml.getAccountState(config.deployer)
  log('nonce',         String(account.nonce))
  log('pending_nonce', String(account.pendingNonce))
  log('balance_raw',   String(account.balanceRaw))

  const nextNonce = account.pendingNonce + 1
  log('next_nonce', String(nextNonce))

  const addrResult = await rpc('octra_computeContractAddress',
    [bytecodeB64, config.deployer, nextNonce])
  const computedAddress = typeof addrResult === 'string' ? addrResult : addrResult.address
  log('predicted_addr', computedAddress)

  if (!computedAddress || !computedAddress.startsWith('oct')) {
    throw new Error(`unexpected address response: ${JSON.stringify(addrResult)}`)
  }

  const recommended = await aml.getRecommendedFee('deploy')
  const ou = Math.max(recommended, config.deployFeeOu)
  log('fee_ou', `${ou} (recommended ${recommended})`)

  if (account.balanceRaw < ou) {
    throw new Error(`insufficient balance: ${account.balanceRaw} < ${ou}`)
  }

  const deployTx = aml.buildDeployTx({
    deployer:        config.deployer,
    computedAddress,
    bytecodeB64,
    constructorParams,
    nonce:           nextNonce,
    ou,
    keypair,
  })

  console.log('─── submit ──────────────────────────────────────')
  const hash = await aml.submitTx(deployTx)
  log('hash', hash)
  log('explorer', `${config.explorerHost}/tx.html?hash=${hash}`)

  console.log('─── wait ────────────────────────────────────────')
  const { tx, receipt } = await aml.waitForTx(hash, { timeoutMs: 240_000 })
  log('status', tx.status ?? 'confirmed')
  log('epoch',  String(tx.epoch_id ?? tx.epoch ?? '?'))
  if (receipt) {
    log('success', String(receipt.success))
    log('effort',  String(receipt.effort ?? '?'))
    log('events',  String((receipt.events ?? []).length))
  }

  await assertConstructorState({
    address: computedAddress,
    abiPath: path.join(outDir, 'abi.json'),
    deployer: config.deployer,
    constructorParams,
  })

  const deployment = {
    contract:          config.contractName,
    address:           computedAddress,
    deployer:          config.deployer,
    deployTxHash:      hash,
    epoch:             tx.epoch_id ?? tx.epoch ?? null,
    nonce:             nextNonce,
    constructorParams,
    rpc:               config.rpcUrl,
    network:           config.network,
    deployedAt:        new Date().toISOString(),
  }

  const outPath = deploymentPath(config.contractName, config.network)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2))

  console.log('─── done ────────────────────────────────────────')
  log('address', computedAddress)
  log('saved',   path.relative(process.cwd(), outPath))
  log('explorer', `${config.explorerHost}/address.html?addr=${computedAddress}`)
})().catch((err) => {
  console.error('deploy error:', err.message)
  if (err.stack && process.env.AML_DEBUG === '1') console.error(err.stack)
  process.exit(1)
})
