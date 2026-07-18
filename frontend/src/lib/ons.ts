import type { ProviderClient } from '../wallets'

import { ONS_CONTRACT } from './constants'
import { isValidLabel } from './format'
import {
  clearContractViewCache,
  getContractReceipt,
  getTransaction,
  mapWithConcurrency,
  viewInt,
  viewString,
  type TxInfo,
} from './rpc'

const VIEW_CONCURRENCY = Math.min(4, Math.max(1, Number(import.meta.env.VITE_ONS_VIEW_CONCURRENCY ?? 4) || 4))
const SNAPSHOT_SCHEMA = 'v1'
const SNAPSHOT_PAGE_SIZE = Math.min(25, Math.max(1, Number(import.meta.env.VITE_ONS_PAGE_SIZE ?? 25) || 25))
const SNAPSHOT_READ_RETRIES = 2
export const MANAGED_RESERVED_LABELS = ['root', 'alex', 'lambda', 'lambda0xe', 'bunch', 'octra', 'poctra'] as const

export interface ChainMeta {
  currentEpoch: number
  graceEpochs: number
}

export interface OnsConfig {
  configVersion: number
  admin: string
  pendingOwner: string
  paused: boolean
  pricePerYear: bigint
  feeBps: number
  graceEpochs: number
  feesCollected: bigint
  totalNames: number
  currentEpoch: number
}

export interface NameRecord {
  label: string
  owner: string
  destination: string
  expiry: number
  registeredAt: number
  listingPrice: bigint
  listingSeller: string
  isActive: boolean
  isGrace: boolean
  isAvailable: boolean
  isReserved: boolean
  isValidLabel: boolean
}

export interface OwnerEntry {
  label: string
  record: NameRecord
  subdomains: SubdomainRecord[]
}

export interface ListingEntry {
  label: string
  owner: string
  seller: string
  price: bigint
}

export interface SubdomainRecord {
  parent: string
  label: string
  destination: string
  registeredAt: number
  isActive: boolean
}

export interface OwnerNamesSnapshot {
  entries: OwnerEntry[]
  primary: string
  version: number
}

interface SnapshotEnvelope {
  header: string[]
  rows: string[][]
}

interface OwnerPage {
  version: number
  next: number
  total: number
  currentEpoch: number
  graceEpochs: number
  primary: string
  entries: OwnerEntry[]
}

interface ListingPage {
  version: number
  next: number
  total: number
  entries: ListingEntry[]
}

interface SubdomainPage {
  version: number
  next: number
  total: number
  entries: SubdomainRecord[]
}

class SnapshotChangedError extends Error {
  constructor() {
    super('On-chain data changed while loading. Retrying with a fresh snapshot.')
    this.name = 'SnapshotChangedError'
  }
}

let listingSnapshotCache: { version: number; entries: ListingEntry[] } | null = null

export async function loadConfig(): Promise<OnsConfig> {
  const payload = await viewString(ONS_CONTRACT, 'get_config_snapshot')
  const { header } = parseSnapshot(payload, 'config')
  if (header.length !== 11) throw new Error('Malformed config snapshot')
  return {
    configVersion: parseSafeNumber(header[1], 'config version'),
    admin: header[2],
    pendingOwner: header[3],
    paused: header[4] === '1',
    pricePerYear: parseBigInt(header[5], 'registration price'),
    feeBps: parseSafeNumber(header[6], 'marketplace fee'),
    graceEpochs: parseSafeNumber(header[7], 'grace epochs'),
    feesCollected: parseBigInt(header[8], 'fees collected'),
    totalNames: parseSafeNumber(header[9], 'total names'),
    currentEpoch: parseSafeNumber(header[10], 'current epoch'),
  }
}

export async function loadName(label: string): Promise<NameRecord> {
  const payload = await viewString(ONS_CONTRACT, 'get_name_snapshot', [label])
  const { header, rows } = parseSnapshot(payload, 'name')
  if (header.length !== 4 || rows.length !== 1) throw new Error('Malformed name snapshot')
  return parseNameRow(rows[0], {
    currentEpoch: parseSafeNumber(header[2], 'current epoch'),
    graceEpochs: parseSafeNumber(header[3], 'grace epochs'),
  })
}

export async function ownerVersionOf(address: string): Promise<number> {
  if (!address) return 0
  return Number(await viewInt(ONS_CONTRACT, 'get_owner_version', [address]))
}

export async function loadOwnerNamesSnapshot(address: string): Promise<OwnerNamesSnapshot> {
  if (!address) return { entries: [], primary: '', version: 0 }
  for (let attempt = 0; attempt < SNAPSHOT_READ_RETRIES; attempt += 1) {
    try {
      return await loadOwnerSnapshotAttempt(address)
    } catch (err) {
      if (!(err instanceof SnapshotChangedError) || attempt === SNAPSHOT_READ_RETRIES - 1) throw err
      clearContractViewCache()
    }
  }
  throw new SnapshotChangedError()
}

async function loadOwnerSnapshotAttempt(address: string): Promise<OwnerNamesSnapshot> {
  const first = parseOwnerPage(
    await viewString(ONS_CONTRACT, 'get_owner_page', [address, 0, SNAPSHOT_PAGE_SIZE, -1]),
  )
  if (first.total <= first.entries.length || first.next >= first.total) {
    return { entries: first.entries, primary: first.primary, version: first.version }
  }

  const cursors = pageCursors(first.next, first.total)
  const snapshotMeta = { currentEpoch: first.currentEpoch, graceEpochs: first.graceEpochs }
  const pages = await mapWithConcurrency(cursors, Math.min(4, VIEW_CONCURRENCY), async (cursor) => {
    const page = parseOwnerPage(
      await viewString(ONS_CONTRACT, 'get_owner_page', [address, cursor, SNAPSHOT_PAGE_SIZE, first.version]),
      snapshotMeta,
    )
    if (page.version !== first.version || page.total !== first.total) throw new SnapshotChangedError()
    return page
  })
  return {
    entries: [...first.entries, ...pages.flatMap((page) => page.entries)],
    primary: first.primary,
    version: first.version,
  }
}

export async function loadSubdomains(parent: string): Promise<SubdomainRecord[]> {
  for (let attempt = 0; attempt < SNAPSHOT_READ_RETRIES; attempt += 1) {
    try {
      return await loadSubdomainSnapshotAttempt(parent)
    } catch (err) {
      if (!(err instanceof SnapshotChangedError) || attempt === SNAPSHOT_READ_RETRIES - 1) throw err
      clearContractViewCache()
    }
  }
  throw new SnapshotChangedError()
}

async function loadSubdomainSnapshotAttempt(parent: string): Promise<SubdomainRecord[]> {
  const first = parseSubdomainPage(
    parent,
    await viewString(ONS_CONTRACT, 'get_subdomain_page', [parent, 0, SNAPSHOT_PAGE_SIZE, -1]),
  )
  if (first.total <= first.entries.length || first.next >= first.total) return first.entries

  const pages = await mapWithConcurrency(pageCursors(first.next, first.total), Math.min(4, VIEW_CONCURRENCY), async (cursor) => {
    const page = parseSubdomainPage(
      parent,
      await viewString(ONS_CONTRACT, 'get_subdomain_page', [parent, cursor, SNAPSHOT_PAGE_SIZE, first.version]),
    )
    if (page.version !== first.version || page.total !== first.total) throw new SnapshotChangedError()
    return page
  })
  return [...first.entries, ...pages.flatMap((page) => page.entries)]
}

export async function loadActiveListings(onProgress?: (entries: ListingEntry[]) => void): Promise<ListingEntry[]> {
  if (listingSnapshotCache) {
    const version = Number(await viewInt(ONS_CONTRACT, 'get_listing_version'))
    if (version === listingSnapshotCache.version) {
      const cached = [...listingSnapshotCache.entries]
      onProgress?.(cached)
      return cached
    }
  }

  for (let attempt = 0; attempt < SNAPSHOT_READ_RETRIES; attempt += 1) {
    try {
      const snapshot = await loadListingSnapshotAttempt(onProgress)
      listingSnapshotCache = { version: snapshot.version, entries: snapshot.entries }
      return [...snapshot.entries]
    } catch (err) {
      if (!(err instanceof SnapshotChangedError) || attempt === SNAPSHOT_READ_RETRIES - 1) throw err
      clearContractViewCache()
    }
  }
  throw new SnapshotChangedError()
}

async function loadListingSnapshotAttempt(
  onProgress?: (entries: ListingEntry[]) => void,
): Promise<{ version: number; entries: ListingEntry[] }> {
  const first = parseListingPage(
    await viewString(ONS_CONTRACT, 'get_listing_page', [0, SNAPSHOT_PAGE_SIZE, -1]),
  )
  onProgress?.([...first.entries])
  if (first.total <= first.entries.length || first.next >= first.total) {
    return { version: first.version, entries: first.entries }
  }

  const loadedPages = new Map<number, ListingPage>()
  const publishProgress = () => {
    const entries = [
      ...first.entries,
      ...[...loadedPages.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, page]) => page.entries),
    ]
    onProgress?.(entries)
  }
  const pages = await mapWithConcurrency(pageCursors(first.next, first.total), Math.min(4, VIEW_CONCURRENCY), async (cursor) => {
    const page = parseListingPage(
      await viewString(ONS_CONTRACT, 'get_listing_page', [cursor, SNAPSHOT_PAGE_SIZE, first.version]),
    )
    if (page.version !== first.version || page.total !== first.total) throw new SnapshotChangedError()
    loadedPages.set(cursor, page)
    publishProgress()
    return page
  })
  return {
    version: first.version,
    entries: [...first.entries, ...pages.flatMap((page) => page.entries)],
  }
}

function parseSnapshot(payload: string, kind: string): SnapshotEnvelope {
  if (!payload || payload === '0' || /^not found$/i.test(payload.trim())) {
    throw new Error(`Snapshot method unavailable: ${kind}`)
  }
  const [rawHeader, ...rawRows] = payload.split('#')
  const header = rawHeader.split('|')
  if (header[0] === 'stale') throw new SnapshotChangedError()
  if (header[0] !== SNAPSHOT_SCHEMA) throw new Error(`Unsupported ${kind} snapshot schema`)
  return { header, rows: rawRows.filter(Boolean).map((row) => row.split('|')) }
}

function parseNameRow(fields: string[], meta: ChainMeta): NameRecord {
  if (fields.length !== 9) throw new Error('Malformed name snapshot row')
  const label = fields[0]
  const expiry = parseSafeNumber(fields[3], 'name expiry')
  const listingPrice = parseBigInt(fields[6], 'listing price')
  const isReserved = fields[8] === '1'
  const valid = isValidLabel(label)
  const isActive = expiry > 0 && meta.currentEpoch <= expiry
  const isGrace = expiry > 0 && meta.currentEpoch > expiry && meta.currentEpoch <= expiry + meta.graceEpochs
  return {
    label,
    owner: fields[1],
    destination: fields[2],
    expiry,
    registeredAt: parseSafeNumber(fields[4], 'registration epoch'),
    listingPrice,
    listingSeller: fields[7],
    isActive,
    isGrace,
    isAvailable: valid && !isReserved && (expiry === 0 || meta.currentEpoch > expiry + meta.graceEpochs),
    isReserved,
    isValidLabel: valid,
  }
}

function parseOwnerPage(payload: string, meta?: ChainMeta): OwnerPage {
  const { header, rows } = parseSnapshot(payload, 'owner page')
  if (header.length !== 7) throw new Error('Malformed owner page header')
  const pageMeta = {
    currentEpoch: meta?.currentEpoch ?? parseSafeNumber(header[4], 'current epoch'),
    graceEpochs: meta?.graceEpochs ?? parseSafeNumber(header[5], 'grace epochs'),
  }
  return {
    version: parseSafeNumber(header[1], 'owner version'),
    next: parseSafeNumber(header[2], 'owner cursor'),
    total: parseSafeNumber(header[3], 'owner total'),
    currentEpoch: pageMeta.currentEpoch,
    graceEpochs: pageMeta.graceEpochs,
    primary: header[6],
    entries: rows.map((row) => {
      const record = parseNameRow(row, pageMeta)
      return { label: record.label, record, subdomains: [] }
    }),
  }
}

function parseListingPage(payload: string): ListingPage {
  const { header, rows } = parseSnapshot(payload, 'listing page')
  if (header.length !== 4) throw new Error('Malformed listing page header')
  return {
    version: parseSafeNumber(header[1], 'listing version'),
    next: parseSafeNumber(header[2], 'listing cursor'),
    total: parseSafeNumber(header[3], 'listing total'),
    entries: rows.map((row) => {
      if (row.length !== 3) throw new Error('Malformed listing snapshot row')
      const price = parseBigInt(row[2], 'listing price')
      return { label: row[0], owner: row[1], seller: row[1], price }
    }).filter((listing) => listing.price > 0n),
  }
}

function parseSubdomainPage(parent: string, payload: string): SubdomainPage {
  const { header, rows } = parseSnapshot(payload, 'subdomain page')
  if (header.length !== 7) throw new Error('Malformed subdomain page header')
  const currentEpoch = parseSafeNumber(header[4], 'current epoch')
  const parentExpiry = parseSafeNumber(header[5], 'parent expiry')
  return {
    version: parseSafeNumber(header[1], 'subdomain version'),
    next: parseSafeNumber(header[2], 'subdomain cursor'),
    total: parseSafeNumber(header[3], 'subdomain total'),
    entries: rows.map((row) => {
      if (row.length !== 3) throw new Error('Malformed subdomain snapshot row')
      return {
        parent,
        label: row[0],
        destination: row[1],
        registeredAt: parseSafeNumber(row[2], 'subdomain registration epoch'),
        isActive: Boolean(row[1]) && parentExpiry > 0 && currentEpoch <= parentExpiry,
      }
    }),
  }
}

function pageCursors(next: number, total: number): number[] {
  const cursors: number[] = []
  for (let cursor = next; cursor < total; cursor += SNAPSHOT_PAGE_SIZE) cursors.push(cursor)
  return cursors
}

function parseSafeNumber(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${field} in contract snapshot`)
  return parsed
}

function parseBigInt(value: string, field: string): bigint {
  try {
    return BigInt(value || '0')
  } catch {
    throw new Error(`Invalid ${field} in contract snapshot`)
  }
}

export function clearOnsSnapshotCache(): void {
  listingSnapshotCache = null
  clearContractViewCache()
}

export interface SendOptions {
  amountOu?: bigint
  ou?: number
  onProgress?: (event: TxProgressEvent) => void
}

export interface SendResult {
  txHash: string
  success: boolean
  revertReason?: string
  epoch?: number
}

export type TxProgressStage = 'submitting' | 'accepted' | 'rejected' | 'confirmed' | 'reverted'

export interface TxProgressEvent {
  stage: TxProgressStage
  txHash?: string
  message?: string
}

export async function sendWrite(
  client: ProviderClient,
  method: string,
  params: unknown[],
  { amountOu = 0n, ou, onProgress }: SendOptions = {},
): Promise<SendResult> {
  clearOnsSnapshotCache()
  onProgress?.({ stage: 'submitting', message: 'Waiting for wallet approval and broadcast.' })
  let result: Awaited<ReturnType<ProviderClient['sendContractTransaction']>>
  try {
    result = await client.sendContractTransaction({
      address: ONS_CONTRACT,
      method,
      params,
      amount: amountOu.toString(),
      fee: ou != null ? String(ou) : undefined,
    })
  } catch (err) {
    onProgress?.({ stage: 'rejected', message: (err as Error).message || 'Transaction rejected.' })
    throw err
  }
  onProgress?.({ stage: 'accepted', txHash: result.hash, message: 'Network accepted the transaction.' })
  const receipt = await waitForReceipt(result.hash, { onProgress })
  clearOnsSnapshotCache()
  return receipt
}

async function waitForReceipt(
  txHash: string,
  {
    timeoutMs = 180000,
    intervalMs = 2000,
    onProgress,
  }: { timeoutMs?: number; intervalMs?: number; onProgress?: (event: TxProgressEvent) => void } = {},
): Promise<SendResult> {
  const start = Date.now()
  let lastTx: TxInfo | null = null

  while (Date.now() - start < timeoutMs) {
    try {
      lastTx = await getTransaction(txHash)
      if (lastTx.status === 'rejected') {
        const receipt = await getContractReceipt(txHash)
        const reason = extractReceiptRevert(receipt) ?? extractRejectReason(lastTx.error)
        onProgress?.({ stage: 'rejected', txHash, message: reason })
        return {
          txHash,
          success: false,
          revertReason: reason,
          epoch: lastTx.epoch ?? lastTx.epoch_id,
        }
      }
      if (lastTx.status === 'confirmed' || lastTx.epoch || lastTx.epoch_id) break
    } catch (err) {
      if (!/not found/i.test((err as Error).message) && Date.now() - start > 10000) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  for (let i = 0; i < 6; i += 1) {
    const receipt = await getContractReceipt(txHash)
    if (receipt) {
      if (receipt.success === false) {
        const reason = extractReceiptRevert(receipt) ?? 'contract call reverted'
        onProgress?.({ stage: 'reverted', txHash, message: reason })
      } else {
        onProgress?.({ stage: 'confirmed', txHash, message: 'Confirmed on-chain.' })
      }
      return {
        txHash,
        success: receipt.success !== false,
        revertReason: receipt.success === false ? (extractReceiptRevert(receipt) ?? 'revert') : undefined,
        epoch: receipt.epoch ?? lastTx?.epoch ?? lastTx?.epoch_id,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  onProgress?.({ stage: 'confirmed', txHash, message: 'Confirmed on-chain.' })
  return { txHash, success: true, epoch: lastTx?.epoch ?? lastTx?.epoch_id }
}

function extractRejectReason(err: TxInfo['error']): string {
  if (!err) return 'tx rejected'
  if (typeof err === 'string') return err
  if (typeof err === 'object' && 'reason' in err && err.reason) return err.reason
  return 'tx rejected'
}

function extractReceiptRevert(receipt: Awaited<ReturnType<typeof getContractReceipt>>): string | undefined {
  if (!receipt) return undefined
  const requireEvent = receipt.events?.find((event) => event.event === 'Require')
  if (requireEvent?.values?.length) return requireEvent.values[0]
  return receipt.error ?? undefined
}

export { ONS_CONTRACT }
