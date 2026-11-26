import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@hermes/plugin-sdk': fileURLToPath(new URL('./tests-ui/sdk.js', import.meta.url)) } },
  test: { environment: 'jsdom', include: ['plugins/paper-compare/tests-ui/*.test.js'], testTimeout: 15000 },
})
