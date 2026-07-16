import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Dev-server only: proxy `/rpc` to the upstream Octra node so the browser
// stays same-origin and CORS never enters the picture. Production builds
// hit the RPC directly per VITE_ONS_RPC.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const runtime = env.VITE_APP_RUNTIME === 'circle' ? 'circle' : 'web3'
  const network = (env.VITE_ONS_NETWORK ?? 'devnet').toLowerCase()
  const configuredRpc = env.VITE_ONS_RPC?.trim() ?? ''
  const devUpstream = env.VITE_DEV_RPC_UPSTREAM?.trim() ?? ''
  const upstream = devUpstream || (configuredRpc.startsWith('http') ? configuredRpc : '') ||
    (network === 'mainnet' ? 'https://octra.network' : 'http://165.227.225.79:8080')
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
  const runtimeManifest = {
    runtime,
    network,
    contract: env.VITE_ONS_CONTRACT?.trim() || '',
    explorer: env.VITE_ONS_EXPLORER?.trim() || '',
  }

  return {
    base: env.VITE_BASE_PATH?.trim() || (runtime === 'circle' ? './' : '/'),
    cacheDir: `node_modules/.vite-${runtime}-${network}`,
    plugins: [
      react(),
      {
        name: 'octra-runtime-manifest',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'runtime-config.json',
            source: `${JSON.stringify(runtimeManifest, null, 2)}\n`,
          })
        },
      },
    ],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 4000,
      allowedHosts,
      proxy: {
        // Browser POSTs to http://localhost:4000/rpc → Vite rewrites it
        // to <upstream>/rpc. The Origin header gets stripped by the
        // proxy, so the upstream sees a server-to-server request.
        '/rpc': {
          target:        upstream,
          changeOrigin:  true,
          secure:        upstream.startsWith('https://'),
          // Keep the path verbatim — the upstream node also serves /rpc.
          rewrite:       (p) => p,
        },
      },
    },
  }
})
