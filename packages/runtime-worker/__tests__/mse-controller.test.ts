import { afterEach, describe, expect, it, vi } from 'vitest'

import { MseUnsupportedMimeError } from '../src/mse/mime'
import { MseController } from '../src/mse/mse-controller'

describe('MseController SourceBuffer strategy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes audio and video media segments through one muxed SourceBuffer', async () => {
    const registry = installMockMse()
    const controller = new MseController()

    await controller.createMediaSourceHandle()
    await controller.appendInitSegment({
      track: 'muxed',
      codec: 'avc1.42E01E, mp4a.40.2',
      timescale: 1000,
      bytes: new Uint8Array([1, 2, 3]),
    })

    await controller.appendMediaSegment({
      track: 'video',
      dtsStartMs: 0,
      dtsEndMs: 40,
      keyframe: true,
      bytes: new Uint8Array([4, 5, 6]),
    })
    await controller.appendMediaSegment({
      track: 'audio',
      dtsStartMs: 0,
      dtsEndMs: 23,
      keyframe: true,
      bytes: new Uint8Array([7, 8, 9]),
    })
    expect(registry.sourceBuffers).toHaveLength(1)
    expect(registry.sourceBuffers[0]?.mimeType).toBe('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')
    expect(registry.sourceBuffers[0]?.appendCount).toBe(3)
  })

  it('uses separate SourceBuffers for separate video and audio init segments', async () => {
    const registry = installMockMse()
    const controller = new MseController()

    await controller.createMediaSourceHandle()
    await controller.appendInitSegment({
      track: 'video',
      codec: 'avc1.42E01E',
      timescale: 1000,
      bytes: new Uint8Array([1]),
    })
    await controller.appendInitSegment({
      track: 'audio',
      codec: 'mp4a.40.2',
      timescale: 44_100,
      bytes: new Uint8Array([2]),
    })
    await controller.appendMediaSegment({
      track: 'video',
      dtsStartMs: 0,
      dtsEndMs: 33,
      keyframe: true,
      bytes: new Uint8Array([3]),
    })
    await controller.appendMediaSegment({
      track: 'audio',
      dtsStartMs: 0,
      dtsEndMs: 23,
      keyframe: true,
      bytes: new Uint8Array([4]),
    })

    expect(registry.sourceBuffers.map((sourceBuffer) => sourceBuffer.mimeType)).toStrictEqual([
      'video/mp4; codecs="avc1.42E01E"',
      'audio/mp4; codecs="mp4a.40.2"',
    ])
    expect(registry.sourceBuffers.map((sourceBuffer) => sourceBuffer.appendCount)).toStrictEqual([2, 2])
  })

  it('defers codec support checks until an Opus init segment arrives', async () => {
    const registry = installMockMse((mimeType) => mimeType === 'audio/mp4; codecs="opus"')
    const controller = new MseController()

    await controller.createMediaSourceHandle()
    await controller.appendInitSegment({
      track: 'audio',
      codec: 'opus',
      timescale: 48_000,
      bytes: new Uint8Array([1]),
    })

    expect(registry.sourceBuffers.map((sourceBuffer) => sourceBuffer.mimeType)).toStrictEqual(['audio/mp4; codecs="opus"'])
  })

  it('reports the unsupported codec MIME from its init segment', async () => {
    installMockMse(() => false)
    const controller = new MseController()

    await controller.createMediaSourceHandle()
    await expect(
      controller.appendInitSegment({
        track: 'audio',
        codec: 'opus',
        timescale: 48_000,
        bytes: new Uint8Array([1]),
      })
    ).rejects.toEqual(new MseUnsupportedMimeError('audio/mp4; codecs="opus"'))
  })
})

function installMockMse(isTypeSupported: (mimeType: string) => boolean = () => true): MockMseRegistry {
  const registry = new MockMseRegistry()
  vi.stubGlobal('MediaSource', createMockMediaSourceClass(registry, isTypeSupported))
  return registry
}

class MockMseRegistry {
  readonly sourceBuffers: MockSourceBuffer[] = []

  createSourceBuffer(mimeType: string): MockSourceBuffer {
    const sourceBuffer = new MockSourceBuffer(mimeType)
    this.sourceBuffers.push(sourceBuffer)
    return sourceBuffer
  }
}

class MockMediaSource {
  readonly readyState = 'open'
  readonly handle = {} as MediaSourceHandle
  duration = 0

  constructor(private readonly registry: MockMseRegistry) {}

  addSourceBuffer(mimeType: string): SourceBuffer {
    return this.registry.createSourceBuffer(mimeType) as unknown as SourceBuffer
  }

  removeSourceBuffer(): void {}

  addEventListener(): void {}

  removeEventListener(): void {}
}

class MockSourceBuffer {
  updating = false
  buffered = createTimeRanges([])
  appendCount = 0
  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(readonly mimeType: string) {}

  appendBuffer(): void {
    this.appendCount += 1
    this.updating = true
    queueMicrotask(() => this.finishUpdate())
  }

  remove(): void {
    this.updating = true
    queueMicrotask(() => this.finishUpdate())
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private finishUpdate(): void {
    this.updating = false
    for (const listener of this.listeners.get('updateend') ?? []) {
      listener(new Event('updateend'))
    }
  }
}

function createMockMediaSourceClass(registry: MockMseRegistry, isTypeSupported: (mimeType: string) => boolean): typeof MediaSource {
  return class {
    static readonly canConstructInDedicatedWorker = true
    static isTypeSupported(mimeType: string): boolean {
      return isTypeSupported(mimeType)
    }

    constructor() {
      return new MockMediaSource(registry)
    }
  } as unknown as typeof MediaSource
}

function createTimeRanges(ranges: readonly { start: number; end: number }[]): TimeRanges {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index]?.start ?? 0,
    end: (index: number) => ranges[index]?.end ?? 0,
  }
}
