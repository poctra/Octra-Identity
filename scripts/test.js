// Smoke test for the deployed AML contract.
//
// This is a *generic* harness — it does not know which methods the contract
// exposes. It calls every view function in the ABI with no arguments and
// reports the result, so you can confirm the contract is alive and the ABI
// matches what the chain serves.
//
// For per-contract logic tests, drop a file at:
//
//   scripts/tests/<contract_name>.js
//
// exporting `module.exports = async ({ aml, rpc, config, deployment, contract }) => { ... }`
// and this runner will execute it after the smoke pass.

const fs   = require('node:fs')
const path = require('node:path')

const { rpc, setRpcUrl, getRpcUrl } = require('./lib/rpc')
const aml = require('./lib/aml')
const { buildConfig, buildDir, readDeployment, ROOT } = require('./lib/env')

function banner(title) {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`)
}

const results = []
function ok(name, extra = '')   { results.push({ name, status: 'pass', extra }); console.log(`  ✔ ${name}${extra ? '  — ' + extra : ''}`) }
function fail(name, err)        { results.push({ name, status: 'fail', error: err.message }); console.log(`  ✘ ${name}  — ${err.message}`) }

async function run(name, fn) {
  try {
    const extra = await fn()
    ok(name, extra ?? '')
  } catch (err) {
    fail(name, err)
  }
}

function loadAbi(contractName) {
  const abiPath = path.join(buildDir(contractName), 'abi.json')
  if (!fs.existsSync(abiPath)) {
    throw new Error(`abi not found: ${abiPath} (run compile first)`)
  }
  const raw = JSON.parse(fs.readFileSync(abiPath, 'utf8'))
  if (Array.isArray(raw)) return { functions: raw, events: [] }
  return {
    functions: raw?.functions ?? [],
    events:    raw?.events    ?? [],
  }
}

function isViewMethod(fn) {
  if (typeof fn === 'string') return false
  return Boolean(fn.view ?? fn.is_view ?? fn.read_only ?? fn.constant)
}

function methodName(fn) {
  return typeof fn === 'string' ? fn : (fn.name ?? fn.method ?? '')
}

function methodParams(fn) {
  if (typeof fn === 'string') return []
  return fn.params ?? fn.inputs ?? fn.args ?? []
}

async function smokeViewCalls({ contract, abi }) {
  banner('view smoke pass (zero-arg only)')
  const zeroArg = abi.functions.filter((f) => isViewMethod(f) && methodParams(f).length === 0)

  if (zeroArg.length === 0) {
    console.log('  (no zero-arg view methods to call)')
    return
  }

  for (const fn of zeroArg) {
    const name = methodName(fn)
    if (!name) continue
    await run(`view ${name}()`, async () => {
      const res = await rpc('contract_call', [contract, name, []])
      const v = (res && typeof res === 'object' && 'result' in res) ? res.result : res
      const display = v == null
        ? 'null'
        : typeof v === 'string' ? (v.length > 64 ? v.slice(0, 64) + '…' : v) : JSON.stringify(v)
      return display
    })
  }
}

async function runCustomSuite(ctx) {
  const candidates = [
    path.join(ROOT, 'scripts', 'tests', `${ctx.config.contractName}.js`),
    path.join(ROOT, 'scripts', 'tests', `${ctx.config.contractName}.test.js`),
  ]
  const suitePath = candidates.find((p) => fs.existsSync(p))
  if (!suitePath) return false

  banner(`custom suite — ${path.relative(ROOT, suitePath).split(path.sep).join('/')}`)
  const suite = require(suitePath)
  const fn = typeof suite === 'function' ? suite : suite?.default
  if (typeof fn !== 'function') {
    console.log('  (suite did not export a function — skipping)')
    return false
  }
  await fn(ctx)
  return true
}

;(async () => {
  const { config, missing } = buildConfig()
  if (missing.length) {
    console.error(`missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }
  setRpcUrl(config.rpcUrl)

  const deployment = readDeployment(config.contractName, config.network)
  if (!deployment) {
    throw new Error(`deployment not found for contract=${config.contractName} network=${config.network}. run deploy.js first.`)
  }

  const contract = deployment.address
  const keypair  = aml.keyPairFromBase64(config.privKey)
  const abi      = loadAbi(config.contractName)

  console.log('─── aml test runner ─────────────────────────────')
  console.log(`network     ${config.network}`)
  console.log(`rpc         ${getRpcUrl()}`)
  console.log(`contract    ${config.contractName}`)
  console.log(`address     ${contract}`)
  console.log(`deployer    ${config.deployer}`)
  console.log(`abi fns     ${abi.functions.length}  events ${abi.events.length}`)

  await smokeViewCalls({ contract, abi })

  const ran = await runCustomSuite({
    aml,
    rpc,
    config,
    deployment,
    contract,
    abi,
    keypair,
    helpers: { run, ok, fail, banner },
  })
  if (!ran) {
    console.log(`\n  (no custom suite at scripts/tests/${config.contractName}.js — smoke only)`)
  }

  banner('summary')
  const pass = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail')
  console.log(`pass: ${pass} / ${results.length}`)
  if (failed.length) {
    console.log(`fail: ${failed.length}`)
    for (const f of failed) console.log(`  ✘ ${f.name} — ${f.error}`)
    process.exit(1)
  } else {
    console.log('all tests passed')
  }
})().catch((err) => {
  console.error('test error:', err.message)
  if (err.stack && process.env.AML_DEBUG === '1') console.error(err.stack)
  process.exit(1)
})
