import { afterEach, describe, expect, it, vi } from 'vitest'

import { M1_AUDIO_MIME, M1_VIDEO_MIME, detectMainThreadRuntime } from '../src/feature-detect'

describe('detectMainThreadRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires fetch support before worker initialization', () => {
    vi.stubGlobal('Worker', class MockWorker {})
    vi.stubGlobal('fetch', undefined)

    expect(detectMainThreadRuntime()).toMatchObject({
      kind: 'unsupported',
      code: 'RIVMUX_UNSUPPORTED_FETCH',
      terminal: true,
    })
  })

  it('requires M1 video and audio MIME support', () => {
    vi.stubGlobal('Worker', class MockWorker {})
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('ReadableStream', class MockReadableStream {})
    vi.stubGlobal('WebAssembly', {})
    vi.stubGlobal('MediaSource', {
      canConstructInDedicatedWorker: true,
      isTypeSupported: vi.fn((mime: string) => mime === M1_VIDEO_MIME),
    })

    expect(detectMainThreadRuntime()).toMatchObject({
      kind: 'unsupported',
      code: 'RIVMUX_UNSUPPORTED_M1_AUDIO_MIME',
      message: `MSE does not support ${M1_AUDIO_MIME}.`,
      terminal: true,
    })
  })
})
