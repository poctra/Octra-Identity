// RFC-O-1 provider discovery mirrors EIP-6963's request/announce model.
// Announcements are the source of truth. The registry only enriches metadata
// for known wallets and never filters a valid provider.

import { findEntryForAnnounce } from './registry'
import type {
  AnnounceProviderDetail,
  AnnounceProviderInfo,
  DetectedWallet,
  OctraProvider,
  WalletInfo,
} from './types'

type Listener = (wallets: DetectedWallet[]) => void

class WalletDiscovery {
  private detected = new Map<string, DetectedWallet>()
  private listeners = new Set<Listener>()
  private started = false
  private rescanTimer: number | null = null
  private rescanCount = 0

  subscribe(listener: Listener): () => void {
    this.start()
    this.listeners.add(listener)
    listener(this.list())
    return () => { this.listeners.delete(listener) }
  }

  list(): DetectedWallet[] {
    return Array.from(this.detected.values()).sort((left, right) =>
      left.info.displayName.localeCompare(right.info.displayName),
    )
  }

  rescan(): void {
    if (typeof window === 'undefined') return
    try { window.dispatchEvent(new Event('octra:requestProvider')) } catch { /* ignored */ }
    this.captureGlobalProviders()
  }

  private start(): void {
    if (this.started || typeof window === 'undefined') return
    this.started = true

    window.addEventListener('octra:announceProvider', this.onAnnounce as EventListener)
    window.addEventListener('octra#initialized', this.captureGlobalProviders as EventListener)
    window.addEventListener('poctra#initialized', this.captureGlobalProviders as EventListener)

    this.rescan()
    this.rescanTimer = window.setTimeout(this.rescanTick, 500)
  }

  private rescanTick = () => {
    this.rescanCount += 1
    this.rescan()
    if (this.rescanCount >= 16) {
      this.stopRescan()
      return
    }
    this.rescanTimer = window.setTimeout(this.rescanTick, this.rescanCount < 10 ? 500 : 2000)
  }

  private stopRescan(): void {
    if (this.rescanTimer == null) return
    window.clearTimeout(this.rescanTimer)
    this.rescanTimer = null
  }

  private onAnnounce = (event: Event) => {
    this.acceptProvider((event as CustomEvent<AnnounceProviderDetail>).detail)
  }

  private captureGlobalProviders = () => {
    if (typeof window === 'undefined') return
    const globals = window as Window & {
      octra?: unknown
      poctra?: unknown
      octraProviders?: unknown
      __poctraProviderInfo?: AnnounceProviderInfo
    }
    const candidates = [
      globals.poctra,
      ...(Array.isArray(globals.octraProviders) ? globals.octraProviders : []),
      globals.octra,
    ]

    for (const provider of candidates.filter(isOctraProvider)) {
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
    }
  }

  private acceptProvider(detail: AnnounceProviderDetail | undefined): void {
    if (!detail?.provider || !isOctraProvider(detail.provider)) return
    const info = providerWalletInfo(detail.info, detail.provider)
    if (!info) return

    const existing = this.detected.get(info.id)
    if (existing?.provider === detail.provider) return

    this.detected.set(info.id, {
      info,
      provider: detail.provider,
      announce: detail.info,
    })
    this.emit()
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function isOctraProvider(value: unknown): value is OctraProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<OctraProvider>
  return provider.isOctra === true &&
    typeof provider.request === 'function' &&
    typeof provider.on === 'function' &&
    typeof provider.removeListener === 'function'
}

function providerWalletInfo(
  announce: AnnounceProviderInfo | undefined,
  provider: OctraProvider,
): WalletInfo | null {
  const known = findEntryForAnnounce(announce, provider)?.info
  const announcedId = safeProviderIdentity(provider.providerId) ??
    safeProviderIdentity(announce?.rdns) ??
    safeProviderIdentity(announce?.uuid)
  const id = known?.id ?? announcedId
  if (!id) return null

  return {
    id,
    displayName: known?.displayName ??
      cleanLabel(announce?.name, 64) ??
      cleanLabel(provider.providerId, 64) ??
      'Octra Wallet',
    iconUrl: safeWalletIcon(announce?.icon) ?? known?.iconUrl,
    homepageUrl: safeHomepage(announce?.homepage) ?? known?.homepageUrl,
  }
}

function safeProviderIdentity(value: string | undefined): string | undefined {
  const identity = value?.trim().toLowerCase()
  if (!identity || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(identity)) return undefined
  return identity
}

function cleanLabel(value: string | undefined, maxLength: number): string | undefined {
  const label = value?.trim().replace(/\s+/g, ' ')
  return label ? label.slice(0, maxLength) : undefined
}

function safeWalletIcon(value: string | undefined): string | undefined {
  if (!value || value.length > 128 * 1024) return undefined
  return /^data:image\/(?:png|webp|gif|svg\+xml);/i.test(value) ? value : undefined
}

function safeHomepage(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export const walletDiscovery = new WalletDiscovery()
