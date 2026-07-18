// Public surface of the wallet-agnostic layer.

export type {
  DetectedWallet,
  OctraPermission,
  OctraProvider,
  OctraProviderEvent,
  WalletConnection,
  WalletInfo,
} from './types'

export { walletDiscovery } from './discovery'
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
