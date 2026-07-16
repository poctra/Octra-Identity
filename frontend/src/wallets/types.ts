// Types for the wallet-agnostic layer.
//
// Discovery follows RFC-O-1's announce/request handshake — every compliant
// wallet fires `octra:announceProvider` with a `{ provider, info }` envelope.
// The dApp listens, deduplicates by the envelope's identifiers, and never
// inspects `window.octra` to identify a wallet (since multiple wallets can
// stomp the same global).

import type { OctraPermission } from '@octwa/sdk'

export type { OctraPermission }

// ─── RFC-O-1 provider surface (what every wallet must expose) ────────────

export interface OctraRequestArguments {
  readonly method: string
  readonly params?: readonly unknown[] | object
}

export type OctraProviderEvent =
  | 'connect'
  | 'disconnect'
  | 'networkChanged'
  | 'accountsChanged'
  | 'permissionsChanged'
  | 'balanceChanged'
  | 'transactionChanged'
  | 'message'

export interface OctraProvider {
  readonly isOctra: true
  readonly providerId?: string
  readonly version?: string
  request(args: OctraRequestArguments): Promise<unknown>
  on(event: OctraProviderEvent, listener: (...args: unknown[]) => void): OctraProvider
  removeListener(event: OctraProviderEvent, listener: (...args: unknown[]) => void): OctraProvider
}

// ─── Announce envelope (RFC-O-1 §"Provider Discovery") ───────────────────

/**
 * Shape of `CustomEvent('octra:announceProvider').detail`.
 *
 * RFC-O-1 itself only requires the `provider`. Every compliant wallet
 * we've seen also ships an EIP-6963-shaped `info` object — name, rdns,
 * uuid, optional icon. We treat `info` as authoritative for identity.
 */
export interface AnnounceProviderInfo {
  uuid?:    string  // per-announcement UUID; useful for dedupe
  name?:    string  // human-readable name
  rdns?:    string  // reverse-DNS identifier (e.g. 'network.octra.octwa')
  icon?:    string  // optional icon URL or data URI
  version?: string
  homepage?: string
}

export interface AnnounceProviderDetail {
  provider: OctraProvider
  info?:    AnnounceProviderInfo
}

// ─── Wallet metadata + detected entry ────────────────────────────────────

export interface WalletInfo {
  /** Stable identifier — used to remember the user's last choice. */
  id:           string
  /** Display name shown in the picker. */
  displayName:  string
  /** Optional icon URL or data URI. */
  iconUrl?:     string
  /** Where to install the wallet if it's not detected. */
  homepageUrl?: string
}

export interface DetectedWallet {
  info:     WalletInfo
  provider: OctraProvider
  /** Whatever the wallet announced about itself. Useful for diagnostics. */
  announce?: AnnounceProviderInfo
}

// ─── Connection state surfaced to UI ─────────────────────────────────────

export interface WalletConnection {
  address:        string
  /** Curve25519 view pubkey, base64. Resolved lazily after connect. */
  viewPublicKey?: string
}
