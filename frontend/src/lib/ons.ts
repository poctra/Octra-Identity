import type { ProviderClient } from '../wallets'

import { ONS_CONTRACT } from './constants'
import { isValidLabel } from './format'
import {
  clearContractViewCache,
  getContractReceipt,
  getTransaction,
  mapWithConcurrency,
  viewAddress,
  viewBool,
  viewInt,
  viewString,
  type TxInfo,
} from './rpc'

const VIEW_CONCURRENCY = Math.max(1, Number(import.meta.env.VITE_ONS_VIEW_CONCURRENCY ?? 8) || 8)
export const MANAGED_RESERVED_LABELS = ['root', 'alex', 'lambda', 'lambda0xe', 'bunch', 'octra', 'poctra'] as const

export interface ChainMeta {
  currentEpoch: number
  graceEpochs: number
}

export interface OnsConfig {
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

export async function loadConfig(): Promise<OnsConfig> {
  const loaders: Array<() => Promise<unknown>> = [
    () => viewAddress(ONS_CONTRACT, 'get_owner'),
    () => viewAddress(ONS_CONTRACT, 'get_pending_owner'),
    () => viewBool(ONS_CONTRACT, 'is_paused'),
    () => viewInt(ONS_CONTRACT, 'get_price_per_year'),
    () => viewInt(ONS_CONTRACT, 'get_fee_bps'),
    () => viewInt(ONS_CONTRACT, 'get_grace_epochs'),
    () => viewInt(ONS_CONTRACT, 'get_fees_collected'),
    () => viewInt(ONS_CONTRACT, 'get_total_names'),
    () => viewInt(ONS_CONTRACT, 'get_epoch'),
  ]
  const values = await mapWithConcurrency(loaders, VIEW_CONCURRENCY, (load) => load())
  const [
    admin,
    pendingOwner,
    paused,
    pricePerYear,
    feeBps,
    graceEpochs,
    feesCollected,
    totalNames,
    currentEpoch,
  ] = values as [string, string, boolean, bigint, bigint, bigint, bigint, bigint, bigint]

  return {
    admin,
    pendingOwner,
    paused,
    pricePerYear,
    feeBps: Number(feeBps),
    graceEpochs: Number(graceEpochs),
    feesCollected,
    totalNames: Number(totalNames),
    currentEpoch: Number(currentEpoch),
  }
}

export async function loadName(label: string, meta?: ChainMeta): Promise<NameRecord> {
  const loaders: Array<() => Promise<unknown>> = [
    () => viewAddress(ONS_CONTRACT, 'owner_of', [label]),
    () => viewString(ONS_CONTRACT, 'destination_of', [label]),
    () => viewInt(ONS_CONTRACT, 'expiry_of', [label]),
    () => viewInt(ONS_CONTRACT, 'registered_at', [label]),
    () => viewInt(ONS_CONTRACT, 'listing_price_of', [label]),
    () => viewAddress(ONS_CONTRACT, 'listing_seller_of', [label]),
    () => viewBool(ONS_CONTRACT, 'is_reserved', [label]).catch(() => false),
  ]
  const values = await mapWithConcurrency(loaders, VIEW_CONCURRENCY, (load) => load())
  const [
    owner,
    destination,
    expiry,
    registeredAt,
    listingPrice,
    listingSeller,
    isReserved,
  ] = values as [string, string, bigint, bigint, bigint, string, boolean]
  const currentEpoch = meta?.currentEpoch ?? Number(await viewInt(ONS_CONTRACT, 'get_epoch'))
  const graceEpochs = meta?.graceEpochs ?? Number(await viewInt(ONS_CONTRACT, 'get_grace_epochs'))
  const expiryNumber = Number(expiry)
  const isActive = expiryNumber > 0 && currentEpoch <= expiryNumber
  const isGrace = expiryNumber > 0 && currentEpoch > expiryNumber && currentEpoch <= expiryNumber + graceEpochs

  return {
    label,
    owner,
    destination,
    expiry: expiryNumber,
    registeredAt: Number(registeredAt),
    listingPrice,
    listingSeller,
    isActive,
    isGrace,
    isAvailable: expiryNumber === 0 || currentEpoch > expiryNumber + graceEpochs,
    isReserved,
    isValidLabel: isValidLabel(label),
  }
}

export async function primaryOf(address: string): Promise<string> {
  return viewString(ONS_CONTRACT, 'primary_of', [address])
}

export async function loadOwnerNames(address: string, meta?: ChainMeta): Promise<OwnerEntry[]> {
  if (!address) return []
  const total = Number(await viewInt(ONS_CONTRACT, 'owner_total', [address]))
  if (total <= 0) return []

  const labels = await fetchSlots('owner_key_at', address, total)
  const filtered = labels.filter((label): label is string => Boolean(label))
  return mapWithConcurrency(filtered, VIEW_CONCURRENCY, async (label) => ({
    label,
    record: await loadName(label, meta),
    subdomains: [],
  }))
}

export async function loadSubdomains(parent: string): Promise<SubdomainRecord[]> {
  const total = await viewInt(ONS_CONTRACT, 'subdomain_total', [parent]).catch(() => 0n)
  if (Number(total) <= 0) return []

  const labels = await fetchSlots('subdomain_key_at', parent, Number(total))
  const filtered = labels.filter((label): label is string => Boolean(label))
  return mapWithConcurrency(filtered, VIEW_CONCURRENCY, async (label) => {
    const [destination, registeredAt, isActive] = await Promise.all([
      viewString(ONS_CONTRACT, 'subdomain_destination_of', [parent, label]),
      viewInt(ONS_CONTRACT, 'subdomain_registered_at', [parent, label]),
      viewBool(ONS_CONTRACT, 'is_subdomain_active', [parent, label]),
    ])
    return {
      parent,
      label,
      destination,
      registeredAt: Number(registeredAt),
      isActive,
    }
  })
}

export async function loadActiveListings(): Promise<ListingEntry[]> {
  const total = Number(await viewInt(ONS_CONTRACT, 'listing_total'))
  if (total <= 0) return []

  const labels = await fetchSlots('listing_key_at', null, total)
  const filtered = labels.filter((label): label is string => Boolean(label))
  const listings = await mapWithConcurrency(filtered, VIEW_CONCURRENCY, async (label) => {
    const [price, seller] = await Promise.all([
      viewInt(ONS_CONTRACT, 'listing_price_of', [label]),
      viewAddress(ONS_CONTRACT, 'listing_seller_of', [label]),
    ])
    return { label, owner: seller, seller, price }
  })

  return listings.filter((listing) => listing.price > 0n)
}

async function fetchSlots(method: string, holder: string | null, total: number): Promise<string[]> {
  const slots = Array.from({ length: total }, (_, i) => i)
  return mapWithConcurrency(slots, VIEW_CONCURRENCY, (slot) => {
    const params = holder ? [holder, slot] : [slot]
    return viewString(ONS_CONTRACT, method, params)
  })
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
  clearContractViewCache()
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
  clearContractViewCache()
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
