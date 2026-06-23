import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'rivmux-runtime-worker': '../runtime-worker/src/worker-entry.ts',
  },
  format: 'esm',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: true,
  fixedExtension: false,
})
