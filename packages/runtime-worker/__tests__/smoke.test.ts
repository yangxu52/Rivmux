import { describe, expect, it } from 'vitest'

describe('runtime worker entry smoke', () => {
  it('can import the worker module without starting a Node worker', async () => {
    const module = await import('../src/worker-entry')

    expect(module.RuntimeWorker).toBeDefined()
    expect(module.createM1StaticFmp4Fixture).toBeDefined()
  })
})
