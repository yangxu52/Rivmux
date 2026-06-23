import { describe, expect, it } from 'vitest'

import { RivmuxPlayer } from '../src/index'

describe('RivmuxPlayer smoke', () => {
  it('can construct the public player facade', () => {
    const player = new RivmuxPlayer('https://example.test/live.flv')

    expect(player).toBeInstanceOf(RivmuxPlayer)
    expect(player.url).toBe('https://example.test/live.flv')
  })
})
