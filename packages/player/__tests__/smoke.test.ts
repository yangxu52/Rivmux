import { describe, expect, it } from 'vitest'

import { RivmuxPlayer } from '../src/index'

describe('RivmuxPlayer', () => {
  it('can construct the public player placeholder', () => {
    const player = new RivmuxPlayer('https://example.test/live.flv')

    expect(player).toBeInstanceOf(RivmuxPlayer)
    expect(player.url).toBe('https://example.test/live.flv')
  })
})
