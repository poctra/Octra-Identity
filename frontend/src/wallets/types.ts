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
 * Poctra's discovery profile requires an EIP-6963-shaped metadata object.
 * Incomplete announcements are ignored rather than assigned inferred branding.
 */
export interface AnnounceProviderInfo {
  uuid:     string  // per-page UUID v4
  name:     string  // human-readable wallet name
  rdns:     string  // reverse-DNS identifier (e.g. 'app.poctra.wallet')
  icon:     string  // data:image URI supplied by the wallet
  version?: string
  homepage?: string
}

export interface AnnounceProviderDetail {
  provider: OctraProvider
  info:     AnnounceProviderInfo
}

// ─── Wallet metadata + detected entry ────────────────────────────────────

export interface WalletInfo {
  /** Per-page provider UUID supplied by the announcement. */
  id:           string
  /** Reverse-DNS identifier used to remember the selected wallet. */
  providerIdentifier: string
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
  announce: AnnounceProviderInfo
}

// ─── Connection state surfaced to UI ─────────────────────────────────────

export interface WalletConnection {
  address:        string
  /** Curve25519 view pubkey, base64. Resolved lazily after connect. */
  viewPublicKey?: string
}
