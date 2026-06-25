import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('rivmux-player packaged runtime assets', () => {
  it('ships the default worker and wasm assets next to the public bundle', async () => {
    const playerDistDir = resolve(process.cwd(), 'packages/player/dist')
    const assets = ['index.js', 'rivmux-runtime-worker.js', 'rivmux_transmux_core.js', 'rivmux_transmux_core_bg.wasm']

    await expect(Promise.all(assets.map((asset) => assertNonEmptyFile(resolve(playerDistDir, asset))))).resolves.toBeDefined()
  })

  it('resolves the default wasm URL from the packaged public bundle', async () => {
    const { DEFAULT_RIVMUX_PLAYER_OPTIONS } = (await import('../../packages/player/dist/index.js')) as typeof import('../../packages/player/dist/index.js')
    const wasmUrl = DEFAULT_RIVMUX_PLAYER_OPTIONS.runtime.wasmUrl

    expect(wasmUrl).toBeDefined()
    expect(new URL(wasmUrl ?? '').pathname).toMatch(/\/packages\/player\/dist\/rivmux_transmux_core_bg\.wasm$/u)
  })
})

async function assertNonEmptyFile(path: string): Promise<void> {
  const stats = await stat(path)
  expect(stats.isFile()).toBe(true)
  expect(stats.size).toBeGreaterThan(0)
}
