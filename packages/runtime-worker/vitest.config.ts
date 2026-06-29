import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@rivmux/protocol',
        replacement: fileURLToPath(new URL(`../../packages/protocol/src/index.ts`, import.meta.url)),
      },
      {
        find: '@rivmux/runtime-worker',
        replacement: fileURLToPath(new URL(`../../packages/runtime-worker/src/index.ts`, import.meta.url)),
      },
      {
        find: '@rivmux/transmux-core',
        replacement: new URL('./__tests__/stubs/rivmux-transmux-core.ts', import.meta.url).pathname,
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    passWithNoTests: true,
  },
})
