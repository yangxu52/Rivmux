import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectMainThreadRuntime } from '../src/feature-detect'

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

  it('defers codec MIME support checks until the stream codec is known', () => {
    vi.stubGlobal('Worker', class MockWorker {})
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('ReadableStream', class MockReadableStream {})
    vi.stubGlobal('WebAssembly', {})
    vi.stubGlobal('MediaSource', {
      canConstructInDedicatedWorker: true,
      isTypeSupported: vi.fn(() => false),
    })

    expect(detectMainThreadRuntime()).toBeUndefined()
  })
})
