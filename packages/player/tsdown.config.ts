import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: true,
  fixedExtension: false,
})
