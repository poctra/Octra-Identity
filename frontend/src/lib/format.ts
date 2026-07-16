import { EPOCHS_PER_DAY, OU_PER_OCT } from './constants'

export function normalizeLabel(input: string): string {
  return input.trim().toLowerCase().replace(/\.(oct|octra|id)$/i, '')
}

export function isValidLabel(label: string): boolean {
  return /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(label)
}

export function isValidSubLabel(label: string): boolean {
  return /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
}

export function formatOct(ou: bigint): string {
  const sign = ou < 0n ? '-' : ''
  const raw = ou < 0n ? -ou : ou
  const whole = raw / OU_PER_OCT
  const frac = raw % OU_PER_OCT
  const fracText = frac.toString().padStart(6, '0').replace(/0+$/, '')
  return `${sign}${whole.toLocaleString()}${fracText ? `.${fracText}` : ''}`
}

export function parseOctToOu(value: string): bigint {
  const clean = value.trim().replace(/,/g, '')
  if (!clean) return 0n
  const [wholeRaw, fracRaw = ''] = clean.split('.')
  const whole = BigInt(wholeRaw || '0')
  const frac = BigInt((fracRaw + '000000').slice(0, 6))
  return whole * OU_PER_OCT + frac
}

export function shortAddress(address: string, head = 8, tail = 6): string {
  if (!address) return ''
  if (address.length <= head + tail + 3) return address
  return `${address.slice(0, head)}...${address.slice(-tail)}`
}

export function statusForName(record: { isAvailable: boolean; isActive: boolean; isGrace: boolean; owner: string }): string {
  if (record.isAvailable) return 'available'
  if (record.isActive) return 'active'
  if (record.isGrace) return 'grace'
  return record.owner ? 'expired' : 'unknown'
}

export function epochDistance(expiry: number, current: number): string {
  if (!expiry) return 'no expiry'
  const delta = expiry - current
  const abs = Math.abs(delta)
  const days = Math.max(1, Math.round(abs / EPOCHS_PER_DAY))
  return delta >= 0 ? `${days}d left` : `${days}d ago`
}

export function explorerLink(host: string, page: 'address' | 'tx', value: string): string {
  const clean = host.replace(/\/+$/, '')
  const param = page === 'address' ? 'addr' : 'hash'
  return `${clean}/${page}.html?${param}=${encodeURIComponent(value)}`
}
