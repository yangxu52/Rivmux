import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '../../../../crates/transmux-core/pkg/rivmux_transmux_core.js',
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
