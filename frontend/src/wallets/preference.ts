// Remember which wallet the user picked last time so reloads reattach
// silently. The key is intentionally per-app so different ONS deployments
// don't fight over the same slot.

const KEY = 'ons.wallet.preferred'

export function loadPreferredWalletId(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}

export function savePreferredWalletId(id: string): void {
  try { localStorage.setItem(KEY, id) } catch { /* ignore */ }
}

export function clearPreferredWalletId(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
