import { describe, expect, it } from 'vitest'

describe('runtime worker entry', () => {
  it('can import the worker module placeholder', async () => {
    const module = await import('../src/worker-entry')

    expect(Object.keys(module)).toStrictEqual([])
  })
})
