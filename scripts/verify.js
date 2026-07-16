// Submit the AML source for on-chain verification via contract_verify
// against the network selected by .env / AML_NETWORK.

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

  if (!config.contractExists) {
    throw new Error(`source not found: ${config.contractPath}`)
  }

  const deployment = readDeployment(config.contractName, config.network)
  if (!deployment) {
    throw new Error(`deployment record not found for contract=${config.contractName} network=${config.network}. run deploy.js first.`)
  }

  const source = fs.readFileSync(config.contractPath, 'utf8')

  console.log('─── verify ──────────────────────────────────────')
  log('network',  config.network)
  log('rpc',      getRpcUrl())
  log('contract', config.contractName)
  log('address',  deployment.address)
  log('src_len',  String(source.length))

  const result = await rpc('contract_verify', [deployment.address, source])
  log('result', typeof result === 'string' ? result : JSON.stringify(result).slice(0, 300))
  if (result?.verification) {
    const v = result.verification
    const safety = v.safety ?? (v.errors > 0 ? 'error' : 'safe')
    log('formal', `${safety} (errors ${v.errors ?? 0}, warnings ${v.warnings ?? 0})`)
  }

  try {
    const fetched = await rpc('contract_source', [deployment.address])
    const got = typeof fetched === 'string' ? fetched : (fetched?.source ?? '')
    log('source_stored', got.length ? `${got.length} chars` : 'none')
  } catch (err) {
    log('source_stored', `read failed: ${err.message}`)
  }

  const outPath = path.join(buildDir(config.contractName), `verification.${config.network}.json`)
  fs.writeFileSync(outPath, JSON.stringify({
    contract: config.contractName,
    address: deployment.address,
    network: config.network,
    verifiedAt: new Date().toISOString(),
    result,
  }, null, 2))
  log('saved', path.relative(process.cwd(), outPath))

  console.log('─── done ────────────────────────────────────────')
})().catch((err) => {
  console.error('verify error:', err.message)
  process.exit(1)
})
