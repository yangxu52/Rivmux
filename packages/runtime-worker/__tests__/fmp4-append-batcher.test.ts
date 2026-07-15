import { afterEach, describe, expect, it, vi } from 'vitest'

import { Fmp4AppendBatcher } from '../src/mse/fmp4-append-batcher'

import type { CoreMediaSegment } from '../src/wasm/rivmux-transmux-wasm'

describe('Fmp4AppendBatcher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps same-track batches within the 125 ms media-time target', () => {
    const batcher = new Fmp4AppendBatcher(() => undefined)

    for (let start = 0; start < 120; start += 20) {
      expect(batcher.push(mediaSegment('audio', start, start + 20, [start / 20]))).toBeUndefined()
    }

    expect(batcher.push(mediaSegment('audio', 120, 140, [6]))).toMatchObject({
      track: 'audio',
      dtsStartMs: 0,
      dtsEndMs: 120,
      keyframe: true,
      bytes: new Uint8Array([0, 1, 2, 3, 4, 5]),
    })
    expect(batcher.flush('audio')).toMatchObject({
      dtsStartMs: 120,
      dtsEndMs: 140,
      bytes: new Uint8Array([6]),
    })
  })

  it('flushes a partial batch after 125 ms without another media event', async () => {
    vi.useFakeTimers()
    const dueTracks: CoreMediaSegment['track'][] = []
    const batcher = new Fmp4AppendBatcher((track) => dueTracks.push(track))

    batcher.push(mediaSegment('video', 0, 40, [1]))
    await vi.advanceTimersByTimeAsync(124)
    expect(dueTracks).toStrictEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(dueTracks).toStrictEqual(['video'])
    expect(batcher.flush('video')).toMatchObject({
      track: 'video',
      dtsStartMs: 0,
      dtsEndMs: 40,
      bytes: new Uint8Array([1]),
    })
  })

  it('does not mix tracks and enforces the byte cap before adding the next fragment', () => {
    const batcher = new Fmp4AppendBatcher(() => undefined, { maxBytes: 3 })

    expect(batcher.push(mediaSegment('audio', 0, 20, [1, 2]))).toBeUndefined()
    expect(batcher.push(mediaSegment('video', 0, 40, [9]))).toBeUndefined()
    expect(batcher.push(mediaSegment('audio', 20, 40, [3, 4]))).toMatchObject({
      track: 'audio',
      bytes: new Uint8Array([1, 2]),
    })
    expect(batcher.flush('audio')).toMatchObject({
      track: 'audio',
      bytes: new Uint8Array([3, 4]),
    })
    expect(batcher.flush('video')).toMatchObject({
      track: 'video',
      bytes: new Uint8Array([9]),
    })
  })

  it('cancels pending timer flushes when discarded', async () => {
    vi.useFakeTimers()
    const onFlushDue = vi.fn()
    const batcher = new Fmp4AppendBatcher(onFlushDue)

    batcher.push(mediaSegment('audio', 0, 20, [1]))
    batcher.discard()
    await vi.advanceTimersByTimeAsync(125)

    expect(onFlushDue).not.toHaveBeenCalled()
    expect(batcher.flushAll()).toStrictEqual([])
  })
})

function mediaSegment(track: CoreMediaSegment['track'], dtsStartMs: number, dtsEndMs: number, bytes: number[]): CoreMediaSegment {
  return {
    track,
    dtsStartMs,
    dtsEndMs,
    keyframe: true,
    bytes: new Uint8Array(bytes),
  }
}
