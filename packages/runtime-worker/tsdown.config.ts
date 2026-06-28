import { defineConfig } from 'tsdown'
import { wasm } from 'rolldown-plugin-wasm'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'rivmux-runtime-worker': 'src/worker-entry.ts',
  },
  plugins: [
    wasm({
      fileName: 'rivmux-transmux-core[extname]',
      targetEnv: 'browser',
    }),
  ],
  format: 'esm',
  platform: 'browser',
  deps: {
    alwaysBundle: ['@rivmux/transmux-core'],
  },
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: true,
  fixedExtension: false,
})
