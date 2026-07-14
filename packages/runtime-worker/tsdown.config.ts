import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'rivmux-runtime-worker': 'src/worker-entry.ts',
  },
  copy: [
    {
      from: '../../crates/transmux-core/dist/rivmux_transmux_core_bg.wasm',
      rename: 'rivmux-transmux-core.wasm',
    },
  ],
  target: 'es2022',
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
