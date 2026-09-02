import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  server: {
    host: process.env.TAURI_DEV_HOST ? '0.0.0.0' : '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      // Rust/Android 构建产物文件极多，纳入 watch 会触发 ENOSPC
      ignored: [
        '**/src-tauri/target/**',
        '**/src-tauri/gen/android/**/build/**',
        '**/src-tauri/gen/android/.gradle/**',
      ],
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2021',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@tiptap') || id.includes('prosemirror')) return 'editor'
        },
      },
    },
  },
})
