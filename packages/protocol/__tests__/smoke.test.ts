import { describe, expectTypeOf, it } from 'vitest'

import type { PlayerEventMap, RivmuxPlayerOptions } from '../src/index'

describe('shared contracts', () => {
  it('exposes the player options contract', () => {
    expectTypeOf<RivmuxPlayerOptions>().toMatchTypeOf<{
      playback?: {
        autoPlay?: boolean
        muted?: boolean
      }
    }>()
  })

  it('exposes the player event map contract', () => {
    expectTypeOf<PlayerEventMap['ready']>().toEqualTypeOf<undefined>()
  })
})
