import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import webExtension from 'vite-plugin-web-extension'

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      additionalInputs: ['src/whisper-worker.ts'],
    }),
  ],
  // Prevent Vite from inlining WASM as base64 — let transformers.js load from CDN
  assetsInclude: [],
})
