import { describe, expect, it } from 'vitest'

import { WasmTransmuxCoreHost, coreErrorToPlayerError, coreMediaInfoToPlayerMediaInfo, normalizeCoreEvents } from '../src/wasm/rivmux-transmux-wasm'
import { createWasmTransmuxCoreHost, loadWasmTransmuxCoreHost } from '../src/wasm/wasm-loader'
import { initializedWasmSources, resetInitializedWasmSources } from './stubs/rivmux-transmux-core'

describe('runtime transmux core host', () => {
  it('normalizes wasm event arrays', () => {
    const events = normalizeCoreEvents([
      {
        type: 'mediaInfo',
        data: {
          container: 'flv',
          video: 'avc',
          audio: 'aac',
          videoCodec: 'avc1.42E01E',
          audioCodec: 'mp4a.40.2',
          audioSampleRate: 44_100,
          audioChannelCount: 2,
        },
      },
      {
        type: 'initSegment',
        data: {
          track: 'video',
          codec: 'avc1.42E01E',
          timescale: 1000,
          bytes: new Uint8Array([1, 2, 3]),
        },
      },
      {
        type: 'trackConfig',
        data: { kind: 'video' },
      },
      {
        type: 'sample',
        data: { kind: 'video' },
      },
      {
        type: 'fatalError',
        data: {
          code: 'unsupportedVideoCodec',
          message: 'Unsupported video codec.',
        },
      },
    ])

    expect(events).toStrictEqual([
      {
        type: 'mediaInfo',
        data: {
          container: 'flv',
          video: 'avc',
          audio: 'aac',
          videoCodec: 'avc1.42E01E',
          audioCodec: 'mp4a.40.2',
          audioSampleRate: 44_100,
          audioChannelCount: 2,
        },
      },
      {
        type: 'initSegment',
        data: {
          track: 'video',
          codec: 'avc1.42E01E',
          timescale: 1000,
          bytes: new Uint8Array([1, 2, 3]),
        },
      },
      {
        type: 'trackConfig',
        data: { kind: 'video' },
      },
      {
        type: 'sample',
        data: { kind: 'video' },
      },
      {
        type: 'fatalError',
        data: {
          code: 'unsupportedVideoCodec',
          message: 'Unsupported video codec.',
        },
      },
    ])
  })

  it('maps core media info and errors into player payloads', () => {
    expect(
      coreMediaInfoToPlayerMediaInfo({
        container: 'flv',
        video: 'avc',
        audio: 'aac',
        videoCodec: 'avc1.42E01E',
        audioCodec: 'mp4a.40.2',
        width: 1920,
        height: 1080,
        audioSampleRate: 48_000,
        audioChannelCount: 2,
      })
    ).toStrictEqual({
      container: 'flv',
      videoCodec: 'avc1.42E01E',
      audioCodec: 'mp4a.40.2',
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      audioChannelCount: 2,
    })

    expect(coreErrorToPlayerError({ code: 'unsupportedAudioCodec', message: 'Only AAC-LC is supported.' })).toStrictEqual({
      kind: 'unsupported',
      code: 'RIVMUX_CORE_UNSUPPORTED_AUDIO_CODEC',
      message: 'Only AAC-LC is supported.',
      terminal: true,
    })
  })

  it('wraps a wasm constructor behind the host interface', () => {
    const host = new WasmTransmuxCoreHost(MockWasmTransmuxCore)

    expect(host.pushChunk(new Uint8Array([1, 2]))).toStrictEqual([{ type: 'probeResult', data: { container: 'flv' } }])
    expect(host.flush()).toStrictEqual([])
    host.reset()
    host.destroy()

    expect(MockWasmTransmuxCore.instance?.chunks).toStrictEqual([new Uint8Array([1, 2])])
    expect(MockWasmTransmuxCore.instance?.resetCount).toBe(1)
    expect(MockWasmTransmuxCore.instance?.destroyCount).toBe(1)
  })

  it('creates wasm host when the constructor is available', () => {
    expect(createWasmTransmuxCoreHost(MockWasmTransmuxCore)).toBeInstanceOf(WasmTransmuxCoreHost)
  })

  it('throws when the wasm host constructor is missing', () => {
    expect(() => createWasmTransmuxCoreHost(undefined)).toThrow(TypeError)
    expect(() => createWasmTransmuxCoreHost(undefined)).toThrow('WASM transmux core constructor is not available.')
  })

  it('initializes the wasm-bindgen module with an explicit asset URL', async () => {
    resetInitializedWasmSources()

    const host = await loadWasmTransmuxCoreHost('https://cdn.example.test/rivmux-transmux-core.wasm')

    expect(host).toBeInstanceOf(WasmTransmuxCoreHost)
    expect(initializedWasmSources).toStrictEqual(['https://cdn.example.test/rivmux-transmux-core.wasm'])
  })

  it('uses the packaged Worker-relative WASM asset by default', async () => {
    resetInitializedWasmSources()

    await loadWasmTransmuxCoreHost(undefined)

    const source = initializedWasmSources[0]
    expect(source).toBeInstanceOf(URL)
    expect((source as URL).pathname).toMatch(/rivmux-transmux-core\.wasm$/u)
  })
})

class MockWasmTransmuxCore {
  static instance?: MockWasmTransmuxCore
  readonly chunks: Uint8Array[] = []
  resetCount = 0
  destroyCount = 0

  constructor() {
    MockWasmTransmuxCore.instance = this
  }

  pushChunk(chunk: Uint8Array): unknown {
    this.chunks.push(chunk)
    return [{ type: 'probeResult', data: { container: 'flv' } }]
  }

  flush(): unknown {
    return []
  }

  reset(): void {
    this.resetCount += 1
  }

  destroy(): void {
    this.destroyCount += 1
  }
}
