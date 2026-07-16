// Announce-driven wallet discovery (RFC-O-1 §"Provider Discovery").
//
// Flow:
//
//   1. The dApp listens for `octra:announceProvider` CustomEvents.
//   2. For each announce, we look at `event.detail.info` and ask the
//      registry which known wallet (if any) it matches.
//   3. Matched wallets are stored keyed by registry id; only providers
//      that pass the env allowlist are surfaced.
//   4. Once subscribed, the dApp dispatches `octra:requestProvider` so
//      every announcer re-broadcasts. Wallets that inject after page
//      load are picked up via continued listening + a short rescan loop.
//
// The announce envelope is canonical; embedded WebViews also get a global fallback.
// The fallback is only a rescue path after announce/request discovery.

import { ALLOWED_WALLET_IDS } from '../lib/constants'
import { WALLET_REGISTRY, findEntryForAnnounce } from './registry'
import type {
  AnnounceProviderDetail,
  AnnounceProviderInfo,
  DetectedWallet,
  OctraProvider,
} from './types'

type Listener = (wallets: DetectedWallet[]) => void

class WalletDiscovery {
  private detected:  Map<string, DetectedWallet> = new Map()
  private listeners: Set<Listener> = new Set()
  private started   = false
  private rescanTimer: number | null = null
  private rescanCount = 0

  subscribe(fn: Listener): () => void {
    this.start()
    this.listeners.add(fn)
    fn(this.list())
    return () => { this.listeners.delete(fn) }
  }

  list(): DetectedWallet[] {
    return Array.from(this.detected.values())
  }

  /** Re-fire `octra:requestProvider` so every announcer re-broadcasts. */
  rescan(): void {
    if (typeof window === 'undefined') return
    try { window.dispatchEvent(new Event('octra:requestProvider')) } catch { /* ignore */ }
    this.captureGlobalProvider()
  }

  // ─── internal ──────────────────────────────────────────────────────────

  private start(): void {
    if (this.started || typeof window === 'undefined') return
    this.started = true

    window.addEventListener('octra:announceProvider', this.onAnnounce as EventListener)
    window.addEventListener('octra#initialized', this.captureGlobalProvider as EventListener)
    window.addEventListener('poctra#initialized', this.captureGlobalProvider as EventListener)

    // Dev-only diagnostic — log every announce we observe so it's easy
    // to debug "wallet X isn't appearing" without patching the registry
    // by hand. The `import.meta.env.DEV` branch is stripped at build
    // time, so production bundles pay nothing for this.
    if (import.meta.env.DEV) {
      window.addEventListener('octra:announceProvider', (event: Event) => {
        const detail = (event as CustomEvent).detail
        // eslint-disable-next-line no-console
        console.debug('[ons:wallet-discovery] announce', {
          info:       detail?.info,
          providerId: detail?.provider?.providerId,
          isOctra:    detail?.provider?.isOctra,
        })
      })
    }

    // First request — anyone already loaded answers immediately.
    this.rescan()
    this.captureGlobalProvider()

    // Some wallets inject after page load. Re-prompt every 500 ms for
    // the first ~5 s, then every 2 s for another ~10 s. Both budgets
    // stop early once every allowlisted wallet has been found.
    const tick = () => {
      this.rescanCount += 1
      this.rescan()
      if (this.detected.size >= this.allowedIds().length) {
        this.stopRescan()
        return
      }
      const interval = this.rescanCount < 10 ? 500 : 2000
      const ceiling  = 16  // ~5s fast + ~12s slow ≈ 17s total
      if (this.rescanCount >= ceiling) {
        this.stopRescan()
        return
      }
      this.rescanTimer = window.setTimeout(tick, interval)
    }
    this.rescanTimer = window.setTimeout(tick, 500)
  }

  private stopRescan(): void {
    if (this.rescanTimer != null) {
      clearTimeout(this.rescanTimer)
      this.rescanTimer = null
    }
  }

  private onAnnounce = (event: Event) => {
    this.acceptProvider((event as CustomEvent<AnnounceProviderDetail>).detail)
  }

  private captureGlobalProvider = () => {
    if (typeof window === 'undefined') return
    const globals = window as Window & {
      octra?: unknown
      poctra?: unknown
      octraProviders?: unknown
      __poctraProviderInfo?: AnnounceProviderInfo
    }
    const providers = [
      globals.poctra,
      ...(Array.isArray(globals.octraProviders) ? globals.octraProviders : []),
      globals.octra,
    ].filter(isOctraProvider)
    if (providers.length === 0) return

    providers.forEach((provider) => {
      this.acceptProvider({
        provider,
        info: globals.__poctraProviderInfo ?? {
          uuid: provider.providerId ?? 'embedded-octra-wallet',
          name: provider.providerId ?? 'Octra Wallet',
          rdns: provider.providerId === 'poctra' || provider.providerId === 'poctra-mobile'
            ? 'id.octra.poctra'
            : undefined,
          version: provider.version,
        },
      })
    })
  }

  private acceptProvider(detail: AnnounceProviderDetail | undefined): void {
    if (!detail?.provider || detail.provider.isOctra !== true) return

    const entry = findEntryForAnnounce(detail.info, detail.provider)
    if (!entry) return // unknown wallet — ignore quietly
    if (!this.allowedIds().includes(entry.info.id)) return

    const existing = this.detected.get(entry.info.id)
    if (existing && existing.provider === detail.provider) return

    this.detected.set(entry.info.id, {
      info:     entry.info,
      provider: detail.provider,
      announce: detail.info,
    })
    this.emit()
  }

  private allowedIds(): string[] {
    if (ALLOWED_WALLET_IDS.length === 0) return WALLET_REGISTRY.map((e) => e.info.id)
    return WALLET_REGISTRY
      .map((e) => e.info.id)
      .filter((id) => ALLOWED_WALLET_IDS.includes(id))
  }

  private emit(): void {
    const snapshot = this.list()
    for (const fn of this.listeners) fn(snapshot)
  }
}

function isOctraProvider(value: unknown): value is OctraProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<OctraProvider>
  return provider.isOctra === true && typeof provider.request === 'function'
}

export const walletDiscovery = new WalletDiscovery()

/** All wallets in the registry that pass the env allowlist, regardless of
 *  whether they're currently installed. The picker uses this to render
 *  "not detected — install" rows. */
export function listAllowedWallets() {
  if (ALLOWED_WALLET_IDS.length === 0) return WALLET_REGISTRY.map((e) => e.info)
  return WALLET_REGISTRY
    .filter((e) => ALLOWED_WALLET_IDS.includes(e.info.id))
    .map((e) => e.info)
}
