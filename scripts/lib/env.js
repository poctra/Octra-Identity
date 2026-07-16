// Dependency-free env loader for the aml-workspace script suite.
//
// Resolution order (first match wins per key):
//
//   1. process.env                     — explicit shell override
//   2. <root>/.env.<network>           — per-network file (e.g. .env.mainnet)
//   3. <root>/.env                     — defaults shared across networks
//
// The target network itself comes from (first match wins):
//
//   1. process.env.AML_NETWORK
//   2. `AML_NETWORK=` inside .env.<network>
//   3. `AML_NETWORK=` inside .env
//   4. literal 'devnet'
//
// Supports legacy ONS_*-style keys as fallbacks so a deployer used to ONS can
// drop env files in place. AML_* takes precedence when both exist.

const fs   = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

function parseDotenv(text) {
  const out = {}
  if (!text) return out
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function readDotenv(name) {
  const file = path.join(ROOT, name)
  if (!fs.existsSync(file)) return {}
  try {
    return parseDotenv(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function readWalletDeployer() {
  const file = path.join(ROOT, 'wallet_deployer.txt')
  if (!fs.existsSync(file)) return {}
  try {
    const text = fs.readFileSync(file, 'utf8')
    const out = {}
    const keyMatch = text.match(/key\s+B64\s*:\s*([^\r\n]+)/i)
    const addrMatch = text.match(/address\s*:\s*([^\s\r\n]+)/i)
    if (keyMatch) out.AML_DEPLOYER_PRIV = keyMatch[1].trim()
    if (addrMatch) out.AML_DEPLOYER_ADDR = addrMatch[1].trim()
    return out
  } catch {
    return {}
  }
}

function resolveNetwork(envFromBase) {
  const explicit = process.env.AML_NETWORK || process.env.OCTRA_NETWORK
  if (explicit) return String(explicit).trim().toLowerCase()
  const fromFile = envFromBase.AML_NETWORK || envFromBase.OCTRA_NETWORK
  if (fromFile) return String(fromFile).trim().toLowerCase()
  return 'devnet'
}

function loadEnv() {
  const baseEnv    = readDotenv('.env')
  const network    = resolveNetwork(baseEnv)
  const perNetwork = readDotenv(`.env.${network}`)

  const walletEnv = readWalletDeployer()
  const merged = { ...walletEnv, ...baseEnv, ...perNetwork }
  for (const key of Object.keys(merged)) {
    if (process.env[key] != null && process.env[key] !== '') {
      merged[key] = process.env[key]
    }
  }
  for (const key of Object.keys(process.env)) {
    if ((key.startsWith('AML_') || key.startsWith('OCTRA_')) && merged[key] === undefined) {
      merged[key] = process.env[key]
    }
  }

  merged.AML_NETWORK = network
  return merged
}

const DEFAULT_RPC = {
  devnet:  'http://165.227.225.79:8080',
  mainnet: 'http://46.101.86.250:8080',
}

const DEFAULT_EXPLORER = {
  devnet:  'https://devnet.octrascan.io',
  mainnet: 'https://octrascan.io',
}

function pick(env, ...keys) {
  for (const key of keys) {
    if (env[key] != null && env[key] !== '') return env[key]
  }
  return ''
}

function toNumber(raw, fallback) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function parseJsonArray(raw, label) {
  if (raw == null || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed
  } catch (err) {
    throw new Error(`${label} is not a valid JSON array: ${err.message}`)
  }
}

function resolveContractPath(env) {
  const explicit = pick(env, 'AML_CONTRACT', 'OCTRA_CONTRACT')
  const candidate = explicit && explicit.length > 0
    ? path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit)
    : path.join(ROOT, 'contract', 'main.aml')

  if (!fs.existsSync(candidate)) {
    return { contractPath: candidate, exists: false }
  }
  return { contractPath: candidate, exists: true }
}

// Build a stable artifact-namespace for the contract.
//
//   AML_CONTRACT_NAME=foo                           → "foo"
//   contract/main.aml                               → "main"
//   contract/templates/token/main.aml               → "token"
//   contract/templates/private_ml/main.aml          → "private_ml"
//   contract/my_contract.aml                        → "my_contract"
//
// If the file basename is generic ("main", "index", "contract"), we fall
// back to the parent directory name to avoid colliding artifacts in
// build/<name>/ across templates.
function resolveContractName(env, contractPath) {
  const explicit = pick(env, 'AML_CONTRACT_NAME', 'OCTRA_CONTRACT_NAME')
  if (explicit) return explicit

  const base   = path.basename(contractPath, path.extname(contractPath))
  const parent = path.basename(path.dirname(contractPath))
  const generic = new Set(['main', 'index', 'contract'])

  if (generic.has(base.toLowerCase()) && parent && parent !== '.' && parent !== 'contract') {
    return parent
  }
  return base
}

function buildConfig() {
  const env = loadEnv()
  const network = env.AML_NETWORK === 'mainnet' ? 'mainnet' : 'devnet'

  const { contractPath, exists } = resolveContractPath(env)
  const contractName = resolveContractName(env, contractPath)

  const config = {
    network,
    rpcUrl:           pick(env, 'AML_RPC',      'OCTRA_RPC',      'ONS_RPC')      || DEFAULT_RPC[network],
    explorerHost:     pick(env, 'AML_EXPLORER', 'OCTRA_EXPLORER', 'ONS_EXPLORER') || DEFAULT_EXPLORER[network],
    deployer:         pick(env, 'AML_DEPLOYER_ADDR', 'OCTRA_DEPLOYER_ADDR', 'ONS_DEPLOYER_ADDR'),
    privKey:          pick(env, 'AML_DEPLOYER_PRIV', 'OCTRA_DEPLOYER_PRIV', 'ONS_DEPLOYER_PRIV'),
    contractPath,
    contractExists:   exists,
    contractName,
    constructorArgs:  parseJsonArray(pick(env, 'AML_CONSTRUCTOR_ARGS', 'OCTRA_CONSTRUCTOR_ARGS'), 'AML_CONSTRUCTOR_ARGS'),
    deployFeeOu:      toNumber(pick(env, 'AML_DEPLOY_FEE_OU', 'OCTRA_DEPLOY_FEE_OU', 'ONS_DEPLOY_FEE_OU'), 200_000),
    callFeeOu:        toNumber(pick(env, 'AML_CALL_FEE_OU',   'OCTRA_CALL_FEE_OU',   'ONS_CALL_FEE_OU'),   1_000),
  }

  const missing = []
  if (!config.deployer) missing.push('AML_DEPLOYER_ADDR')
  if (!config.privKey)  missing.push('AML_DEPLOYER_PRIV')

  return { config, env, missing }
}

function buildDir(contractName) {
  return path.join(ROOT, 'build', contractName)
}

function deploymentPath(contractName, network) {
  return path.join(buildDir(contractName), `deployment.${network}.json`)
}

function readDeployment(contractName, network) {
  const primary = deploymentPath(contractName, network)
  if (fs.existsSync(primary)) {
    return JSON.parse(fs.readFileSync(primary, 'utf8'))
  }
  // Legacy fallback for early scaffolds.
  const legacy = path.join(buildDir(contractName), 'deployment.json')
  if (fs.existsSync(legacy)) {
    return JSON.parse(fs.readFileSync(legacy, 'utf8'))
  }
  return null
}

module.exports = {
  loadEnv,
  buildConfig,
  buildDir,
  deploymentPath,
  readDeployment,
  ROOT,
}
