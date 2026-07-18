// Thin RFC-O-1 client. Anything that talks to a wallet from the dApp goes
// through this module so we never bind ONS to a specific implementation.
//
// Every method is just an `OctraProvider.request()` call against the
// standard method names. Errors are normalised into `OctraProviderError`
// subclasses so consumers can `instanceof UserRejectedError` regardless of
// which wallet they're talking to.

import { wrapProviderError, type OctraProviderError } from '@octwa/sdk'

import type {
  OctraPermission,
  OctraProvider,
  OctraProviderEvent,
} from './types'

// ─── Result / payload shapes (mirror RFC-O-1) ───────────────────────────

export interface OctraNetworkInfo {
  id:               string
  name:             string
  rpcUrl:           string
  explorerUrl?:     string
  supportsPrivacy:  boolean
  isTestnet:        boolean
}

export interface OctraTransactionResult {
  hash:         string
  accepted:     boolean
  status:       'pending' | 'confirmed' | 'rejected' | 'dropped'
  nonce?:       number
  ouCost?:      string
  explorerUrl?: string
}

const OCTRA_TX_HASH = /^(?:0x)?[0-9a-f]{64}$/i

function transactionResultRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (OCTRA_TX_HASH.test(trimmed)) return { hash: trimmed }
    if (trimmed.startsWith('{')) {
      try {
        return transactionResultRecord(JSON.parse(trimmed))
      } catch {
        return null
      }
    }
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  if (record.hash || record.txHash || record.tx_hash) return record
  return transactionResultRecord(record.result) ?? transactionResultRecord(record.data)
}

function normalizeTransactionResult(value: unknown): OctraTransactionResult {
  const record = transactionResultRecord(value)
  const rawHash = String(record?.hash ?? record?.txHash ?? record?.tx_hash ?? '').trim()
  if (!OCTRA_TX_HASH.test(rawHash)) {
    throw new Error('Wallet returned an invalid transaction hash after broadcast.')
  }

  const hash = rawHash.replace(/^0x/i, '').toLowerCase()
  const rawStatus = String(record?.status ?? 'pending').toLowerCase()
  const status: OctraTransactionResult['status'] =
    rawStatus === 'confirmed' || rawStatus === 'rejected' || rawStatus === 'dropped'
      ? rawStatus
      : 'pending'

  return {
    hash,
    accepted: record?.accepted !== false,
    status,
    nonce: typeof record?.nonce === 'number' ? record.nonce : undefined,
    ouCost: record?.ouCost != null ? String(record.ouCost) : undefined,
    explorerUrl: typeof record?.explorerUrl === 'string' ? record.explorerUrl : undefined,
  }
}

export interface SendContractTxParams {
  address: string
  method:  string
  params?: unknown[]
  amount?: string
  fee?:    string
}

export class ProviderClient {
  constructor(public readonly provider: OctraProvider) {}

  // ── Lifecycle ────────────────────────────────────────────────────────

  async connect(permissions: OctraPermission[], networkId?: string): Promise<string[]> {
    return this.request<string[]>('octra_requestAccounts', [{ permissions, networkId }])
  }

  async fetchAccounts(): Promise<string[]> {
    return this.request<string[]>('octra_accounts')
  }

  async getPermissions(): Promise<OctraPermission[]> {
    return this.request<OctraPermission[]>('octra_permissions')
  }

  async disconnect(): Promise<void> {
    // RFC-O-1 doesn't standardise disconnect yet, but every wallet we've
    // seen exposes it under the same name. Treat 4900 (DisconnectedError)
    // as a no-op success.
    try {
      await this.request('octra_disconnect')
    } catch (err) {
      const wrapped = err as OctraProviderError
      if (wrapped?.code !== 4900) {
        // Surface other failures so the UI can react.
        throw wrapped
      }
    }
  }

  async getNetworkInfo(): Promise<OctraNetworkInfo> {
    return this.request<OctraNetworkInfo>('octra_networkInfo')
  }

  // ── Reads (no popup) ─────────────────────────────────────────────────

  /**
   * Native Octra JSON-RPC pass-through. Positional array params per the spec.
   * Use this for any read the wallet itself doesn't wrap (`octra_balance`,
   * `octra_viewPubkey`, `epoch_current`, etc.).
   */
  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.request<T>(method, params)
  }

  // ── Writes (popup) ───────────────────────────────────────────────────

  async sendContractTransaction(params: SendContractTxParams): Promise<OctraTransactionResult> {
    const result = await this.request<unknown>('octra_sendContractTransaction', [params])
    return normalizeTransactionResult(result)
  }

  // ── Events ───────────────────────────────────────────────────────────

  on(event: OctraProviderEvent, listener: (...args: unknown[]) => void): void {
    this.provider.on(event, listener)
  }

  removeListener(event: OctraProviderEvent, listener: (...args: unknown[]) => void): void {
    this.provider.removeListener(event, listener)
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private async request<T>(method: string, params?: readonly unknown[] | object): Promise<T> {
    try {
      const result = await this.provider.request({ method, params })
      return result as T
    } catch (err) {
      // Re-use the SDK's typed error wrapper so downstream `instanceof`
      // checks (UserRejectedError, UnauthorizedError, …) work for any
      // RFC-O-1 wallet, not just OctWa.
      throw wrapProviderError(err)
    }
  }
}
