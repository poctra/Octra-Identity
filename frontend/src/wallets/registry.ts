// Wallet registry — identity comes from the announce envelope.
//
// We deliberately do NOT inspect `window.octra` or any wallet-specific
// global to identify a wallet. Two reasons:
//
//   1. `window.octra` is one slot. When two wallets are installed, only
//      one wins, so global-based detection forces both registry entries
//      to point at the same provider object.
//   2. RFC-O-1 §Provider Discovery defines `octra:announceProvider` as
//      the canonical handshake — the wallet ships its own `info`, the
//      dApp trusts that `info`. No race conditions, no globals.
//
// Each registry entry exposes a `match(info)` predicate that consumes the
// announce envelope. If multiple entries match, the first wins.

import type { AnnounceProviderInfo, OctraProvider, WalletInfo } from './types'

export interface WalletEntry {
  info:  WalletInfo
  /** Returns true when the announce envelope or provider describes this wallet. */
  match: (announce: AnnounceProviderInfo | undefined, provider: OctraProvider) => boolean
}

function lower(s?: string): string { return (s ?? '').toLowerCase() }

// ─── OctWa ───────────────────────────────────────────────────────────────

function matchOctWa(announce: AnnounceProviderInfo | undefined, provider: OctraProvider): boolean {
  if (provider.providerId === 'octwa') return true
  if (!announce) return false
  if (announce.rdns === 'network.octra.octwa') return true
  return lower(announce.name) === 'octwa'
}

// ─── 0xio ────────────────────────────────────────────────────────────────
//
// 0xio's RFC-O-1 surface landed in extension v2.4.3 / SDK v2.7.1
// (CHANGELOG, 2026-05-27). Their extension's exact announce envelope is
// not publicly pinned yet, so we accept several signals:
//
//   - provider.providerId is '0xio' or 'zeroxio' (most reliable)
//   - announce.rdns starts with '0xio.' or contains '.0xio'
//   - announce.name contains '0xio'

function matchZeroXio(announce: AnnounceProviderInfo | undefined, provider: OctraProvider): boolean {
  const pid = lower(provider.providerId)
  if (pid === '0xio' || pid === 'zeroxio') return true
  if (!announce) return false
  const rdns = lower(announce.rdns)
  if (rdns.startsWith('0xio.') || rdns === 'xyz.0xio' || rdns.includes('.0xio')) return true
  return lower(announce.name).includes('0xio')
}

function matchPoctra(announce: AnnounceProviderInfo | undefined, provider: OctraProvider): boolean {
  const pid = lower(provider.providerId)
  if (pid === 'poctra' || pid === 'poctra-mobile') return true
  if (!announce) return false
  const rdns = lower(announce.rdns)
  if (rdns === 'id.octra.poctra' || rdns === 'app.octra.poctra' || rdns.includes('poctra')) return true
  return lower(announce.name).includes('poctra')
}

export const WALLET_REGISTRY: WalletEntry[] = [
  {
    info: {
      id:          'octwa',
      displayName: 'OctWa Wallet',
      homepageUrl: 'https://chromewebstore.google.com/detail/octwa-octra-wallet/celnpgbeekcppnfbhbkcdaajdbibpdai',
    },
    match: matchOctWa,
  },
  {
    info: {
      id:          'poctra',
      displayName: 'Poctra',
      iconUrl:     '/octra-id.svg',
      homepageUrl: 'https://octra.id',
    },
    match: matchPoctra,
  },
  {
    info: {
      id:          '0xio',
      displayName: '0xio Wallet',
      homepageUrl: 'https://0xio.xyz',
    },
    match: matchZeroXio,
  },
]

/** Find the registry entry whose match() predicate accepts this envelope. */
export function findEntryForAnnounce(
  announce: AnnounceProviderInfo | undefined,
  provider: OctraProvider,
): WalletEntry | undefined {
  return WALLET_REGISTRY.find((e) => e.match(announce, provider))
}

/** Look up an entry by its stable id. */
export function getWalletEntry(id: string): WalletEntry | undefined {
  return WALLET_REGISTRY.find((w) => w.info.id === id)
}
