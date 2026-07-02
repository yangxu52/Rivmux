import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  target: 'es2022',
  format: 'esm',
  platform: 'browser',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: true,
  fixedExtension: false,
})
