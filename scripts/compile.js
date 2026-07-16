// Compile an AML contract via octra_compileAml.
//
// Source defaults to contract/main.aml. Override via AML_CONTRACT (relative
// or absolute path) or `AML_CONTRACT=contract/templates/token/main.aml ...`.
//
// Writes per-contract artifacts to build/<contract_basename>/:
//   bytecode.b64   — base64 OCTB bytecode
//   abi.json       — ABI (functions + events)
//   compile.json   — full compile metadata incl. disassembly

const fs   = require('node:fs')
const path = require('node:path')

const { rpc, setRpcUrl, getRpcUrl } = require('./lib/rpc')
const { buildConfig, buildDir }     = require('./lib/env')

function log(label, value) {
  console.log(`${label.padEnd(18)} ${value}`)
}

;(async () => {
  const { config } = buildConfig()
  setRpcUrl(config.rpcUrl)

  if (!config.contractExists) {
    console.error(`source not found: ${config.contractPath}`)
    console.error('set AML_CONTRACT to point at a different .aml file, or copy a template into contract/main.aml')
    process.exit(1)
  }

  const source = fs.readFileSync(config.contractPath, 'utf8')

  console.log('─── compile ─────────────────────────────────────')
  log('network',  config.network)
  log('rpc',      getRpcUrl())
  log('source',   path.relative(process.cwd(), config.contractPath))
  log('contract', config.contractName)
  log('size',     `${source.length} chars`)

  const result = await rpc('octra_compileAml', [source])

  if (!result || !result.bytecode) {
    console.error('compile failed: no bytecode returned')
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }

  let abi = result.abi
  if (typeof abi === 'string') {
    try { abi = JSON.parse(abi) } catch { /* keep as string */ }
  }
  const fnCount = Array.isArray(abi)
    ? abi.length
    : (abi?.functions?.length ?? 0)
  const evCount = Array.isArray(abi) ? 0 : (abi?.events?.length ?? 0)

  const outDir       = buildDir(config.contractName)
  const bytecodeOut  = path.join(outDir, 'bytecode.b64')
  const abiOut       = path.join(outDir, 'abi.json')
  const compileOut   = path.join(outDir, 'compile.json')

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(bytecodeOut, result.bytecode)
  fs.writeFileSync(abiOut,      JSON.stringify(abi ?? [], null, 2))
  fs.writeFileSync(compileOut,  JSON.stringify({
    contract:          config.contractName,
    source:            path.relative(outDir, config.contractPath).split(path.sep).join('/'),
    size:              result.size,
    instruction_count: result.instruction_count ?? result.instructions,
    version:           result.version,
    abi,
    disassembly:       result.disassembly,
    verification:      result.verification,
    certificate:       result.certificate,
  }, null, 2))

  console.log('─── result ──────────────────────────────────────')
  log('bytecode',  `${path.relative(process.cwd(), bytecodeOut)} (${result.bytecode.length} b64 chars)`)
  log('size',      `${result.size ?? '?'} bytes`)
  log('instr',     String(result.instruction_count ?? result.instructions ?? '?'))
  log('functions', String(fnCount))
  log('events',    String(evCount))
  log('version',   result.version ?? 'unknown')
  if (result.verification) {
    const safety = result.verification.safety ?? (result.verification.errors > 0 ? 'error' : 'safe')
    log('formal', `${safety} (errors ${result.verification.errors ?? 0}, warnings ${result.verification.warnings ?? 0})`)
  }

  if (fnCount === 0) {
    console.warn('warning: no functions in ABI — check compiler response')
  }
})().catch((err) => {
  console.error('compile error:', err.message)
  process.exit(1)
})
