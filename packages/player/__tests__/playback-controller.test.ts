import { describe, expect, it, vi } from 'vitest'

import { PlaybackController } from '../src/playback-controller'

import type { PlaybackControlAction, PlaybackControlResult } from '@rivmux/protocol'

describe('PlaybackController', () => {
  it('returns an accepted result without an error after applying a control', async () => {
    const controller = new PlaybackController({ autoPlay: true, muted: true })
    const video = createVideo()
    controller.attach(video)

    const result = await controller.applyControl({ type: 'play', reason: 'startup-buffer-ready' })

    expect(video.play).toHaveBeenCalledOnce()
    expect(result).toStrictEqual({ type: 'play', accepted: true })
    expect('error' in result).toBe(false)
  })

  it('preserves a DOMException name and message as clone-safe strings', async () => {
    const controller = new PlaybackController({ autoPlay: true, muted: false })
    const video = createVideo()
    vi.mocked(video.play).mockRejectedValue(new DOMException('Playback requires a user gesture.', 'NotAllowedError'))
    controller.attach(video)

    const result = await controller.applyControl({ type: 'play', reason: 'startup-buffer-ready' })

    expect(result).toStrictEqual({
      type: 'play',
      accepted: false,
      error: {
        name: 'NotAllowedError',
        message: 'Playback requires a user gesture.',
      },
    })
    expect(structuredClone(result)).toStrictEqual(result)
  })

  it('keeps malformed Error fields clone-safe', async () => {
    const controller = new PlaybackController({ autoPlay: true, muted: false })
    const video = createVideo()
    const malformed = new Error('ignored')
    Object.defineProperties(malformed, {
      name: { get: () => 42 },
      message: {
        get: () => {
          throw new Error('message getter failed')
        },
      },
    })
    vi.mocked(video.play).mockRejectedValue(malformed)
    controller.attach(video)

    const result = await controller.applyControl({ type: 'play', reason: 'startup-buffer-ready' })

    expect(result).toStrictEqual({
      type: 'play',
      accepted: false,
      error: { name: '42', message: 'Unknown playback control error.' },
    })
    expect(structuredClone(result)).toStrictEqual(result)
  })

  it.each([
    {
      name: 'seek',
      action: { type: 'seek', targetTime: 4, reason: 'latency-max-exceeded' } as const,
      configure(video: HTMLVideoElement) {
        Object.defineProperty(video, 'currentTime', {
          configurable: true,
          set: () => {
            throw 'seek failed'
          },
        })
      },
    },
    {
      name: 'set-playback-rate',
      action: { type: 'set-playback-rate', playbackRate: 1.05, reason: 'latency-above-target' } as const,
      configure(video: HTMLVideoElement) {
        Object.defineProperty(video, 'playbackRate', {
          configurable: true,
          set: () => {
            throw 42
          },
        })
      },
    },
  ])('normalizes a non-Error value thrown by $name', async ({ action, configure }) => {
    const controller = new PlaybackController({ autoPlay: false, muted: true })
    const video = createVideo()
    controller.attach(video)
    configure(video)

    const result = await controller.applyControl(action as PlaybackControlAction)

    expect(result).toStrictEqual({
      type: action.type,
      accepted: false,
      error: {
        name: 'Error',
        message: action.type === 'seek' ? 'seek failed' : '42',
      },
    })
  })

  it('returns an explicit clone-safe error when no video is attached', async () => {
    const controller = new PlaybackController({ autoPlay: true, muted: false })

    const result: PlaybackControlResult = await controller.applyControl({ type: 'play', reason: 'startup-buffer-ready' })

    expect(result).toStrictEqual({
      type: 'play',
      accepted: false,
      error: {
        name: 'NotAttachedError',
        message: 'No video element is attached.',
      },
    })
    expect(structuredClone(result)).toStrictEqual(result)
  })
})

function createVideo(): HTMLVideoElement {
  return {
    autoplay: false,
    muted: false,
    play: vi.fn(() => Promise.resolve()),
  } as unknown as HTMLVideoElement
}
