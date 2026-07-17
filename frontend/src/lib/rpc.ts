// Minimal JSON-RPC 2.0 client for the Octra node.
// dApp-side reads go through this helper; write txs go through the OctWa SDK
// so the wallet can prompt the user.
//
// Hardening for the marketplace fan-out:
//   • Transient HTTP errors (429 / 502 / 503 / 504) get retried with
//     exponential backoff + jitter so a public RPC can shed load
//     without us surfacing a flat-out failure to the user.
//   • mapWithConcurrency() lets callers run a large number of view
//     calls without blasting the node — listings, owner indexes,
//     anything that fans out per-label.

import { DEFAULT_ONS_RPC, ONS_RPC } from './constants'

type JsonRpcResponse<T> =
  | { jsonrpc: '2.0'; id: number; result: T }
  | { jsonrpc: '2.0'; id: number; error: { code: number; message: string; reason?: string } }

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown[]
}

type PendingRpcRequest = {
  request: JsonRpcRequest
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface CircleRuntime {
  context?: {
    circle_id?: string
    path?: string
    uri?: string
  }
  request?: <T = unknown>(method: string, payload?: Record<string, unknown>) => Promise<T>
}

declare global {
  interface Window {
    OctraCircle?: CircleRuntime
    RPC_URL?: string
    OCTRA_RPC_URL?: string
  }
}

let rpcUrl = normalizeRpcBase(ONS_RPC)

export function setRpcUrl(url: string): void {
  rpcUrl = normalizeRpcBase(url)
}

export function getRpcUrl(): string {
  return rpcUrl
}

function normalizeRpcBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function runtimeRpcBase(): string {
  return normalizeRpcBase(window.RPC_URL || window.OCTRA_RPC_URL || '')
}

function isCircleRuntime(): boolean {
  return Boolean(
    window.OctraCircle?.context?.circle_id ||
      window.location.hostname === 'octra-circle.local' ||
      window.location.protocol === 'oct:',
  )
}

function ensureRpcEndpoint(url: string): string {
  const clean = normalizeRpcBase(url)
  return clean.endsWith('/rpc') ? clean : `${clean}/rpc`
}

function rpcEndpoint(): string {
  const runtimeRpc = runtimeRpcBase()
  if (runtimeRpc) return ensureRpcEndpoint(runtimeRpc)
  if (!rpcUrl && isCircleRuntime()) return ensureRpcEndpoint(DEFAULT_ONS_RPC)
  if (!rpcUrl) return '/rpc'
  return ensureRpcEndpoint(rpcUrl)
}

let nextId = 1

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_RETRIES    = 3
const BASE_DELAY_MS  = 180
const RPC_TIMEOUT_MS = Number(import.meta.env.VITE_ONS_RPC_TIMEOUT_MS ?? 14000)
const VIEW_CACHE_MS  = Number(import.meta.env.VITE_ONS_VIEW_CACHE_MS ?? 8000)
const VIEW_RPC_CONCURRENCY = Number(import.meta.env.VITE_ONS_VIEW_RPC_CONCURRENCY ?? 2)
const RPC_BATCH_WINDOW_MS = Number(import.meta.env.VITE_ONS_RPC_BATCH_MS ?? 12)
const RPC_BATCH_MAX_SIZE = Number(import.meta.env.VITE_ONS_RPC_BATCH_SIZE ?? 32)

const viewCache = new Map<string, { expires: number; promise: Promise<unknown> }>()
let activeViewRpc = 0
const viewRpcQueue: Array<() => void> = []
let pendingRpcBatch: PendingRpcRequest[] = []
let rpcBatchTimer = 0
let programViewUnsupported = false

class TransientRpcError extends Error {
  status: number
  constructor(status: number, message = transientMessage(status)) {
    super(message)
    this.status = status
  }
}

function transientMessage(status: number): string {
  if (status === 408) return 'RPC request timed out. Please try again.'
  if (status === 429) return 'RPC is rate limiting requests. Please try again.'
  if (status === 502 || status === 503 || status === 504) return 'RPC gateway is busy. Please try again.'
  return `rpc http ${status}`
}

function rpcOnce<T>(method: string, params: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pendingRpcBatch.push({
      request: { jsonrpc: '2.0', id: nextId++, method, params },
      resolve: (value) => resolve(value as T),
      reject,
    })

    if (pendingRpcBatch.length >= RPC_BATCH_MAX_SIZE) {
      flushRpcBatch()
    } else if (!rpcBatchTimer) {
      rpcBatchTimer = window.setTimeout(flushRpcBatch, Math.max(0, RPC_BATCH_WINDOW_MS))
    }
  })
}

function flushRpcBatch(): void {
  if (rpcBatchTimer) {
    window.clearTimeout(rpcBatchTimer)
    rpcBatchTimer = 0
  }
  const batch = pendingRpcBatch.splice(0, pendingRpcBatch.length)
  if (batch.length === 0) return
  void postRpcBatch(batch)
}

async function postRpcBatch(batch: PendingRpcRequest[]): Promise<void> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  let res: Response
  try {
    const body = batch.length === 1 ? batch[0].request : batch.map((entry) => entry.request)
    res = await fetch(rpcEndpoint(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    })
  } catch (err) {
    const nextError = (err as Error).name === 'AbortError'
      ? new TransientRpcError(408, 'rpc request timeout')
      : err
    batch.forEach((entry) => entry.reject(nextError))
    return
  } finally {
    window.clearTimeout(timeout)
  }
  if (!res.ok) {
    const error = TRANSIENT_HTTP.has(res.status) ? new TransientRpcError(res.status) : new Error(`rpc http ${res.status}`)
    batch.forEach((entry) => entry.reject(error))
    return
  }
  let json: JsonRpcResponse<unknown> | Array<JsonRpcResponse<unknown>>
  try {
    json = await res.json()
  } catch (err) {
    batch.forEach((entry) => entry.reject(err))
    return
  }
  const responses = Array.isArray(json) ? json : [json]
  const byId = new Map<number, JsonRpcResponse<unknown>>()
  responses.forEach((response) => byId.set(response.id, response))
  batch.forEach((entry) => {
    const response = byId.get(entry.request.id)
    if (!response) {
      entry.reject(new Error('rpc batch response missing'))
      return
    }
    if ('error' in response) {
      const error = new Error(response.error.message || response.error.reason || 'rpc error') as Error & { code?: number }
      error.code = response.error.code
      entry.reject(error)
      return
    }
    entry.resolve(response.result)
  })
}

function isProgramViewUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /method not found|not supported/i.test(message)
}

function isProgramViewFallbackError(err: unknown): boolean {
  if (isProgramViewUnsupportedError(err)) {
    programViewUnsupported = true
    return true
  }
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /bridge target override denied|native bridge is not available/i.test(message)
}

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await rpcOnce<T>(method, params)
    } catch (err) {
      lastErr = err
      if (err instanceof TransientRpcError && attempt < MAX_RETRIES) {
        // Exponential backoff with jitter — keeps concurrent retries
        // from re-stampeding the node in lockstep.
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 150
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('rpc retry exhausted')
}

/**
 * Map an array through an async function while keeping at most `limit`
 * promises in flight. Critical for view-call fan-out: lets us iterate a
 * marketplace or owner index without firing N parallel requests at the
 * node and tripping its 429 rate limit.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const width = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const worker = async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx], idx)
    }
  }

  await Promise.all(Array.from({ length: width }, worker))
  return results
}

// ─── Contract view helper ────────────────────────────────────────────────
// The node returns `{ result: <value>, storage: {...} }` for contract_call.
// We unwrap to the value directly.

export async function contractView<T = unknown>(
  contract: string,
  method:   string,
  params:   unknown[] = [],
): Promise<T> {
  const key = viewCacheKey(contract, method, params)
  const now = Date.now()
  const cached = viewCache.get(key)
  if (cached && cached.expires > now) return cached.promise as Promise<T>

  const promise = withViewRpcLimit(() => programView<T>(contract, method, params)).catch((err) => {
    viewCache.delete(key)
    throw err
  })

  viewCache.set(key, { expires: now + VIEW_CACHE_MS, promise })
  return promise
}

async function programView<T>(contract: string, method: string, params: unknown[]): Promise<T> {
  const circle = window.OctraCircle
  const contextCircle = circle?.context?.circle_id
  const targetsActiveCircle = Boolean(contextCircle && contextCircle === contract)

  // A Circle-hosted dApp can still read ordinary AML contracts. Sending those
  // addresses through a Circle program-view method produces `Not Found` on
  // gateways that correctly distinguish Circle programs from AML contracts.
  // Only the active Circle itself is eligible for the program-view transport;
  // external contracts always use the standard contract_call RPC.
  if (!targetsActiveCircle) {
    return unwrapViewResult<T>(await rpc('contract_call', [contract, method, params]))
  }

  if (circle?.request) {
    try {
      return unwrapViewResult<T>(await circle.request('program.view', { method, params }))
    } catch (err) {
      if (!isProgramViewFallbackError(err)) throw err
    }
  }

  if (!programViewUnsupported && (runtimeRpcBase() || isCircleRuntime())) {
    try {
      return unwrapViewResult<T>(await rpc('octra_callProgramView', [{
        address: contract,
        method,
        params,
      }]))
    } catch (err) {
      if (!isProgramViewFallbackError(err)) throw err
    }
  }

  return unwrapViewResult<T>(await rpc('contract_call', [contract, method, params]))
}

function unwrapViewResult<T>(res: unknown): T {
  if (res && typeof res === 'object' && 'result' in (res as Record<string, unknown>)) {
    return (res as { result: T }).result
  }
  return res as T
}

async function withViewRpcLimit<T>(task: () => Promise<T>): Promise<T> {
  const limit = Number.isFinite(VIEW_RPC_CONCURRENCY) && VIEW_RPC_CONCURRENCY > 0 ? VIEW_RPC_CONCURRENCY : 2
  if (activeViewRpc >= limit) {
    await new Promise<void>((resolve) => viewRpcQueue.push(resolve))
  }
  activeViewRpc += 1
  try {
    return await task()
  } finally {
    activeViewRpc = Math.max(0, activeViewRpc - 1)
    viewRpcQueue.shift()?.()
  }
}

export function clearContractViewCache(): void {
  viewCache.clear()
}

function viewCacheKey(contract: string, method: string, params: unknown[]): string {
  return JSON.stringify([contract, method, params])
}

// Typed view helpers — the node returns primitives as strings ("1", "true",
// "0" for unset addresses). Normalize here so component code stays clean.

export async function viewString(contract: string, method: string, params: unknown[] = []): Promise<string> {
  const v = await contractView<string>(contract, method, params)
  return typeof v === 'string' ? v : String(v ?? '')
}

export async function viewInt(contract: string, method: string, params: unknown[] = []): Promise<bigint> {
  const v = await contractView<string | number | bigint>(contract, method, params)
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  if (typeof v === 'string' && v.length > 0) {
    try { return BigInt(v) } catch { /* fall through */ }
  }
  return 0n
}

export async function viewBool(contract: string, method: string, params: unknown[] = []): Promise<boolean> {
  const v = await contractView<boolean | string | number>(contract, method, params)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v === 'true' || v === '1'
  return false
}

export async function viewAddress(contract: string, method: string, params: unknown[] = []): Promise<string> {
  const v = await viewString(contract, method, params)
  return v === '0' ? '' : v
}

// ─── Transaction read helpers ────────────────────────────────────────────

export interface TxInfo {
  status: 'pending' | 'confirmed' | 'rejected' | 'dropped' | string
  tx_hash?: string
  epoch?: number
  epoch_id?: number
  error?: { type?: string; reason?: string } | string | null
  from?: string
  to?: string
}

export async function getTransaction(hash: string): Promise<TxInfo> {
  return rpc<TxInfo>('octra_transaction', [hash])
}

export interface ContractReceipt {
  contract: string
  method:   string
  success:  boolean
  effort:   number
  events:   Array<{ contract: string; depth: number; event: string; values: string[] }>
  error:    string | null
  epoch:    number
  ts:       number
}

export async function getContractReceipt(hash: string): Promise<ContractReceipt | null> {
  try {
    return await rpc<ContractReceipt>('contract_receipt', [hash])
  } catch (err) {
    if (/not found/i.test((err as Error).message)) return null
    throw err
  }
}

export async function getNodeStatus(): Promise<{ epoch: number; network_version: string }> {
  return rpc('node_status', [])
}

export async function getBalance(addr: string): Promise<{ balance: string; balance_raw: string; nonce: number; pending_nonce: number }> {
  return rpc('octra_balance', [addr])
}
