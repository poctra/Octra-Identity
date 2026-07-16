// Public surface of the wallet-agnostic layer.

export type {
  DetectedWallet,
  OctraPermission,
  OctraProvider,
  OctraProviderEvent,
  WalletConnection,
  WalletInfo,
} from './types'

export { walletDiscovery, listAllowedWallets } from './discovery'
export { getWalletEntry } from './registry'
export {
  ProviderClient,
  type OctraNetworkInfo,
  type OctraTransactionResult,
  type SendContractTxParams,
} from './provider-client'
export {
  loadPreferredWalletId,
  savePreferredWalletId,
  clearPreferredWalletId,
} from './preference'
