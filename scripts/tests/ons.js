const ZERO = '0'

module.exports = async ({ aml, rpc, config, contract, abi, keypair, helpers }) => {
  const { run, banner } = helpers
  const DEPLOYER = config.deployer
  const PRICE = Number(config.constructorArgs?.[0] ?? 500000)
  const FEE_BPS = 250
  const GRACE = Number(config.constructorArgs?.[1] ?? 259200)

  async function send(method, params, amount = 0) {
    const account = await aml.getAccountState(DEPLOYER)
    const fee = await aml.getRecommendedFee('call')
    const tx = aml.buildCallTx({
      caller: DEPLOYER,
      contract,
      method,
      params,
      amount,
      nonce: account.pendingNonce + 1,
      ou: Math.max(fee, config.callFeeOu),
      keypair,
    })
    const hash = await aml.submitTx(tx)
    return aml.waitForTx(hash, { timeoutMs: 180000 })
  }

  async function expectRevert(method, params, amount = 0, matcher = null) {
    try {
      await send(method, params, amount)
      throw new Error('expected revert, got success')
    } catch (err) {
      const msg = String(err.message || '')
      if (!/revert|rejected/i.test(msg)) {
        throw new Error(`expected revert, got other error: ${msg}`)
      }
      if (matcher && !matcher.test(msg)) {
        throw new Error(`revert message did not match ${matcher}: ${msg}`)
      }
      return 'reverted as expected'
    }
  }

  async function view(method, params = []) {
    const r = await rpc('contract_call', [contract, method, params])
    return r && typeof r === 'object' && 'result' in r ? r.result : r
  }

  async function viewInt(method, params = []) {
    const v = await view(method, params)
    return typeof v === 'number' ? v : parseInt(v, 10)
  }

  async function viewBool(method, params = []) {
    const v = await view(method, params)
    return v === true || v === 'true' || v === '1'
  }

  function snapshot(payload, expectedHeaderSize) {
    const [rawHeader, ...rawRows] = String(payload).split('#')
    const header = rawHeader.split('|')
    if (header[0] !== 'v1') throw new Error(`snapshot schema ${header[0]} != v1`)
    if (header.length !== expectedHeaderSize) {
      throw new Error(`snapshot header fields ${header.length} != ${expectedHeaderSize}`)
    }
    return { header, rows: rawRows.filter(Boolean).map((row) => row.split('|')) }
  }

  function expectIncrease(after, before, label) {
    if (!Number.isSafeInteger(after) || after <= before) {
      throw new Error(`${label} did not increase: ${before} -> ${after}`)
    }
  }

  function methodByName(name) {
    const fns = Array.isArray(abi) ? abi : (abi.functions ?? [])
    return fns.find((fn) => (typeof fn === 'string' ? fn : (fn.name ?? fn.method)) === name)
  }

  function methodParams(fn) {
    if (!fn || typeof fn === 'string') return []
    return fn.params ?? fn.inputs ?? fn.args ?? []
  }

  function uniqueLabel(prefix) {
    return `${prefix}${Date.now().toString(36).slice(-8)}`
  }

  banner('ons abi')
  await run('name_view_pk surface removed', async () => {
    if (methodByName('view_pk_of')) throw new Error('view_pk_of still present')
    if (methodByName('update_view_pk')) throw new Error('update_view_pk still present')
    const registerParams = methodParams(methodByName('register_name'))
    const buyParams = methodParams(methodByName('buy_name'))
    if (registerParams.length !== 3) throw new Error(`register_name params ${registerParams.length} != 3`)
    if (buyParams.length !== 2) throw new Error(`buy_name params ${buyParams.length} != 2`)
    for (const method of [
      'set_record',
      'transfer_reserved_name',
      'set_sub_record',
      'release_subdomain',
      'resolve_name',
      'resolve_subdomain',
      'get_name_snapshot',
      'get_config_snapshot',
      'get_owner_page',
      'get_listing_page',
      'get_subdomain_page',
      'get_owner_version',
      'get_listing_version',
    ]) {
      if (!methodByName(method)) throw new Error(`${method} missing`)
    }
  })

  banner('meta')
  await run('get_owner == deployer', async () => {
    const owner = await view('get_owner')
    if (owner !== DEPLOYER) throw new Error(`owner mismatch: ${owner}`)
  })
  await run('constructor economics', async () => {
    const price = await viewInt('get_price_per_year')
    const fee = await viewInt('get_fee_bps')
    const grace = await viewInt('get_grace_epochs')
    if (price !== PRICE) throw new Error(`price ${price} != ${PRICE}`)
    if (fee !== FEE_BPS) throw new Error(`fee ${fee} != ${FEE_BPS}`)
    if (grace !== GRACE) throw new Error(`grace ${grace} != ${GRACE}`)
  })
  await run('config snapshot matches constructor state', async () => {
    const { header, rows } = snapshot(await view('get_config_snapshot'), 11)
    if (rows.length !== 0) throw new Error('config snapshot returned rows')
    if (header[2] !== DEPLOYER) throw new Error(`snapshot owner ${header[2]}`)
    if (Number(header[5]) !== PRICE) throw new Error(`snapshot price ${header[5]}`)
    if (Number(header[7]) !== GRACE) throw new Error(`snapshot grace ${header[7]}`)
  })
  await run('exact-name snapshot resolves root in one view', async () => {
    const { rows } = snapshot(await view('get_name_snapshot', ['root']), 4)
    if (rows.length !== 1 || rows[0].length !== 9) throw new Error('root snapshot shape mismatch')
    if (rows[0][0] !== 'root') throw new Error(`snapshot label ${rows[0][0]}`)
    if (rows[0][1] !== DEPLOYER || rows[0][2] !== DEPLOYER) throw new Error('root snapshot owner/destination mismatch')
    if (rows[0][8] !== '1') throw new Error('root snapshot not reserved')
  })
  await run('owner page is bounded and version guarded', async () => {
    const page = snapshot(await view('get_owner_page', [DEPLOYER, 0, 25, -1]), 7)
    const version = Number(page.header[1])
    const total = Number(page.header[3])
    if (page.rows.length > 25) throw new Error(`page returned ${page.rows.length} rows`)
    if (total < 7) throw new Error(`reserved owner total ${total} < 7`)
    const stale = String(await view('get_owner_page', [DEPLOYER, 0, 25, version + 1]))
    if (stale !== `stale|${version}`) throw new Error(`stale guard returned ${stale}`)
  })

  banner('label validation')
  await run('valid ascii labels accepted by view', async () => {
    for (const label of ['abc', 'octra123', 'lambda0xe', 'valid-name']) {
      if (!(await viewBool('is_valid_label', [label]))) throw new Error(`${label} invalid`)
    }
  })
  await run('invalid labels rejected by view', async () => {
    for (const label of ['ab', 'alice-', 'Alice', 'alex.', 'name_space']) {
      if (await viewBool('is_valid_label', [label])) throw new Error(`${label} valid unexpectedly`)
      if (await viewBool('is_available', [label])) throw new Error(`${label} available unexpectedly`)
    }
  })
  await run('register rejects special characters', async () => {
    return expectRevert('register_name', ['bad_name', DEPLOYER, 1], PRICE, /invalid label/i)
  })

  banner('registration')
  const label = uniqueLabel('ons')
  const updatedDest = 'oct7voWd6kADDiYdbCf4xFumSTXsMCsKK5eFqxzu5z8MyiE'
  const feesBeforeRegister = await viewInt('get_fees_collected')
  const ownerVersionBeforeRegister = await viewInt('get_owner_version', [DEPLOYER])
  const registryVersionBeforeRegister = Number(snapshot(await view('get_name_snapshot', ['root']), 4).header[1])
  const configVersionBeforeRegister = Number(snapshot(await view('get_config_snapshot'), 11).header[1])
  await run(`register ${label}`, async () => {
    await send('register_name', [label, DEPLOYER, 1], PRICE)
    const feesAfter = await viewInt('get_fees_collected')
    if (feesAfter !== feesBeforeRegister + PRICE) throw new Error(`registration revenue ${feesAfter}`)
    expectIncrease(await viewInt('get_owner_version', [DEPLOYER]), ownerVersionBeforeRegister, 'owner version')
    expectIncrease(Number(snapshot(await view('get_name_snapshot', ['root']), 4).header[1]), registryVersionBeforeRegister, 'registry version')
    expectIncrease(Number(snapshot(await view('get_config_snapshot'), 11).header[1]), configVersionBeforeRegister, 'config version')
  })
  await run('registered name is present in owner snapshot', async () => {
    const first = snapshot(await view('get_owner_page', [DEPLOYER, 0, 25, -1]), 7)
    const version = Number(first.header[1])
    const total = Number(first.header[3])
    const rows = [...first.rows]
    for (let cursor = Number(first.header[2]); cursor < total; cursor += 25) {
      rows.push(...snapshot(await view('get_owner_page', [DEPLOYER, cursor, 25, version]), 7).rows)
    }
    if (!rows.some((row) => row[0] === label)) throw new Error(`${label} missing from owner pages`)
  })
  await run('owner and resolve point to deployer', async () => {
    const owner = await view('owner_of', [label])
    const dest = await view('resolve', [label])
    if (owner !== DEPLOYER) throw new Error(`owner ${owner}`)
    if (dest !== DEPLOYER) throw new Error(`resolve ${dest}`)
  })
  await run('owner can update top-level resolver record', async () => {
    await send('set_record', [label, updatedDest])
    let dest = await view('resolve', [label])
    if (dest !== updatedDest) throw new Error(`updated resolver ${dest}`)
    await send('set_record', [label, DEPLOYER])
    dest = await view('resolve', [label])
    if (dest !== DEPLOYER) throw new Error(`restored resolver ${dest}`)
  })
  await run('root is deployer primary on deploy', async () => {
    const primary = await view('primary_of', [DEPLOYER])
    if (primary !== 'root') throw new Error(`primary ${primary} != root`)
  })
  await run('next registration keeps active primary', async () => {
    const nextLabel = uniqueLabel('pri')
    await send('register_name', [nextLabel, DEPLOYER, 1], PRICE)
    const primary = await view('primary_of', [DEPLOYER])
    if (primary !== 'root') throw new Error(`primary overwritten: ${primary}`)
    await send('release_name', [nextLabel])
  })
  await run('duplicate register reverts', async () => {
    return expectRevert('register_name', [label, DEPLOYER, 1], PRICE, /not available/i)
  })
  await run('wrong payment reverts', async () => {
    return expectRevert('register_name', [uniqueLabel('pay'), DEPLOYER, 1], PRICE - 1, /wrong payment/i)
  })

  banner('subdomains')
  const sub = uniqueLabel('sub')
  await run(`register ${sub}.${label}`, async () => {
    const versionBefore = Number(snapshot(await view('get_subdomain_page', [label, 0, 25, -1]), 7).header[1])
    await send('set_sub_record', [label, sub, DEPLOYER])
    const direct = await view('resolve_subdomain', [label, sub])
    const full = await view('resolve_name', [`${sub}.${label}`])
    const total = await viewInt('subdomain_total', [label])
    const key = await view('subdomain_key_at', [label, total - 1])
    if (direct !== DEPLOYER) throw new Error(`resolve_subdomain ${direct}`)
    if (full !== DEPLOYER) throw new Error(`resolve_name ${full}`)
    if (key !== sub) throw new Error(`subdomain key ${key}`)
    expectIncrease(Number(snapshot(await view('get_subdomain_page', [label, 0, 25, -1]), 7).header[1]), versionBefore, 'subdomain version')
    const page = snapshot(await view('get_subdomain_page', [label, 0, 25, -1]), 7)
    if (!page.rows.some((row) => row[0] === sub && row[1] === DEPLOYER)) {
      throw new Error('subdomain missing from snapshot page')
    }
  })
  await run('update subdomain destination', async () => {
    await send('set_sub_record', [label, sub, updatedDest])
    const direct = await view('resolve_subdomain', [label, sub])
    const full = await view('resolve_name', [`${sub}.${label}`])
    if (direct !== updatedDest) throw new Error(`updated direct ${direct}`)
    if (full !== updatedDest) throw new Error(`updated full ${full}`)
  })
  await run('release subdomain', async () => {
    await send('release_subdomain', [label, sub])
    const direct = await view('resolve_subdomain', [label, sub])
    const full = await view('resolve_name', [`${sub}.${label}`])
    if (direct !== ZERO) throw new Error(`released direct ${direct}`)
    if (full !== ZERO) throw new Error(`released full ${full}`)
  })
  await run('subdomain requires active parent owner', async () => {
    return expectRevert('set_sub_record', [uniqueLabel('free'), sub, DEPLOYER], 0, /not parent owner/i)
  })
  await run('subdomain enumeration resets on parent generation change', async () => {
    const parent = uniqueLabel('gen')
    const oldSub = uniqueLabel('old')
    const newSub = uniqueLabel('new')
    await send('register_name', [parent, DEPLOYER, 1], PRICE)
    await send('set_sub_record', [parent, oldSub, DEPLOYER])
    await send('release_name', [parent])
    await send('register_name', [parent, DEPLOYER, 1], PRICE)
    if (await viewInt('subdomain_total', [parent]) !== 0) throw new Error('stale subdomain count survived')
    if (await view('resolve_subdomain', [parent, oldSub]) !== ZERO) throw new Error('stale subdomain resolved')
    await send('set_sub_record', [parent, newSub, DEPLOYER])
    if (await viewInt('subdomain_total', [parent]) !== 1) throw new Error('new generation count mismatch')
    if (await view('subdomain_key_at', [parent, 0]) !== newSub) throw new Error('new generation key mismatch')
    await send('release_name', [parent])
  })

  banner('marketplace')
  await run('list and cancel public name', async () => {
    const beforeList = await viewInt('get_listing_version')
    await send('list_name', [label, PRICE * 2])
    const listed = await viewInt('listing_price_of', [label])
    if (listed !== PRICE * 2) throw new Error(`listing ${listed}`)
    const afterList = await viewInt('get_listing_version')
    expectIncrease(afterList, beforeList, 'listing version after list')
    const page = snapshot(await view('get_listing_page', [0, 25, -1]), 4)
    if (!page.rows.some((row) => row[0] === label && Number(row[2]) === PRICE * 2)) {
      throw new Error('listing missing from snapshot page')
    }
    await send('cancel_listing', [label])
    const after = await viewInt('listing_price_of', [label])
    if (after !== 0) throw new Error(`listing survived: ${after}`)
    expectIncrease(await viewInt('get_listing_version'), afterList, 'listing version after cancel')
  })
  await run('buy own name reverts', async () => {
    await send('list_name', [label, PRICE * 2])
    const result = await expectRevert('buy_name', [label, DEPLOYER], PRICE * 2, /cannot buy own/i)
    await send('cancel_listing', [label])
    return result
  })
  await run('release public test name', async () => {
    const owner = await view('owner_of', [label])
    if (owner === DEPLOYER) {
      const ownerBefore = await viewInt('get_owner_version', [DEPLOYER])
      const registryBefore = Number(snapshot(await view('get_name_snapshot', ['root']), 4).header[1])
      const configBefore = Number(snapshot(await view('get_config_snapshot'), 11).header[1])
      await send('release_name', [label])
      expectIncrease(await viewInt('get_owner_version', [DEPLOYER]), ownerBefore, 'owner version after release')
      expectIncrease(Number(snapshot(await view('get_name_snapshot', ['root']), 4).header[1]), registryBefore, 'registry version after release')
      expectIncrease(Number(snapshot(await view('get_config_snapshot'), 11).header[1]), configBefore, 'config version after release')
    }
  })

  banner('reserved names')
  await run('reserved views match configured list', async () => {
    for (const reserved of ['root', 'lambda', 'lambda0xe', 'bunch', 'alex', 'octra', 'poctra']) {
      if (!(await viewBool('is_reserved', [reserved]))) throw new Error(`${reserved} not reserved`)
    }
    if (await viewBool('is_reserved', ['publicname'])) throw new Error('publicname reserved unexpectedly')
  })
  await run('managed reserved names are owned by deployer on deploy', async () => {
    for (const reserved of ['root', 'alex', 'lambda', 'lambda0xe', 'bunch', 'octra', 'poctra']) {
      const owner = await view('owner_of', [reserved])
      const dest = await view('resolve', [reserved])
      if (owner !== DEPLOYER) throw new Error(`${reserved} owner ${owner}`)
      if (dest !== DEPLOYER) throw new Error(`${reserved} resolve ${dest}`)
    }
  })
  await run('admin can transfer managed reserved bunch and recover it', async () => {
    await send('transfer_reserved_name', ['bunch', updatedDest, updatedDest])
    let owner = await view('owner_of', ['bunch'])
    let dest = await view('resolve', ['bunch'])
    if (owner !== updatedDest) throw new Error(`bunch owner ${owner}`)
    if (dest !== updatedDest) throw new Error(`bunch resolve ${dest}`)

    await send('transfer_reserved_name', ['bunch', DEPLOYER, DEPLOYER])
    owner = await view('owner_of', ['bunch'])
    dest = await view('resolve', ['bunch'])
    if (owner !== DEPLOYER) throw new Error(`bunch recovered owner ${owner}`)
    if (dest !== DEPLOYER) throw new Error(`bunch recovered resolve ${dest}`)
  })
  await run('reserved alex cannot be listed', async () => {
    return expectRevert('list_name', ['alex', PRICE * 5], 0, /reserved name locked/i)
  })
  await run('reserved alex cannot be transferred through public flow', async () => {
    return expectRevert('transfer_name', ['alex', updatedDest], 0, /reserved name locked/i)
  })
  await run('reserved alex cannot be released through public flow', async () => {
    return expectRevert('release_name', ['alex'], 0, /reserved name locked/i)
  })
}
