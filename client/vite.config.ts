import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const serverPort = env.PORT ?? process.env.PORT ?? 3001
  const serverTarget = env.VITE_API_TARGET ?? process.env.VITE_API_TARGET ?? `http://localhost:${serverPort}`

  return {
    plugins: [react(), tailwindcss()],
    base: env.VITE_BASE ?? process.env.VITE_BASE ?? '/',
    envDir: path.resolve(__dirname, '..'),
    define: {
      __SERVER_PORT__: JSON.stringify(String(serverPort)),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: serverTarget,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('Proxy error:', err.message)
            })
            proxy.on('proxyReq', (proxyReq, req) => {
              console.log(`Sending Request to the Target: ${req.method} ${proxyReq.path ?? req.url}`)
            })
            proxy.on('proxyRes', (proxyRes, req) => {
              console.log(`Received Response from the Target: ${proxyRes.statusCode} ${req.url}`)
            })
          },
        },
        '/v1': {
          target: serverTarget,
          changeOrigin: true,
        },
        '/gemini': {
          target: serverTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
