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
    return this.request<OctraTransactionResult>('octra_sendContractTransaction', [params])
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
