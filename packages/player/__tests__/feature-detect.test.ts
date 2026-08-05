import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectMainThreadRuntime, getCapabilities, isSupported } from '../src/feature-detect'

function installSupportedGlobals(probe: (mime: string) => boolean = () => true): void {
  class MockResponse {}
  Object.defineProperty(MockResponse.prototype, 'body', { configurable: true, value: null })

  class MockMediaSource {
    static canConstructInDedicatedWorker = true
    static isTypeSupported = probe
  }

  vi.stubGlobal('Worker', class MockWorker {})
  vi.stubGlobal('fetch', vi.fn())
  vi.stubGlobal('Response', MockResponse)
  vi.stubGlobal('ReadableStream', class MockReadableStream {})
  vi.stubGlobal('WebAssembly', { instantiate: vi.fn() })
  vi.stubGlobal('MediaSource', MockMediaSource)
}

describe('detectMainThreadRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires fetch streaming support before worker initialization', () => {
    installSupportedGlobals()
    vi.stubGlobal('fetch', undefined)

    expect(detectMainThreadRuntime()).toMatchObject({
      kind: 'unsupported',
      code: 'RIVMUX_UNSUPPORTED_FETCH',
      terminal: true,
    })
  })

  it('distinguishes worker MSE from a missing MIME type check', () => {
    installSupportedGlobals()
    Object.defineProperty(MediaSource, 'canConstructInDedicatedWorker', { configurable: true, value: false })
    expect(detectMainThreadRuntime()).toMatchObject({ code: 'RIVMUX_UNSUPPORTED_WORKER_MSE' })

    Object.defineProperty(MediaSource, 'canConstructInDedicatedWorker', { configurable: true, value: true })
    Object.defineProperty(MediaSource, 'isTypeSupported', { configurable: true, value: undefined })
    expect(detectMainThreadRuntime()).toMatchObject({ code: 'RIVMUX_UNSUPPORTED_MSE_TYPE_CHECK' })
  })

  it('defers a negative codec MIME result until the stream codec is known', () => {
    installSupportedGlobals(() => false)

    expect(detectMainThreadRuntime()).toBeUndefined()
  })
})

describe('public capabilities', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is SSR safe and reports unavailable decoding probes as unknown', () => {
    vi.stubGlobal('Worker', undefined)
    vi.stubGlobal('fetch', undefined)
    vi.stubGlobal('Response', undefined)
    vi.stubGlobal('ReadableStream', undefined)
    vi.stubGlobal('WebAssembly', undefined)
    vi.stubGlobal('MediaSource', undefined)

    expect(getCapabilities()).toEqual({
      supported: false,
      runtime: {
        dedicatedWorker: false,
        workerMse: false,
        fetchStreaming: false,
        readableStream: false,
        webAssembly: false,
      },
      decoding: {
        video: { avc: 'unknown', hevc: 'unknown', av1: 'unknown' },
        audio: { aac: 'unknown', opus: 'unknown' },
        stableProfiles: { avcAac: 'unknown', hevcAac: 'unknown' },
      },
    })
    expect(isSupported()).toBe(false)
  })

  it('probes only the declared single-codec MIME strings synchronously', () => {
    const probe = vi.fn(() => true)
    installSupportedGlobals(probe)

    expect(getCapabilities().decoding).toEqual({
      video: { avc: 'supported', hevc: 'supported', av1: 'supported' },
      audio: { aac: 'supported', opus: 'supported' },
      stableProfiles: { avcAac: 'supported', hevcAac: 'supported' },
    })
    expect(probe.mock.calls.map(([mime]) => mime)).toEqual([
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="av01.0.08M.08"',
      'audio/mp4; codecs="mp4a.40.2"',
      'audio/mp4; codecs="opus"',
    ])
  })

  it('combines stable profiles from the corresponding single codec statuses', () => {
    installSupportedGlobals((mime) => !mime.includes('hvc1'))

    expect(getCapabilities().decoding).toMatchObject({
      video: { avc: 'supported', hevc: 'unsupported' },
      audio: { aac: 'supported' },
      stableProfiles: { avcAac: 'supported', hevcAac: 'unsupported' },
    })
  })

  it('maps a thrown codec probe to unknown without affecting other entries', () => {
    installSupportedGlobals((mime) => {
      if (mime.includes('av01')) throw new TypeError('probe unavailable')
      return true
    })

    expect(getCapabilities().decoding).toMatchObject({
      video: { avc: 'supported', av1: 'unknown' },
      stableProfiles: { avcAac: 'supported' },
    })
  })

  it('requires Response.body and WebAssembly.instantiate for runtime support', () => {
    installSupportedGlobals()
    vi.stubGlobal('Response', class MockResponse {})
    expect(getCapabilities().runtime.fetchStreaming).toBe(false)

    installSupportedGlobals()
    vi.stubGlobal('WebAssembly', {})
    expect(getCapabilities().runtime.webAssembly).toBe(false)
  })

  it('keeps all throwing global and static getters contained', () => {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      get() {
        throw new Error('host getter failed')
      },
    })

    try {
      expect(getCapabilities().runtime.dedicatedWorker).toBe(false)
      expect(detectMainThreadRuntime()).toMatchObject({ code: 'RIVMUX_UNSUPPORTED_WORKER' })
    } finally {
      if (workerDescriptor === undefined) delete (globalThis as { Worker?: unknown }).Worker
      else Object.defineProperty(globalThis, 'Worker', workerDescriptor)
    }

    installSupportedGlobals()
    Object.defineProperty(MediaSource, 'isTypeSupported', {
      configurable: true,
      get() {
        throw new Error('static getter failed')
      },
    })
    expect(getCapabilities()).toMatchObject({
      supported: false,
      runtime: { workerMse: false },
      decoding: { video: { avc: 'unknown' } },
    })
    expect(detectMainThreadRuntime()).toMatchObject({ code: 'RIVMUX_UNSUPPORTED_MSE_TYPE_CHECK' })
  })

  it('keeps isSupported consistent with getCapabilities().supported', () => {
    installSupportedGlobals()

    expect(isSupported()).toBe(getCapabilities().supported)
    expect(isSupported()).toBe(true)
  })
})
