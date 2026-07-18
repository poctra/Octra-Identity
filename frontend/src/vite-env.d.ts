/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_RUNTIME?: string
  readonly VITE_BASE_PATH?: string
  readonly VITE_DEV_RPC_UPSTREAM?: string
  readonly VITE_ONS_NETWORK?:  string
  readonly VITE_ONS_CONTRACT?: string
  readonly VITE_ONS_RPC?:      string
  readonly VITE_ONS_EXPLORER?: string
  readonly VITE_ONS_VIEW_CONCURRENCY?: string
  readonly VITE_ONS_PAGE_SIZE?: string
  readonly VITE_ONS_VIEW_RPC_CONCURRENCY?: string
  readonly VITE_ONS_RPC_BATCH_MS?: string
  readonly VITE_ONS_RPC_BATCH_SIZE?: string
  readonly VITE_ONS_RPC_TIMEOUT_MS?: string
  readonly VITE_ONS_VIEW_CACHE_MS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
