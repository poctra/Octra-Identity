export type OctraNetwork = 'devnet' | 'mainnet'
export type AppRuntime = 'web3' | 'circle'

export const APP_RUNTIME: AppRuntime =
  import.meta.env.VITE_APP_RUNTIME === 'circle' ? 'circle' : 'web3'

const NETWORK_ENV = (import.meta.env.VITE_ONS_NETWORK ?? 'devnet').toLowerCase()
export const NETWORK: OctraNetwork = NETWORK_ENV === 'mainnet' ? 'mainnet' : 'devnet'

const DEFAULT_RPC: Record<OctraNetwork, string> = {
  devnet: 'http://165.227.225.79:8080',
  mainnet: 'https://rpc.octra.network',
}

export const DEFAULT_ONS_RPC = DEFAULT_RPC[NETWORK]

const DEFAULT_EXPLORER: Record<OctraNetwork, string> = {
  devnet: 'https://devnet.octrascan.io',
  mainnet: 'https://octrascan.io',
}

const RPC_ENV = import.meta.env.VITE_ONS_RPC?.trim()
export const ONS_RPC: string = import.meta.env.DEV || APP_RUNTIME === 'circle'
  ? ''
  : (RPC_ENV || DEFAULT_RPC[NETWORK])

export const EXPLORER_HOST =
  import.meta.env.VITE_ONS_EXPLORER ?? DEFAULT_EXPLORER[NETWORK]

const requireEnv = (key: 'VITE_ONS_CONTRACT'): string => {
  const value = import.meta.env[key]?.trim()
  if (!value) throw new Error(`${key} must be set in frontend/.env`)
  return value
}

export const ONS_CONTRACT = requireEnv('VITE_ONS_CONTRACT')

export const EPOCHS_PER_DAY = 8640
export const EPOCHS_PER_YEAR = 3153600
export const OU_PER_OCT = 1000000n

export const DEFAULT_PRICE_PER_YEAR_OU = 500000n
export const DEFAULT_FEE_BPS = 250
export const DEFAULT_GRACE_EPOCHS = 259200

export const APP_CIRCLE = 'octra.id'
export const APP_NAME = 'octra.id'
