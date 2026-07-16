import { useCallback, useEffect, useMemo, useState } from 'react'

import { isUserRejection } from '@octwa/sdk'

import {
  ProviderClient,
  walletDiscovery,
  loadPreferredWalletId,
  savePreferredWalletId,
  clearPreferredWalletId,
  type DetectedWallet,
  type OctraPermission,
  type WalletConnection,
  type WalletInfo,
} from '../wallets'

// ─── Permissions we ask every wallet for ─────────────────────────────────
//
// RFC-O-1 ships a flat permission list — the wallet enforces every grant
// per origin. ONS only ever needs the four below; ask for more and we
// just enlarge the attack surface for nothing.

const REQUESTED_PERMISSIONS: readonly OctraPermission[] = [
  'read_address',
  'read_balance',
  'read_public_key',
  'contract_calls',
] as const

// ─── State ───────────────────────────────────────────────────────────────

export interface WalletState {
  /** Every RFC-O-1 wallet detected on the page. Live updated. */
  available:   DetectedWallet[]
  /** True once the discovery loop has run at least once. */
  ready:       boolean
  /** Currently bound provider client, or null if no wallet is selected. */
  client:      ProviderClient | null
  /** Display info for the active wallet. */
  wallet:      WalletInfo | null
  connection:  WalletConnection | null
  permissions: OctraPermission[]
  connecting:  boolean
  error:       string | null
  /** Backwards-compat alias used by call sites that previously talked to
   *  `wallet.sdk.rpc(...)` and `wallet.sdk.sendContractTransaction(...)`. */
  sdk:         ProviderClient | null
  /** True when at least one wallet is reachable in the page. */
  installed:   boolean
}

export interface WalletActions {
  /** Bind a wallet without triggering its connect popup. Used for silent
   *  re-attach on page load. */
  selectWallet: (walletId: string) => void
  /**
   * Bind the chosen wallet AND open its connect popup in the same user
   * gesture. This is the call the picker should make on click — keeping
   * the popup inside the active user-activation window so the wallet
   * doesn't fall back to a standalone extension popup.
   */
  connectWith:  (walletId: string) => Promise<void>
  /** Re-connect with the wallet that's already bound (page-reload path). */
  connect:      () => Promise<void>
  disconnect:   () => Promise<void>
  /** Re-fire `octra:requestProvider` to pick up late-injecting wallets. */
  rescan:       () => void
}

export function useWallet(): WalletState & WalletActions {
  const [available, setAvailable]   = useState<DetectedWallet[]>([])
  const [ready, setReady]           = useState(false)
  const [client, setClient]         = useState<ProviderClient | null>(null)
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null)
  const [connection, setConnection] = useState<WalletConnection | null>(null)
  const [permissions, setPermissions] = useState<OctraPermission[]>([])
  const [connecting, setConnecting] = useState(false)
  const [error, setError]           = useState<string | null>(null)

  // ── Discovery ──────────────────────────────────────────────────────────

  useEffect(() => {
    const off = walletDiscovery.subscribe((wallets) => {
      setAvailable(wallets)
      setReady(true)
    })
    return off
  }, [])

  // Auto-bind the user's previously chosen wallet once it shows up. This
  // keeps page reloads silent — no picker flash, no popup.
  useEffect(() => {
    if (client) return
    const preferred = loadPreferredWalletId()
    if (!preferred) return
    const match = available.find((w) => w.info.id === preferred)
    if (match) reattach(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available])

  /** Bind the wallet and silently re-attach to an existing session if the
   *  dApp is still authorized. Never opens a popup. */
  const reattach = useCallback((detected: DetectedWallet) => {
    const c = new ProviderClient(detected.provider)
    setClient(c)
    setWalletInfo(detected.info)

    // RFC-O-1: octra_accounts returns [] when unauthorized, so this is
    // strictly read-only.
    void (async () => {
      try {
        const accounts = await c.fetchAccounts()
        if (accounts.length > 0) {
          const [address] = accounts
          setConnection({ address })
          c.getPermissions().then(setPermissions).catch(() => {})
          void resolveViewPubkey(c, address).then((vpk) => {
            if (vpk) setConnection({ address, viewPublicKey: vpk })
          })
        }
      } catch {
        /* no live session — picker stays open */
      }
    })()
  }, [])

  /** Run the full connect flow against an already-built client. Shared by
   *  the page-reload reconnect button and the picker. */
  const runConnect = useCallback(async (c: ProviderClient) => {
    setConnecting(true)
    setError(null)
    try {
      const accounts = await c.connect([...REQUESTED_PERMISSIONS])
      if (accounts.length === 0) throw new Error('no account returned by wallet')
      const [address] = accounts
      const perms = await c.getPermissions().catch(() => [...REQUESTED_PERMISSIONS] as OctraPermission[])
      setConnection({ address })
      setPermissions(perms)

      void resolveViewPubkey(c, address).then((vpk) => {
        if (!vpk) return
        setConnection((prev) => prev?.address === address ? { address, viewPublicKey: vpk } : prev)
      })
    } catch (err) {
      if (isUserRejection(err)) {
        setError(null)
        return
      }
      setError((err as Error).message)
    } finally {
      setConnecting(false)
    }
  }, [])

  // ── Wallet events ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!client) return

    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0]
      if (!Array.isArray(accounts) || accounts.length === 0) {
        setConnection(null)
        setPermissions([])
        return
      }
      const [address] = accounts as string[]
      setConnection({ address })
      void resolveViewPubkey(client, address).then((vpk) => {
        if (!vpk) return
        setConnection((prev) => prev?.address === address ? { address, viewPublicKey: vpk } : prev)
      })
    }

    const onPerms = (...args: unknown[]) => {
      const perms = args[0]
      if (Array.isArray(perms)) setPermissions(perms as OctraPermission[])
    }

    const onDisconnect = () => {
      setConnection(null)
      setPermissions([])
    }

    client.on('accountsChanged', onAccounts)
    client.on('permissionsChanged', onPerms)
    client.on('disconnect', onDisconnect)

    return () => {
      client.removeListener('accountsChanged', onAccounts)
      client.removeListener('permissionsChanged', onPerms)
      client.removeListener('disconnect', onDisconnect)
    }
  }, [client])

  // ── Actions ────────────────────────────────────────────────────────────

  /** Reconnect with the already-bound client (page-reload path). */
  const connect = useCallback(async () => {
    if (!client) {
      setError('select a wallet first')
      return
    }
    await runConnect(client)
  }, [client, runConnect])

  /**
   * Bind the chosen wallet AND open its connect popup in the same user
   * gesture. Operates on the freshly-built client — does NOT wait for
   * `setClient` to flush, which would otherwise consume the gesture and
   * force the wallet into a standalone-window fallback.
   */
  const connectWith = useCallback(async (walletId: string) => {
    const match = available.find((w) => w.info.id === walletId)
    if (!match) {
      setError('wallet not detected')
      return
    }
    savePreferredWalletId(walletId)
    const c = new ProviderClient(match.provider)
    // Update React state in the background so the rest of the UI catches up,
    // but use the local `c` for the connect call so the popup fires
    // synchronously inside the click handler's user-activation window.
    setClient(c)
    setWalletInfo(match.info)
    await runConnect(c)
  }, [available, runConnect])

  /** Bind without prompting — used for silent re-attach on page load. */
  const selectWallet = useCallback((walletId: string) => {
    const match = available.find((w) => w.info.id === walletId)
    if (!match) {
      setError('wallet not detected')
      return
    }
    savePreferredWalletId(walletId)
    reattach(match)
  }, [available, reattach])

  const disconnect = useCallback(async () => {
    if (client) {
      try { await client.disconnect() } catch { /* ignore */ }
    }
    clearPreferredWalletId()
    setClient(null)
    setWalletInfo(null)
    setConnection(null)
    setPermissions([])
  }, [client])

  const rescan = useCallback(() => {
    walletDiscovery.rescan()
  }, [])

  return useMemo<WalletState & WalletActions>(() => ({
    available,
    ready,
    client,
    sdk:        client,
    wallet:     walletInfo,
    installed:  available.length > 0,
    connection,
    permissions,
    connecting,
    error,
    selectWallet,
    connectWith,
    connect,
    disconnect,
    rescan,
  }), [
    available, ready, client, walletInfo, connection, permissions,
    connecting, error, selectWallet, connectWith, connect, disconnect, rescan,
  ])
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the connected wallet's Curve25519 view pubkey via the public RPC
 * pass-through. No popup — `octra_viewPubkey` is a read.
 *
 * The node's response shape varies by version. Older builds returned a
 * bare base64 string (or "0" for "not set"); current builds return
 * `{ view_pubkey: string | null }`. Accept both so the dApp keeps working
 * across upgrades.
 */
async function resolveViewPubkey(client: ProviderClient, address: string): Promise<string> {
  try {
    const v = await client.rpc<unknown>('octra_viewPubkey', [address])
    return parseViewPubkeyResponse(v)
  } catch {
    return ''
  }
}

/** Public — re-used by the manual "fetch" button in RegisterPanel. */
export function parseViewPubkeyResponse(raw: unknown): string {
  if (typeof raw === 'string') return raw && raw !== '0' ? raw : ''
  if (raw && typeof raw === 'object' && 'view_pubkey' in raw) {
    const v = (raw as { view_pubkey?: unknown }).view_pubkey
    if (typeof v === 'string' && v && v !== '0') return v
  }
  return ''
}
