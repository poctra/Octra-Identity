// RFC-O-1 provider discovery mirrors EIP-6963's request/announce model.
// Announcements are the only source of truth. A provider is discoverable only
// when it supplies complete EIP-6963-shaped metadata through RFC-O-1.

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
  }

  private start(): void {
    if (this.started || typeof window === 'undefined') return
    this.started = true

    window.addEventListener('octra:announceProvider', this.onAnnounce as EventListener)

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

  private acceptProvider(detail: AnnounceProviderDetail | undefined): void {
    if (!detail?.provider || !isOctraProvider(detail.provider)) return
    const announce = normalizeAnnouncement(detail.info)
    if (!announce) return
    const info = providerWalletInfo(announce)

    const existing = this.detected.get(info.id)
    if (existing?.provider === detail.provider && sameAnnouncement(existing.announce, announce)) return

    this.detected.set(info.id, {
      info,
      provider: detail.provider,
      announce,
    })
    this.emit()
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function sameAnnouncement(
  left: AnnounceProviderInfo | undefined,
  right: AnnounceProviderInfo | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.uuid === right.uuid &&
    left.name === right.name &&
    left.rdns === right.rdns &&
    left.icon === right.icon &&
    left.version === right.version &&
    left.homepage === right.homepage
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
  announce: AnnounceProviderInfo & { uuid: string; name: string; rdns: string; icon: string },
): WalletInfo {
  return {
    id: announce.uuid,
    providerIdentifier: announce.rdns,
    displayName: announce.name,
    iconUrl: announce.icon,
    homepageUrl: safeHomepage(announce?.homepage),
  }
}

function normalizeAnnouncement(
  value: AnnounceProviderInfo | undefined,
): (AnnounceProviderInfo & { uuid: string; name: string; rdns: string; icon: string }) | null {
  const uuid = value?.uuid?.trim().toLowerCase()
  const name = cleanLabel(value?.name, 64)
  const rdns = normalizeRdns(value?.rdns)
  const icon = safeWalletIcon(value?.icon)
  if (!uuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) return null
  if (!name || !rdns || !icon) return null
  return { ...value, uuid, name, rdns, icon }
}

function normalizeRdns(value: string | undefined): string | undefined {
  const rdns = value?.trim().toLowerCase()
  if (!rdns || rdns.length > 253 || !rdns.includes('.')) return undefined
  return rdns.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  ) ? rdns : undefined
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
