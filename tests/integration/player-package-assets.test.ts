import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('published player and runtime-worker assets', () => {
  it('keeps the player package focused on the public facade', async () => {
    const playerDistDir = resolve(process.cwd(), 'packages/player/dist')
    const entries = await readdir(playerDistDir)

    await expect(assertNonEmptyFile(resolve(playerDistDir, 'index.js'))).resolves.toBeUndefined()
    expect(entries).not.toContain('rivmux-runtime-worker.js')
    expect(entries.some((entry) => entry.endsWith('.wasm'))).toBe(false)
  })

  it('ships the default worker and wasm assets from the runtime-worker package', async () => {
    const runtimeWorkerDistDir = resolve(process.cwd(), 'packages/runtime-worker/dist')
    const assets = ['index.js', 'rivmux-runtime-worker.js', 'rivmux-transmux-core.wasm']

    await expect(Promise.all(assets.map((asset) => assertNonEmptyFile(resolve(runtimeWorkerDistDir, asset))))).resolves.toBeDefined()
  })

  it('keeps the default wasm asset owned by the worker bundle', async () => {
    const { DEFAULT_RIVMUX_PLAYER_OPTIONS } = (await import('../../packages/player/dist/index.js')) as typeof import('../../packages/player/dist/index.js')

    expect(DEFAULT_RIVMUX_PLAYER_OPTIONS.runtime.wasmUrl).toBeUndefined()
  })
})

async function assertNonEmptyFile(path: string): Promise<void> {
  const stats = await stat(path)
  expect(stats.isFile()).toBe(true)
  expect(stats.size).toBeGreaterThan(0)
}
