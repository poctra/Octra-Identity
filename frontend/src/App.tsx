import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Info,
  ListFilter,
  LockKeyhole,
  LogOut,
  Moon,
  RefreshCw,
  Search,
  Settings2,
  ShoppingCart,
  Sun,
  Tag,
  UserRound,
  Wallet,
  X,
} from 'lucide-react'

import { useWallet } from './hooks/useWallet'
import { EXPLORER_HOST, NETWORK, ONS_CONTRACT } from './lib/constants'
import { type DetectedWallet } from './wallets'
import {
  loadActiveListings,
  loadConfig,
  loadName,
  loadOwnerNamesSnapshot,
  loadSubdomains,
  MANAGED_RESERVED_LABELS,
  ownerVersionOf,
  sendWrite,
  type ListingEntry,
  type NameRecord,
  type OnsConfig,
  type OwnerEntry,
  type TxProgressEvent,
} from './lib/ons'
import {
  epochDistance,
  explorerLink,
  formatOct,
  isValidLabel,
  isValidSubLabel,
  normalizeLabel,
  parseOctToOu,
  shortAddress,
  statusForName,
} from './lib/format'

type Tab = 'search' | 'market' | 'names' | 'admin'
type Notice = { kind: 'ok' | 'error' | 'info'; text: string; tx?: string } | null
type Theme = 'light' | 'dark'
type TxModalState = TxProgressEvent & {
  method: string
  label: string
}

const THEME_KEY = 'octra-id-theme'
const KNOWN_OWNED_NAMES_KEY = 'octra-id-known-owned-names'
const OWNER_NAMES_CACHE_KEY = 'octra-id-owner-names-cache'
const NAMES_RENDER_PAGE_SIZE = 10

export default function App() {
  const wallet = useWallet()
  const address = wallet.connection?.address ?? ''
  const client = wallet.client
  const configRef = useRef<OnsConfig | null>(null)

  const [theme, setTheme] = useState<Theme>(resolveInitialTheme)
  const [tab, setTab] = useState<Tab>('search')
  const [config, setConfig] = useState<OnsConfig | null>(null)
  const [listings, setListings] = useState<ListingEntry[]>([])
  const [owned, setOwned] = useState<OwnerEntry[]>([])
  const [primary, setPrimary] = useState('')
  const [query, setQuery] = useState('')
  const [record, setRecord] = useState<NameRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [dataLoading, setDataLoading] = useState(true)
  const [notice, setNotice] = useState<Notice>(null)
  const [txModal, setTxModal] = useState<TxModalState | null>(null)
  const [marketFilter, setMarketFilter] = useState('')
  const [sortMode, setSortMode] = useState<'price' | 'name'>('price')
  const [walletPickerOpen, setWalletPickerOpen] = useState(false)
  const overlayOpen = Boolean(txModal) || walletPickerOpen

  const isAdmin = Boolean(config?.admin && address && sameAddr(config.admin, address))
  const isPendingOwner = Boolean(config?.pendingOwner && config.pendingOwner !== '0' && address && sameAddr(config.pendingOwner, address))
  const canAccessAdmin = isAdmin || isPendingOwner

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    if (!overlayOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [overlayOpen])

  const refresh = useCallback(async ({ forceOwned = false }: { forceOwned?: boolean } = {}) => {
    const cachedNames = address && tab === 'names' && !forceOwned
      ? readOwnerNamesCache(address)
      : null
    if (cachedNames) {
      setOwned(cachedNames.entries)
      setPrimary(cachedNames.primary)
    }

    const applyConfig = (nextConfig: OnsConfig) => {
      configRef.current = nextConfig
      setConfig(nextConfig)
    }

    if (tab === 'market') {
      const [nextConfig, nextListings] = await Promise.all([
        loadConfig(),
        loadActiveListings((partial) => setListings(partial)),
      ])
      applyConfig(nextConfig)
      setListings(nextListings)
      return
    }

    if (address && tab === 'names') {
      if (cachedNames?.version != null) {
        const [nextConfig, currentVersion] = await Promise.all([
          loadConfig(),
          ownerVersionOf(address),
        ])
        applyConfig(nextConfig)
        const revalidated = revalidateOwnerEntries(cachedNames.entries, nextConfig)
        if (currentVersion === cachedNames.version) {
          const currentPrimary = revalidated.some((entry) => entry.label === cachedNames.primary && entry.record.isActive)
            ? cachedNames.primary
            : ''
          setOwned(revalidated)
          setPrimary(currentPrimary)
          return
        }

        const snapshot = await loadOwnerNamesSnapshot(address)
        const names = await supplementOwnerNames(address, snapshot.entries, sameAddr(nextConfig.admin, address))
        setOwned(names)
        setPrimary(snapshot.primary)
        writeOwnerNamesCache(address, names, snapshot.primary, snapshot.version)
        return
      }

      const [nextConfig, snapshot] = await Promise.all([
        loadConfig(),
        loadOwnerNamesSnapshot(address),
      ])
      applyConfig(nextConfig)
      const names = await supplementOwnerNames(address, snapshot.entries, sameAddr(nextConfig.admin, address))
      setOwned(names)
      setPrimary(snapshot.primary)
      writeOwnerNamesCache(address, names, snapshot.primary, snapshot.version)
      return
    }

    const nextConfig = await loadConfig()
    applyConfig(nextConfig)
    if (!address) {
      setOwned([])
      setPrimary('')
    }
  }, [address, tab])

  useEffect(() => {
    let cancelled = false
    setDataLoading(true)
    void refresh()
      .catch((err) => setNotice({ kind: 'error', text: (err as Error).message }))
      .finally(() => {
        if (!cancelled) setDataLoading(false)
      })
    const timer = window.setInterval(() => {
      void refresh().catch(() => {})
    }, 30000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (tab === 'admin' && !canAccessAdmin) setTab('search')
  }, [canAccessAdmin, tab])

  const searchName = useCallback(async (raw = query, { showResult = true }: { showResult?: boolean } = {}) => {
    const label = normalizeLabel(raw)
    setQuery(label)
    if (!label) return
    if (showResult) setTab('search')
    setBusy(true)
    setSearchLoading(true)
    try {
      const next = await loadName(label)
      setRecord(next)
      setNotice(null)
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(false)
      setSearchLoading(false)
    }
  }, [query])

  const runWrite = useCallback(async (
    label: string,
    method: string,
    params: unknown[],
    amountOu = 0n,
  ) => {
    if (!client) {
      setNotice({ kind: 'error', text: 'Connect wallet first' })
      return
    }
    blurActiveElement()
    setBusy(true)
    setNotice(null)
    setTxModal({
      method,
      label,
      stage: 'submitting',
      message: 'Waiting for wallet approval and broadcast.',
    })
    try {
      const result = await sendWrite(client, method, params, {
        amountOu,
        onProgress: (event) => {
          setTxModal((current) => current ? ({
            ...current,
            method,
            label,
            ...event,
          }) : null)
        },
      })
      if (!result.success) throw new Error(result.revertReason ?? 'contract call reverted')
      if (result.confirmationPending) {
        setNotice({
          kind: 'info',
          text: 'Transaction submitted. Final confirmation is still pending.',
          tx: result.txHash,
        })
        return
      }
      setNotice({ kind: 'ok', text: `${method} confirmed`, tx: result.txHash })
      if (label && (method === 'register_name' || method === 'buy_name')) {
        rememberKnownOwnedLabel(address, label)
      }
      const invalidateOwnedCache = shouldInvalidateOwnerNamesCache(method)
      if (invalidateOwnedCache) invalidateOwnerNamesCache(address)
      await refresh({ forceOwned: invalidateOwnedCache })
      if (label) await reconcileOwnedLabel(label, address, setOwned)
      if (method === 'register_name' || method === 'buy_name') setTab('names')
      if (label && tab === 'search') await searchName(label, { showResult: false })
    } catch (err) {
      const message = (err as Error).message
      setTxModal((current) => {
        if (!current) return null
        if (current.stage === 'reverted' || current.stage === 'rejected' || current.stage === 'confirmed') {
          return { ...current, message }
        }
        return { ...current, stage: current.stage === 'accepted' ? 'reverted' : 'rejected', message }
      })
      setNotice({ kind: 'error', text: message })
    } finally {
      setBusy(false)
    }
  }, [address, client, refresh, searchName, tab])

  const filteredListings = useMemo(() => {
    const filter = normalizeLabel(marketFilter)
    const rows = listings.filter((listing) => !filter || listing.label.includes(filter))
    return rows.sort((a, b) => {
      if (sortMode === 'name') return a.label.localeCompare(b.label)
      if (a.price === b.price) return a.label.localeCompare(b.label)
      return a.price < b.price ? -1 : 1
    })
  }, [listings, marketFilter, sortMode])

  const handleWalletClick = useCallback(() => {
    if (address) {
      void wallet.disconnect()
      return
    }
    wallet.rescan()
    setWalletPickerOpen(true)
  }, [address, wallet])

  return (
    <main className="app-shell">
      <section className="phone-frame">
        <TopBar
          address={address}
          walletName={wallet.wallet?.displayName}
          installed={wallet.installed}
          connecting={wallet.connecting}
          theme={theme}
          onToggleTheme={() => setTheme((next) => next === 'dark' ? 'light' : 'dark')}
          onWalletClick={handleWalletClick}
        />

        {walletPickerOpen && !address && (
          <WalletPicker
            detected={wallet.available}
            connecting={wallet.connecting}
            error={wallet.error}
            onClose={() => setWalletPickerOpen(false)}
            onRescan={() => wallet.rescan()}
            onConnect={(id) => {
              setWalletPickerOpen(false)
              void wallet.connectWith(id)
            }}
          />
        )}

        <nav className="tab-bar" aria-label="octra.id navigation">
          <TabButton id="search" tab={tab} setTab={setTab} icon={<Search />} label="Search" />
          <TabButton id="market" tab={tab} setTab={setTab} icon={<Tag />} label="Market" />
          <TabButton id="names" tab={tab} setTab={setTab} icon={<UserRound />} label="My Names" />
          {canAccessAdmin && <TabButton id="admin" tab={tab} setTab={setTab} icon={<Settings2 />} label="Admin" />}
        </nav>

        {notice && <NoticeBar notice={notice} onClear={() => setNotice(null)} />}
        {txModal && (
          <TxProgressModal
            tx={txModal}
            onClose={() => setTxModal(null)}
          />
        )}

        {tab === 'search' && (
          <SearchPanel
            query={query}
            setQuery={setQuery}
            record={record}
            config={config}
            address={address}
            isAdmin={isAdmin}
            busy={busy}
            searching={searchLoading}
            onSearch={() => void searchName()}
            onSearchAnother={() => {
              setRecord(null)
              setQuery('')
              setNotice(null)
            }}
            onWrite={runWrite}
          />
        )}

        {tab === 'market' && (
          <MarketplacePanel
            listings={filteredListings}
            filter={marketFilter}
            setFilter={setMarketFilter}
            sortMode={sortMode}
            setSortMode={setSortMode}
            address={address}
            busy={busy}
            loading={dataLoading}
            onBuy={(listing) => runWrite(listing.label, 'buy_name', [listing.label, address], listing.price)}
          />
        )}

        {tab === 'names' && (
        <NamesPanel
          owned={owned}
          config={config}
          primary={primary}
          address={address}
          isAdmin={isAdmin}
          busy={busy}
          loading={dataLoading}
          onWrite={runWrite}
          />
        )}

        {tab === 'admin' && canAccessAdmin && (
          <AdminPanel
            config={config}
            address={address}
            isAdmin={isAdmin}
            isPendingOwner={isPendingOwner}
            busy={busy}
            loading={dataLoading}
            onWrite={runWrite}
          />
        )}

        <AppFooter />
      </section>
    </main>
  )
}

function TopBar({
  address,
  walletName,
  installed,
  connecting,
  theme,
  onToggleTheme,
  onWalletClick,
}: {
  address: string
  walletName?: string
  installed: boolean
  connecting: boolean
  theme: Theme
  onToggleTheme: () => void
  onWalletClick: () => void
}) {
  return (
    <header className="top-bar">
      <div className="brand-mark">
        <img src="/octra-id.svg" alt="" />
      </div>
      <div className="top-meta">
        <span>Octra Identity</span>
        <div className="identity-row">
          <strong>{address ? shortAddress(address, 7, 5) : 'octra identity'}</strong>
          {address && walletName && <span className="wallet-badge">{walletName}</span>}
        </div>
      </div>
      <button
        className="icon-button theme-button"
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <Sun /> : <Moon />}
      </button>
      <button className="icon-button" onClick={onWalletClick} disabled={connecting} title={address ? 'Disconnect wallet' : 'Connect wallet'}>
        {address ? <LogOut /> : <Wallet />}
      </button>
      {!address && !installed && <span className="wallet-hint">rescan</span>}
    </header>
  )
}

function WalletPicker({
  detected,
  connecting,
  error,
  onClose,
  onRescan,
  onConnect,
}: {
  detected: DetectedWallet[]
  connecting: boolean
  error: string | null
  onClose: () => void
  onRescan: () => void
  onConnect: (id: string) => void
}) {
  return createPortal(
    <div className="wallet-backdrop" onClick={onClose}>
      <section className="wallet-sheet" role="dialog" aria-modal="true" aria-label="Choose wallet" onClick={(event) => event.stopPropagation()}>
        <div className="wallet-sheet-head">
          <div>
            <span>connect</span>
            <strong>choose wallet</strong>
          </div>
          <button className="sheet-icon" onClick={onClose} aria-label="Close wallet picker">
            <X />
          </button>
        </div>

        <div className="wallet-options">
          {detected.map((entry) => {
            const icon = entry.info.iconUrl
            const identity = entry.announce?.rdns ?? entry.provider.providerId ?? 'RFC-O-1 provider'
            return (
              <button key={entry.info.id} className="wallet-option" disabled={connecting} onClick={() => onConnect(entry.info.id)}>
                <span className="wallet-avatar">
                  {icon ? <img src={icon} alt="" /> : entry.info.displayName.slice(0, 1)}
                </span>
                <span className="wallet-option-body">
                  <strong>{entry.info.displayName}</strong>
                  <span>{identity}</span>
                </span>
              </button>
            )
          })}
          {detected.length === 0 && (
            <div className="wallet-option disabled">
              <span className="wallet-avatar"><Wallet /></span>
              <span className="wallet-option-body">
                <strong>No wallet detected</strong>
                <span>Install or enable an RFC-O-1 wallet, then rescan.</span>
              </span>
            </div>
          )}
        </div>

        {error && <p className="wallet-error">{error}</p>}

        <button className="wallet-rescan" onClick={onRescan} disabled={connecting}>
          <RefreshCw />
          Rescan
        </button>
      </section>
    </div>,
    document.body,
  )
}

function TabButton({ id, tab, setTab, icon, label }: {
  id: Tab
  tab: Tab
  setTab: (tab: Tab) => void
  icon: ReactNode
  label: string
}) {
  return (
    <button
      className={tab === id ? 'tab active' : 'tab'}
      onClick={() => setTab(id)}
      aria-current={tab === id ? 'page' : undefined}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function NoticeBar({ notice, onClear }: { notice: NonNullable<Notice>; onClear: () => void }) {
  const icon = notice.kind === 'ok'
    ? <Check />
    : notice.kind === 'error'
      ? <CircleAlert />
      : <Info />

  return createPortal(
    <div className={`notice ${notice.kind}`}>
      <span>{icon}</span>
      <p>{notice.text}</p>
      {notice.tx && (
        <a href={explorerLink(EXPLORER_HOST, 'tx', notice.tx)} target="_blank" rel="noreferrer">
          <ExternalLink />
        </a>
      )}
      <button onClick={onClear} aria-label="Dismiss notice"><X /></button>
    </div>,
    document.body,
  )
}

function TxProgressModal({ tx, onClose }: { tx: TxModalState; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const done = tx.stage === 'confirmed' || tx.stage === 'reverted' || tx.stage === 'rejected'
  const failed = tx.stage === 'reverted' || tx.stage === 'rejected'
  const title = failed ? 'Transaction failed' : tx.stage === 'confirmed' ? 'Transaction confirmed' : 'Submitting transaction'
  const rejectedBeforeHash = tx.stage === 'rejected' && !tx.txHash
  const finalFailed = tx.stage === 'reverted' || (tx.stage === 'rejected' && Boolean(tx.txHash))
  const steps: Array<{ title: string; text: string; state: 'pending' | 'active' | 'done' | 'error' }> = [
    {
      title: 'Submit',
      text: 'Wallet approval and broadcast',
      state: tx.stage === 'submitting' ? 'active' : 'done',
    },
    {
      title: rejectedBeforeHash ? 'Rejected' : 'Accepted',
      text: rejectedBeforeHash ? 'First network result rejected' : 'First network result received',
      state: tx.stage === 'submitting'
        ? 'pending'
        : rejectedBeforeHash
          ? 'error'
          : 'done',
    },
    {
      title: finalFailed ? 'Reverted' : 'Confirmed',
      text: finalFailed ? (tx.message ?? 'Final chain result failed') : 'Final blockchain confirmation',
      state: tx.stage === 'confirmed'
        ? 'done'
        : finalFailed
          ? 'error'
          : tx.stage === 'accepted'
            ? 'active'
            : 'pending',
    },
  ]

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.open) return

    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="tx-progress-dialog"
      aria-label="Transaction progress"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (done && event.target === event.currentTarget) onClose()
      }}
    >
      <div className="tx-modal-head">
        <div>
          <span>{humanizeMethod(tx.method)}</span>
          <strong>{title}</strong>
          {tx.label && <p>{tx.label}.oct</p>}
        </div>
        <button className="sheet-icon" onClick={onClose} aria-label={done ? 'Close transaction progress' : 'Hide transaction progress'}>
          <X />
        </button>
      </div>

      <div className="tx-stepper">
        {steps.map((step, index) => (
          <div className={`tx-step ${step.state}`} key={step.title}>
            <div className="tx-step-rail">
              <span className="tx-step-dot">
                {step.state === 'active' ? <span className="tx-spinner" /> : step.state === 'error' ? <X /> : step.state === 'done' ? <Check /> : null}
              </span>
              {index !== steps.length - 1 && <span className="tx-step-line" />}
            </div>
            <div>
              <strong>{step.title}</strong>
              <p>{step.text}</p>
            </div>
          </div>
        ))}
      </div>

      {tx.txHash && (
        <a className="tx-modal-link" href={explorerLink(EXPLORER_HOST, 'tx', tx.txHash)} target="_blank" rel="noreferrer">
          View transaction
          <ExternalLink />
        </a>
      )}

      <button className="primary-action tx-modal-action" onClick={onClose}>
        {done ? 'Done' : 'Hide'}
      </button>
    </dialog>
  )
}

function SearchPanel(props: {
  query: string
  setQuery: (value: string) => void
  record: NameRecord | null
  config: OnsConfig | null
  address: string
  isAdmin: boolean
  busy: boolean
  searching: boolean
  onSearch: () => void
  onSearchAnother: () => void
  onWrite: (label: string, method: string, params: unknown[], amountOu?: bigint) => void
}) {
  const { query, setQuery, record, config, address, isAdmin, busy, searching, onSearch, onSearchAnother, onWrite } = props
  const validLocal = !query || isValidLabel(query)

  if (record) {
    return (
      <SearchResultScreen
        record={record}
        config={config}
        address={address}
        isAdmin={isAdmin}
        busy={busy}
        onSearchAnother={onSearchAnother}
        onWrite={onWrite}
      />
    )
  }

  return (
    <section className="home-screen">
      <div className="search-intro">
        <span className="screen-kicker">Octra naming service</span>
        <h1>Find your name.</h1>
        <p>Search, register, and manage a human-readable identity for your Octra address.</p>
      </div>
      <form
        className="search-box home-search"
        onSubmit={(event) => {
          event.preventDefault()
          onSearch()
        }}
      >
        <div className="search-input-row">
          <input
            className={validLocal ? '' : 'invalid'}
            value={query}
            maxLength={63}
            inputMode="text"
            onChange={(event) => setQuery(normalizeLabel(event.target.value))}
            placeholder="search name"
            aria-label="Search octra.id name"
          />
          <span>.oct</span>
          <button type="submit" disabled={busy || !query || !validLocal} aria-label="Search name"><Search /></button>
        </div>
        {searching && (
          <div className="search-progress" role="progressbar" aria-label="Searching name">
            <span />
          </div>
        )}
        {!validLocal && <p className="field-error">3-63 chars; use a-z, 0-9, or hyphen between characters</p>}
      </form>
    </section>
  )
}

function SearchResultScreen({
  record,
  config,
  address,
  isAdmin,
  busy,
  onSearchAnother,
  onWrite,
}: {
  record: NameRecord
  config: OnsConfig | null
  address: string
  isAdmin: boolean
  busy: boolean
  onSearchAnother: () => void
  onWrite: (label: string, method: string, params: unknown[], amountOu?: bigint) => void
}) {
  const [years, setYears] = useState(1)
  const status = statusForName(record)
  const canRegister = record.isAvailable && record.isValidLabel && (!record.isReserved || isAdmin)
  const canBuy = Boolean(record.listingPrice > 0n && address && !sameAddr(record.owner, address))
  const pricePerYear = config?.pricePerYear ?? 0n
  const cost = pricePerYear * BigInt(years)
  const pricingReady = Boolean(config)

  return (
    <section className="result-screen">
      <article className="name-card result-card">
        <div className="name-card-head result-card-head">
          <div>
            <span className={`status-pill ${status}`}>{status}</span>
            <h2>{record.label}<span>.oct</span></h2>
          </div>
          {record.isReserved && <LockKeyhole className="reserved-icon" />}
        </div>

        <div className="price-strip">
          <div>
            <span>price / year</span>
            <strong>{pricingReady ? `${formatOct(pricePerYear)} OCT` : '-'}</strong>
          </div>
          <div>
            <span>register total</span>
            <strong>{pricingReady ? `${formatOct(cost)} OCT` : '-'}</strong>
          </div>
        </div>

        <div className="detail-grid result-details">
          <Detail label="owner" value={record.owner ? shortAddress(record.owner) : 'none'} />
          <Detail label="destination" value={record.destination ? shortAddress(record.destination) : 'none'} />
          <Detail label="expiry" value={config ? epochDistance(record.expiry, config.currentEpoch) : '-'} />
          <Detail label="registered" value={config && record.registeredAt ? epochDistance(record.registeredAt, config.currentEpoch) : '-'} />
          <Detail label="listed" value={record.listingPrice > 0n ? `${formatOct(record.listingPrice)} OCT` : 'no'} />
          <Detail label="seller" value={record.listingSeller ? shortAddress(record.listingSeller) : 'none'} />
          <Detail label="valid" value={record.isValidLabel ? 'yes' : 'no'} />
          <Detail label="reserved" value={record.isReserved ? 'yes' : 'no'} />
        </div>

        {canRegister && (
          <div className="action-block register-block">
            <div className="split-row">
              <label>
                <span>years</span>
                <input type="number" min={1} max={10} value={years} onChange={(event) => setYears(clampYears(event.target.value))} />
              </label>
              <label>
                <span>caller</span>
                <input value={address ? shortAddress(address, 10, 8) : 'connect wallet'} readOnly />
              </label>
            </div>
          </div>
        )}

        {record.isReserved && !isAdmin && record.isAvailable && (
          <div className="state-note">reserved by octra.id admin</div>
        )}

        {canBuy && (
          <button className="secondary-action buy-listing-action" disabled={busy || !address} onClick={() => onWrite(record.label, 'buy_name', [record.label, address], record.listingPrice)}>
            <ShoppingCart />
            Buy listed name
          </button>
        )}

        <div className="result-actions">
          {canRegister && (
            <button className="primary-action" disabled={busy || !address || !pricingReady} onClick={() => onWrite(record.label, 'register_name', [record.label, address, years], cost)}>
              Register this name
            </button>
          )}
          <button className={canRegister ? 'secondary-action' : 'primary-action'} onClick={onSearchAnother}>
            Search another
          </button>
        </div>
      </article>
    </section>
  )
}

function MarketplacePanel({
  listings,
  filter,
  setFilter,
  sortMode,
  setSortMode,
  address,
  busy,
  loading,
  onBuy,
}: {
  listings: ListingEntry[]
  filter: string
  setFilter: (value: string) => void
  sortMode: 'price' | 'name'
  setSortMode: (value: 'price' | 'name') => void
  address: string
  busy: boolean
  loading: boolean
  onBuy: (listing: ListingEntry) => void
}) {
  const [visibleCount, setVisibleCount] = useState(NAMES_RENDER_PAGE_SIZE)

  useEffect(() => {
    setVisibleCount(NAMES_RENDER_PAGE_SIZE)
  }, [filter, sortMode])

  const visibleListings = listings.slice(0, visibleCount)
  const hasMore = visibleListings.length < listings.length

  return (
    <section className="panel-stack">
      <div className="screen-heading">
        <div>
          <span className="screen-kicker">Marketplace</span>
          <h1>Names for sale</h1>
          <p>Browse active listings and settle ownership directly on Octra.</p>
        </div>
      </div>
      <div className="toolbar">
        <ListFilter />
        <input value={filter} onChange={(event) => setFilter(normalizeLabel(event.target.value))} placeholder="filter" />
        <button className={sortMode === 'price' ? 'mini active' : 'mini'} onClick={() => setSortMode('price')}>price</button>
        <button className={sortMode === 'name' ? 'mini active' : 'mini'} onClick={() => setSortMode('name')}>name</button>
      </div>
      {loading && listings.length === 0 ? (
        <LoadingState title="Loading market" text="Fetching active listings." />
      ) : listings.length === 0 ? (
        <EmptyState icon={<Tag />} title="No active listings" text="Listed names will appear here." />
      ) : (
        <>
          {loading && <p className="market-sync-status" role="status">Syncing remaining listings...</p>}
          <div className="listing-list">
            {visibleListings.map((listing) => (
              <ListingCard key={listing.label} listing={listing} address={address} busy={busy} onBuy={onBuy} />
            ))}
          </div>
          {hasMore && (
            <div className="data-pagination">
              <button
                className="data-load-more"
                type="button"
                onClick={() => setVisibleCount((current) => Math.min(current + NAMES_RENDER_PAGE_SIZE, listings.length))}
              >
                <ChevronDown aria-hidden="true" />
                Load more
                <span>{visibleListings.length} of {listings.length}</span>
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ListingCard({ listing, address, busy, onBuy }: {
  listing: ListingEntry
  address: string
  busy: boolean
  onBuy: (listing: ListingEntry) => void
}) {
  const own = address && sameAddr(listing.owner, address)
  return (
    <article className="listing-card marketplace-card">
      <div className="listing-main">
        <span className="status-pill listed">listed</span>
        <h3>{listing.label}<span>.oct</span></h3>
        <p>{shortAddress(listing.seller)} seller</p>
      </div>
      <div className="listing-price">
        <span>ask</span>
        <strong>{formatOct(listing.price)} OCT</strong>
      </div>
      <div className="detail-grid listing-details">
        <Detail label="owner" value={shortAddress(listing.owner)} />
        <Detail label="seller" value={shortAddress(listing.seller)} />
      </div>
      {!own && (
        <button className="primary-action buy-row" disabled={busy || !address} onClick={() => onBuy(listing)}>
          <ShoppingCart />
          Buy name
        </button>
      )}
      {own && <span className="owned-chip">yours</span>}
    </article>
  )
}

function NamesPanel({
  owned,
  config,
  primary,
  address,
  isAdmin,
  busy,
  loading,
  onWrite,
}: {
  owned: OwnerEntry[]
  config: OnsConfig | null
  primary: string
  address: string
  isAdmin: boolean
  busy: boolean
  loading: boolean
  onWrite: (label: string, method: string, params: unknown[], amountOu?: bigint) => void
}) {
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(NAMES_RENDER_PAGE_SIZE)

  useEffect(() => {
    setVisibleCount(NAMES_RENDER_PAGE_SIZE)
    setExpandedLabel(null)
  }, [address])

  useEffect(() => {
    if (expandedLabel && !owned.some((entry) => entry.label === expandedLabel)) {
      setExpandedLabel(null)
    }
  }, [expandedLabel, owned])

  let content: ReactNode
  if (!address) {
    content = <EmptyState icon={<Wallet />} title="Wallet disconnected" text="Connect wallet to manage names." />
  } else if (loading) {
    content = <LoadingState title="Loading names" text="Fetching names owned by this wallet." />
  } else if (owned.length === 0) {
    content = <EmptyState icon={<UserRound />} title="No owned names" text="Registered names appear here." />
  } else {
    const visibleNames = owned.slice(0, visibleCount)
    const hasMore = visibleNames.length < owned.length
    content = (
      <>
        {visibleNames.map((entry) => (
            <ManageNameCard
              key={entry.label}
              entry={entry}
              config={config}
              primary={primary}
              isAdmin={isAdmin}
              busy={busy}
              expanded={expandedLabel === entry.label}
              onToggle={() => setExpandedLabel((current) => current === entry.label ? null : entry.label)}
              onWrite={onWrite}
            />
        ))}
        {hasMore && (
          <div className="data-pagination">
            <button
              className="data-load-more"
              type="button"
              onClick={() => setVisibleCount((current) => Math.min(current + NAMES_RENDER_PAGE_SIZE, owned.length))}
            >
              <ChevronDown aria-hidden="true" />
              Load more
              <span>{visibleNames.length} of {owned.length}</span>
            </button>
          </div>
        )}
      </>
    )
  }

  return (
    <section className="panel-stack">
      <div className="screen-heading">
        <div>
          <span className="screen-kicker">Your identity</span>
          <div className="names-heading-title">
            <h1>My names</h1>
            {address && !loading && <span className="names-total">{owned.length} total</span>}
          </div>
          <p>Manage destinations, subdomains, renewals, and ownership.</p>
        </div>
      </div>
      {content}
    </section>
  )
}

function ManageNameCard({
  entry,
  config,
  primary,
  isAdmin,
  busy,
  expanded,
  onToggle,
  onWrite,
}: {
  entry: OwnerEntry
  config: OnsConfig | null
  primary: string
  isAdmin: boolean
  busy: boolean
  expanded: boolean
  onToggle: () => void
  onWrite: (label: string, method: string, params: unknown[], amountOu?: bigint) => void
}) {
  const { record } = entry
  const [transferTo, setTransferTo] = useState('')
  const [listPrice, setListPrice] = useState(record.listingPrice > 0n ? formatOct(record.listingPrice) : '1')
  const [renewYears, setRenewYears] = useState(1)
  const [resolver, setResolver] = useState(record.destination)
  const [subLabel, setSubLabel] = useState('')
  const [subDestination, setSubDestination] = useState('')
  const [subdomains, setSubdomains] = useState(entry.subdomains)
  const [subdomainsLoaded, setSubdomainsLoaded] = useState(entry.subdomains.length > 0)
  const [subdomainsLoading, setSubdomainsLoading] = useState(false)
  const [subdomainError, setSubdomainError] = useState('')
  const isPrimary = primary === record.label
  const renewCost = (config?.pricePerYear ?? 0n) * BigInt(renewYears)
  const locked = record.isReserved
  const status = statusForName(record)
  const validSubLabel = !subLabel || isValidSubLabel(subLabel)
  const validResolver = isOctraAddress(resolver)

  useEffect(() => {
    setSubdomains(entry.subdomains)
    setSubdomainsLoaded(entry.subdomains.length > 0)
    setSubdomainError('')
  }, [entry.label, entry.subdomains])

  useEffect(() => {
    setResolver(record.destination)
  }, [record.destination, record.label])

  const loadSubdomainList = useCallback(async () => {
    setSubdomainsLoading(true)
    setSubdomainError('')
    try {
      const next = await loadSubdomains(record.label)
      setSubdomains(next)
      setSubdomainsLoaded(true)
    } catch (err) {
      setSubdomainError((err as Error).message || 'Unable to load subdomains.')
    } finally {
      setSubdomainsLoading(false)
    }
  }, [record.label])

  return (
    <article className={`manage-card my-name-card${expanded ? ' expanded' : ''}`}>
      <button className="manage-head manage-toggle" type="button" onClick={onToggle} aria-expanded={expanded}>
        <div>
          <span className={`status-pill ${status}`}>{status}</span>
          <h3>{record.label}<span>.oct</span></h3>
          <p>
            {record.destination ? shortAddress(record.destination, 10, 8) : 'no destination'}
            <span aria-hidden="true"> / </span>
            {config ? epochDistance(record.expiry, config.currentEpoch) : 'loading'}
          </p>
        </div>
        <span className="manage-toggle-actions">
          {isPrimary && <span className="primary-chip"><BadgeCheck /> primary</span>}
          <span className="manage-chevron" aria-hidden="true"><ChevronDown /></span>
        </span>
      </button>

      {expanded && <>
      <div className="detail-grid manage-details">
        <Detail label="destination" value={record.destination ? shortAddress(record.destination) : 'none'} />
        <Detail label="listed" value={record.listingPrice > 0n ? `${formatOct(record.listingPrice)} OCT` : 'no'} />
        <Detail label="expiry" value={config ? epochDistance(record.expiry, config.currentEpoch) : '-'} />
        <Detail label="primary" value={isPrimary ? 'yes' : 'no'} />
      </div>

      <div className="button-grid">
        <button className={isPrimary ? 'secondary-action' : 'primary-action'} disabled={busy} onClick={() => onWrite(record.label, isPrimary ? 'unset_primary' : 'set_primary', isPrimary ? [] : [record.label])}>
          {isPrimary ? 'Unset primary' : 'Set primary'}
        </button>
      </div>

      <div className="manage-section resolver-section">
        <div className="section-title-row">
          <div>
            <strong>Resolver record</strong>
            <span>Point this name to an EOA or Circle address without changing ownership</span>
          </div>
        </div>
        <div className="split-row">
          <label>
            <span>resolve to</span>
            <input
              className={resolver && !validResolver ? 'invalid' : ''}
              value={resolver}
              onChange={(event) => setResolver(event.target.value.trim())}
              placeholder="oct..."
            />
          </label>
          <button
            className="primary-action"
            disabled={busy || !record.isActive || !validResolver || sameAddr(resolver, record.destination)}
            onClick={() => onWrite(record.label, 'set_record', [record.label, resolver])}
          >
            Set record
          </button>
        </div>
        {resolver && !validResolver && <p className="field-error">Enter a valid Octra or Circle address</p>}
      </div>

      <div className="manage-section subdomain-section">
        <div className="section-title-row">
          <div>
            <strong>Subdomains</strong>
            <span>Resolve under {record.label}.oct while the parent is active</span>
          </div>
        </div>
        <div className="split-row subdomain-input-row">
          <label>
            <span>name</span>
            <div className="suffix-input">
              <input
                className={validSubLabel ? '' : 'invalid'}
                value={subLabel}
                onChange={(event) => setSubLabel(normalizeLabel(event.target.value))}
                placeholder="app"
                maxLength={63}
              />
              <em>.{record.label}.oct</em>
            </div>
          </label>
          <label>
            <span>destination</span>
            <input value={subDestination} onChange={(event) => setSubDestination(event.target.value.trim())} placeholder="oct..." />
          </label>
        </div>
        {!validSubLabel && <p className="field-error">1-63 chars; use a-z, 0-9, or hyphen between characters</p>}
        <button
          className="secondary-action"
          disabled={busy || !validSubLabel || !subLabel || !subDestination || !record.isActive}
          onClick={() => {
            onWrite(record.label, 'set_sub_record', [record.label, subLabel, subDestination])
            setSubdomainsLoaded(false)
            setSubLabel('')
            setSubDestination('')
          }}
        >
          Save subdomain
        </button>
        {subdomainError && <p className="field-error">{subdomainError}</p>}
        {!subdomainsLoaded ? (
          <div className="state-note">
            <button className="mini" disabled={subdomainsLoading} onClick={loadSubdomainList}>
              {subdomainsLoading ? 'Loading...' : 'Load subdomains'}
            </button>
          </div>
        ) : subdomains.length > 0 ? (
          <div className="subdomain-list">
            {subdomains.map((subdomain) => (
              <div className="subdomain-row" key={`${subdomain.parent}:${subdomain.label}`}>
                <div>
                  <strong>{subdomain.label}.{record.label}.oct</strong>
                  <span>{subdomain.destination ? shortAddress(subdomain.destination, 10, 8) : 'no destination'}</span>
                </div>
                <button
                  className="mini"
                  disabled={busy || !record.isActive}
                  onClick={() => {
                    setSubLabel(subdomain.label)
                    setSubDestination(subdomain.destination)
                  }}
                >
                  Edit
                </button>
                <button
                  className="mini danger"
                  disabled={busy || !record.isActive}
                  onClick={() => {
                    onWrite(record.label, 'release_subdomain', [record.label, subdomain.label])
                    setSubdomainsLoaded(false)
                  }}
                >
                  Release
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="state-note">No subdomains yet</div>
        )}
      </div>

      <div className="manage-section">
        <div className="split-row">
          <label>
            <span>renew years</span>
            <input type="number" min={1} max={10} value={renewYears} onChange={(event) => setRenewYears(clampYears(event.target.value))} />
          </label>
          <button disabled={busy} onClick={() => onWrite(record.label, 'renew_name', [record.label, renewYears], renewCost)}>
            Renew {formatOct(renewCost)} OCT
          </button>
        </div>
      </div>

      {!locked && (
        <>
          <div className="manage-section">
            <div className="split-row">
              <label>
                <span>list price OCT</span>
                <input value={listPrice} onChange={(event) => setListPrice(event.target.value)} />
              </label>
              {record.listingPrice > 0n ? (
                <button disabled={busy} onClick={() => onWrite(record.label, 'cancel_listing', [record.label])}>Cancel listing</button>
              ) : (
                <button disabled={busy} onClick={() => onWrite(record.label, 'list_name', [record.label, Number(parseOctToOu(listPrice))])}>List name</button>
              )}
            </div>
          </div>
          <div className="manage-section">
            <label>
              <span>transfer to</span>
              <input value={transferTo} onChange={(event) => setTransferTo(event.target.value.trim())} placeholder="oct..." />
            </label>
            <div className="button-grid">
              <button disabled={busy || !transferTo} onClick={() => onWrite(record.label, 'transfer_name', [record.label, transferTo])}>Transfer</button>
              <button className="danger" disabled={busy} onClick={() => onWrite(record.label, 'release_name', [record.label])}>Release</button>
            </div>
          </div>
        </>
      )}

      {locked && isAdmin && (
        <div className="manage-section reserved-transfer-section">
          <label>
            <span>transfer reserved to</span>
            <input value={transferTo} onChange={(event) => setTransferTo(event.target.value.trim())} placeholder="oct..." />
          </label>
          <button
            disabled={busy || !transferTo}
            onClick={() => onWrite(record.label, 'transfer_reserved_name', [record.label, transferTo, transferTo])}
          >
            Transfer reserved name
          </button>
          <div className="state-note">destination will follow the recipient address</div>
        </div>
      )}

      {locked && !isAdmin && <div className="state-note">reserved names stay under admin control</div>}
      </>}
    </article>
  )
}

function AdminPanel({
  config,
  address,
  isAdmin,
  isPendingOwner,
  busy,
  loading,
  onWrite,
}: {
  config: OnsConfig | null
  address: string
  isAdmin: boolean
  isPendingOwner: boolean
  busy: boolean
  loading: boolean
  onWrite: (label: string, method: string, params: unknown[], amountOu?: bigint) => void
}) {
  const [price, setPrice] = useState(config ? formatOct(config.pricePerYear) : '0.5')
  const [fee, setFee] = useState(config ? String(config.feeBps) : '250')
  const [grace, setGrace] = useState(config ? String(config.graceEpochs) : '259200')
  const [withdrawTo, setWithdrawTo] = useState(config?.admin ?? '')
  const [nextOwner, setNextOwner] = useState('')

  useEffect(() => {
    if (!config) return
    setPrice(formatOct(config.pricePerYear))
    setFee(String(config.feeBps))
    setGrace(String(config.graceEpochs))
  }, [config])

  useEffect(() => {
    setWithdrawTo(config?.admin ?? '')
  }, [config?.admin])

  const validWithdrawTo = isOctraAddress(withdrawTo)
  const validNextOwner = isOctraAddress(nextOwner) && !sameAddr(nextOwner, config?.admin ?? '')

  if (loading && !config) return <LoadingState title="Loading admin" text="Fetching contract configuration." />

  return (
    <section className="panel-stack">
      <div className="screen-heading">
        <div>
          <span className="screen-kicker">Contract controls</span>
          <h1>Admin</h1>
          <p>Manage protocol configuration, revenue, and contract ownership.</p>
        </div>
      </div>
      <div className="contract-card">
        <div className="label-row"><Settings2 /><span>contract</span></div>
        <a href={explorerLink(EXPLORER_HOST, 'address', ONS_CONTRACT)} target="_blank" rel="noreferrer">
          {shortAddress(ONS_CONTRACT, 11, 8)} <ExternalLink />
        </a>
        <Detail label="admin" value={config?.admin ? shortAddress(config.admin) : '-'} />
        <Detail label="pending owner" value={config?.pendingOwner && config.pendingOwner !== '0' ? shortAddress(config.pendingOwner) : 'none'} />
        <Detail label="protocol revenue" value={`${formatOct(config?.feesCollected ?? 0n)} OCT`} />
      </div>

      {!isAdmin && !isPendingOwner ? (
        <EmptyState icon={<LockKeyhole />} title="Admin wallet required" text="Configuration writes are hidden behind contract ownership." />
      ) : null}

      {isPendingOwner && (
        <div className="admin-grid ownership-accept-panel">
          <div className="admin-wide section-title-row">
            <div>
              <strong>Ownership invitation</strong>
              <span>Accept control of the contract and eligible reserved names</span>
            </div>
          </div>
          <Detail label="connected as" value={shortAddress(address)} />
          <button className="primary-action" disabled={busy} onClick={() => onWrite('', 'accept_ownership', [])}>
            Accept ownership
          </button>
        </div>
      )}

      {isAdmin && (
        <div className="admin-grid">
          <label>
            <span>price/year OCT</span>
            <input value={price} onChange={(event) => setPrice(event.target.value)} />
          </label>
          <button disabled={busy} onClick={() => onWrite('', 'set_registration_price', [Number(parseOctToOu(price))])}>Set price</button>

          <label>
            <span>fee bps</span>
            <input value={fee} onChange={(event) => setFee(event.target.value.replace(/\D/g, ''))} />
          </label>
          <button disabled={busy} onClick={() => onWrite('', 'set_marketplace_fee_bps', [Number(fee)])}>Set fee</button>

          <label>
            <span>grace epochs</span>
            <input value={grace} onChange={(event) => setGrace(event.target.value.replace(/\D/g, ''))} />
          </label>
          <button disabled={busy} onClick={() => onWrite('', 'set_grace_period', [Number(grace)])}>Set grace</button>

          <button disabled={busy || config?.paused === true} onClick={() => onWrite('', 'pause', [])}>Pause</button>
          <button disabled={busy || config?.paused === false} onClick={() => onWrite('', 'unpause', [])}>Unpause</button>

          <div className="admin-wide section-title-row admin-divider">
            <div>
              <strong>Protocol revenue</strong>
              <span>Registration, renewal, and marketplace fees</span>
            </div>
          </div>
          <label>
            <span>withdraw to</span>
            <input
              className={withdrawTo && !validWithdrawTo ? 'invalid' : ''}
              value={withdrawTo}
              onChange={(event) => setWithdrawTo(event.target.value.trim())}
              placeholder="oct..."
            />
          </label>
          <button
            className="primary-action"
            disabled={busy || !validWithdrawTo || (config?.feesCollected ?? 0n) <= 0n}
            onClick={() => onWrite('', 'withdraw_fees', [withdrawTo])}
          >
            Withdraw {formatOct(config?.feesCollected ?? 0n)} OCT
          </button>

          <div className="admin-wide section-title-row admin-divider">
            <div>
              <strong>Contract ownership</strong>
              <span>The proposed address must accept before control changes</span>
            </div>
          </div>
          <label>
            <span>next owner</span>
            <input
              className={nextOwner && !validNextOwner ? 'invalid' : ''}
              value={nextOwner}
              onChange={(event) => setNextOwner(event.target.value.trim())}
              placeholder="oct..."
            />
          </label>
          <button
            className="secondary-action"
            disabled={busy || !validNextOwner}
            onClick={() => onWrite('', 'propose_ownership', [nextOwner])}
          >
            Propose ownership
          </button>
        </div>
      )}
    </section>
  )
}

function AppFooter() {
  const year = new Date().getFullYear()
  return (
    <footer className="app-footer">
      &copy; {year} octra.id
    </footer>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function LoadingState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state loading-state">
      <div><RefreshCw /></div>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  )
}

function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state">
      <div>{icon}</div>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  )
}

function humanizeMethod(method: string): string {
  return method
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

async function supplementOwnerNames(
  address: string,
  indexed: OwnerEntry[],
  includeManagedReserved = false,
): Promise<OwnerEntry[]> {
  const indexedLabels = new Set(indexed.map((entry) => entry.label))
  const extraLabels = [...new Set([
    ...readKnownOwnedLabels(address),
    ...(includeManagedReserved ? MANAGED_RESERVED_LABELS : []),
  ])].filter((label) => !indexedLabels.has(label))
  if (extraLabels.length === 0) return mergeOwnerEntries(indexed)

  const extras: Array<OwnerEntry | null> = await Promise.all(extraLabels.map(async (label): Promise<OwnerEntry | null> => {
    try {
      const record = await loadName(label)
      return sameAddr(record.owner, address) ? { label, record, subdomains: [] as OwnerEntry['subdomains'] } : null
    } catch {
      return null
    }
  }))
  const ownedExtras = extras.filter((entry): entry is OwnerEntry => Boolean(entry))
  pruneKnownOwnedLabels(address, [...indexed.map((entry) => entry.label), ...ownedExtras.map((entry) => entry.label)])
  return mergeOwnerEntries([...indexed, ...ownedExtras])
}

async function reconcileOwnedLabel(
  label: string,
  address: string,
  updateOwned: (updater: (prev: OwnerEntry[]) => OwnerEntry[]) => void,
) {
  const normalized = normalizeLabel(label)
  if (!normalized || !address) return

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const record = await loadName(normalized)
      const isOwner = sameAddr(record.owner, address)
      updateOwned((prev) => {
        if (!isOwner) return prev.filter((entry) => entry.label !== normalized)
        return mergeOwnerEntries([...prev.filter((entry) => entry.label !== normalized), { label: normalized, record, subdomains: [] }])
      })
      if (isOwner) {
        rememberKnownOwnedLabel(address, normalized)
        return
      }
    } catch {
      // Keep retrying briefly; index/read models can lag a confirmed write.
    }
    await wait(1500)
  }
}

function mergeOwnerEntries(entries: OwnerEntry[]): OwnerEntry[] {
  const byLabel = new Map<string, OwnerEntry>()
  for (const entry of entries) byLabel.set(entry.label, entry)
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function revalidateOwnerEntries(
  entries: OwnerEntry[],
  meta: Pick<OnsConfig, 'currentEpoch' | 'graceEpochs'>,
): OwnerEntry[] {
  return entries.map((entry) => {
    const expiry = entry.record.expiry
    const isActive = expiry > 0 && meta.currentEpoch <= expiry
    const isGrace = expiry > 0 && meta.currentEpoch > expiry && meta.currentEpoch <= expiry + meta.graceEpochs
    return {
      ...entry,
      record: {
        ...entry.record,
        isActive,
        isGrace,
        isAvailable: entry.record.isValidLabel && !entry.record.isReserved && (
          expiry === 0 || meta.currentEpoch > expiry + meta.graceEpochs
        ),
      },
    }
  })
}

function knownOwnedStorageKey(address: string): string {
  return `${KNOWN_OWNED_NAMES_KEY}:${address.toLowerCase()}`
}

function ownerNamesStorageKey(address: string): string {
  return `${OWNER_NAMES_CACHE_KEY}:${NETWORK}:${ONS_CONTRACT.toLowerCase()}:${address.toLowerCase()}`
}

function readKnownOwnedLabels(address: string): string[] {
  if (!address || typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(knownOwnedStorageKey(address)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.map((item) => normalizeLabel(String(item))).filter(Boolean))]
  } catch {
    return []
  }
}

function writeKnownOwnedLabels(address: string, labels: string[]) {
  if (!address || typeof window === 'undefined') return
  const normalized = [...new Set(labels.map((label) => normalizeLabel(label)).filter(Boolean))]
  window.localStorage.setItem(knownOwnedStorageKey(address), JSON.stringify(normalized))
}

function rememberKnownOwnedLabel(address: string, label: string) {
  const normalized = normalizeLabel(label)
  if (!normalized) return
  writeKnownOwnedLabels(address, [...readKnownOwnedLabels(address), normalized])
}

function pruneKnownOwnedLabels(address: string, labels: string[]) {
  writeKnownOwnedLabels(address, labels)
}

function readOwnerNamesCache(address: string): {
  entries: OwnerEntry[]
  primary: string
  version: number | null
  savedAt: number
} | null {
  if (!address || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(ownerNamesStorageKey(address))
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      entries?: unknown[]
      primary?: string
      version?: unknown
      savedAt?: unknown
    }
    if (!Array.isArray(parsed.entries)) return null
    return {
      entries: mergeOwnerEntries(parsed.entries.map(hydrateOwnerEntry).filter(Boolean) as OwnerEntry[]),
      primary: typeof parsed.primary === 'string' ? parsed.primary : '',
      version: typeof parsed.version === 'number' && Number.isSafeInteger(parsed.version) ? parsed.version : null,
      savedAt: typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
    }
  } catch {
    return null
  }
}

function writeOwnerNamesCache(
  address: string,
  entries: OwnerEntry[],
  primary: string,
  version: number | null,
) {
  if (!address || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ownerNamesStorageKey(address), JSON.stringify({
      savedAt: Date.now(),
      version,
      primary,
      entries: entries.map(serializeOwnerEntry),
    }))
  } catch {
    // localStorage can be unavailable in hardened webviews; the app still works without it.
  }
}

function invalidateOwnerNamesCache(address: string) {
  if (!address || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(ownerNamesStorageKey(address))
  } catch {
    // ignore storage failures
  }
}

function shouldInvalidateOwnerNamesCache(method: string): boolean {
  return [
    'register_name',
    'buy_name',
    'renew_name',
    'release_name',
    'transfer_name',
    'transfer_reserved_name',
    'set_record',
    'set_primary',
    'unset_primary',
    'list_name',
    'cancel_listing',
  ].includes(method)
}

function serializeOwnerEntry(entry: OwnerEntry) {
  return {
    ...entry,
    record: {
      ...entry.record,
      listingPrice: entry.record.listingPrice.toString(),
    },
  }
}

function hydrateOwnerEntry(raw: unknown): OwnerEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Partial<OwnerEntry> & { record?: Partial<NameRecord> & { listingPrice?: unknown } }
  if (!entry.label || typeof entry.label !== 'string' || !entry.record) return null
  const record = entry.record
  return {
    label: normalizeLabel(entry.label),
    record: {
      label: normalizeLabel(String(record.label ?? entry.label)),
      owner: String(record.owner ?? ''),
      destination: String(record.destination ?? ''),
      expiry: Number(record.expiry ?? 0),
      registeredAt: Number(record.registeredAt ?? 0),
      listingPrice: BigInt(String(record.listingPrice ?? 0)),
      listingSeller: String(record.listingSeller ?? ''),
      isActive: Boolean(record.isActive),
      isGrace: Boolean(record.isGrace),
      isAvailable: Boolean(record.isAvailable),
      isReserved: Boolean(record.isReserved),
      isValidLabel: Boolean(record.isValidLabel),
    },
    subdomains: Array.isArray(entry.subdomains) ? entry.subdomains : [],
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isOctraAddress(value: string): boolean {
  return value.startsWith('oct') && value.length === 47
}

function resolveInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const saved = window.localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return 'dark'
}

function clampYears(value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(10, Math.trunc(n)))
}

function blurActiveElement() {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}
