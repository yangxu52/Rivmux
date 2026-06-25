import { spawn } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wasmPackageDir = resolve(repoRoot, 'target/tmp/rivmux-transmux-core-wasm-pkg')
const playerDistDir = resolve(repoRoot, 'packages/player/dist')
const wasmPackOutDirFromCrate = '../../target/tmp/rivmux-transmux-core-wasm-pkg'

await run('wasm-pack', [
  'build',
  '--target',
  'web',
  '--out-dir',
  wasmPackOutDirFromCrate,
  '--no-pack',
  '--no-typescript',
  '--no-opt',
  'crates/transmux-core',
  '--features',
  'wasm',
])

await mkdir(playerDistDir, { recursive: true })
await Promise.all([
  copyFile(resolve(wasmPackageDir, 'rivmux_transmux_core.js'), resolve(playerDistDir, 'rivmux_transmux_core.js')),
  copyFile(resolve(wasmPackageDir, 'rivmux_transmux_core_bg.wasm'), resolve(playerDistDir, 'rivmux_transmux_core_bg.wasm')),
])

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      reject(new Error(`${command} exited with code ${code ?? 'unknown'}.`))
    })
  })
}
