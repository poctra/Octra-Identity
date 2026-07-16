// Minimal JSON-RPC 2.0 client for Octra nodes.
//
// Canonicalizes parameters as a positional array. Logs request/response
// when AML_DEBUG=1 is set in the environment.

const DEBUG = process.env.AML_DEBUG === '1'

let _rpcUrl = 'http://165.227.225.79:8080'

function setRpcUrl(url) {
  _rpcUrl = String(url || '').replace(/\/+$/, '')
}

function getRpcUrl() {
  return _rpcUrl
}

let _id = 1

async function rpc(method, params = []) {
  const body = {
    jsonrpc: '2.0',
    id:      _id++,
    method,
    params,
  }

  if (DEBUG) {
    const preview = JSON.stringify(params).slice(0, 200)
    console.error('[rpc →]', method, preview)
  }

  const res = await fetch(`${_rpcUrl}/rpc`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)

  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON response: ${text.slice(0, 300)}`)
  }

  if (DEBUG) {
    const preview = JSON.stringify(json.result ?? json.error ?? json).slice(0, 200)
    console.error('[rpc ←]', preview)
  }

  if (json.error) {
    const msg = json.error.message || json.error.reason || JSON.stringify(json.error)
    throw new Error(`RPC error [${method}]: ${msg}`)
  }

  return json.result
}

module.exports = { rpc, setRpcUrl, getRpcUrl }
