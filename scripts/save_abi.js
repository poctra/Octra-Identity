// Publish the compiled ABI to the node via contract_saveAbi for the
// network selected by .env / AML_NETWORK.

const fs   = require('node:fs')
const path = require('node:path')

const { rpc, setRpcUrl, getRpcUrl } = require('./lib/rpc')
const { buildConfig, buildDir, readDeployment } = require('./lib/env')

function log(label, value) {
  console.log(`${label.padEnd(18)} ${value}`)
}

;(async () => {
  const { config } = buildConfig()
  setRpcUrl(config.rpcUrl)

  const abiPath = path.join(buildDir(config.contractName), 'abi.json')
  if (!fs.existsSync(abiPath)) {
    throw new Error(`abi not found: ${abiPath} (run compile first)`)
  }

  const deployment = readDeployment(config.contractName, config.network)
  if (!deployment) {
    throw new Error(`deployment record not found for contract=${config.contractName} network=${config.network}. run deploy.js first.`)
  }

  const abiRaw = fs.readFileSync(abiPath, 'utf8')
  let abi
  try {
    abi = JSON.parse(abiRaw)
  } catch {
    throw new Error(`abi not valid JSON: ${abiPath}`)
  }

  const fnCount = Array.isArray(abi) ? abi.length : (abi?.functions?.length ?? 0)

  console.log('─── save abi ────────────────────────────────────')
  log('network',  config.network)
  log('rpc',      getRpcUrl())
  log('contract', config.contractName)
  log('address',  deployment.address)
  log('methods',  String(fnCount))

  const abiString = typeof abi === 'string' ? abi : JSON.stringify(abi)
  const result = await rpc('contract_saveAbi', [deployment.address, abiString])
  log('result', typeof result === 'string' ? result : JSON.stringify(result).slice(0, 200))

  const stored = await rpc('octra_contractAbi', [deployment.address])
  let storedCount = 0
  const inner = stored?.abi ?? stored
  if (Array.isArray(inner)) storedCount = inner.length
  else if (inner?.functions) storedCount = inner.functions.length
  else if (typeof inner === 'string') {
    try {
      const p = JSON.parse(inner)
      storedCount = p.functions?.length ?? (Array.isArray(p) ? p.length : 0)
    } catch { /* ignore */ }
  }
  log('stored_methods', String(storedCount))

  console.log('─── done ────────────────────────────────────────')
})().catch((err) => {
  console.error('save_abi error:', err.message)
  process.exit(1)
})
