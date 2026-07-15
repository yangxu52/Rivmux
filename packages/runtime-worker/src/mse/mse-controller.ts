import { assertMseRuntimeSupport, assertMseSupport, createMp4AudioMime, createMp4VideoMime } from './mime'
import { SourceBufferQueue } from './source-buffer-queue'

import type { BufferedRange } from '../latency/buffer-ranges'
import type { CoreInitSegment, CoreMediaSegment } from '../wasm/rivmux-transmux-wasm'

export class MseController {
  private mediaSource?: MediaSource
  private readonly sourceBuffers = new Map<CoreInitSegment['track'], SourceBuffer>()
  private readonly queues = new Map<CoreInitSegment['track'], SourceBufferQueue>()
  private lastCleanupBefore = 0

  get appendQueueLength(): number {
    return Array.from(this.queues.values()).reduce((total, queue) => total + queue.length, 0)
  }

  get appendQueueBytes(): number {
    return Array.from(this.queues.values()).reduce((total, queue) => total + queue.queuedBytes, 0)
  }

  get sourceBufferUpdating(): boolean {
    return Array.from(this.queues.values()).some((queue) => queue.updating)
  }

  get sourceBufferCount(): number {
    return this.sourceBuffers.size
  }

  get bufferedStart(): number | undefined {
    return this.primaryQueue?.bufferedStart
  }

  get bufferedEnd(): number | undefined {
    return this.primaryQueue?.bufferedEnd
  }

  get bufferedDuration(): number | undefined {
    return this.primaryQueue?.bufferedDuration
  }

  get bufferedRanges(): BufferedRange[] {
    return this.primaryQueue?.bufferedRanges ?? []
  }

  get bufferedRangeCount(): number {
    return Array.from(this.queues.values()).reduce((total, queue) => total + queue.bufferedRanges.length, 0)
  }

  async createMediaSourceHandle(): Promise<MediaSourceHandle> {
    assertMseRuntimeSupport()

    const mediaSource = new MediaSource()
    this.mediaSource = mediaSource

    const handle = (mediaSource as MediaSourceWithHandle).handle
    if (handle === undefined) {
      throw new Error('MediaSourceHandle is not available.')
    }

    return handle
  }

  async appendInitSegment(segment: CoreInitSegment): Promise<void> {
    const mediaSource = this.requireMediaSource()
    const mimeType = createMp4Mime(segment.track, segment.codec)
    assertMseSupport(mimeType)
    await waitForSourceOpen(mediaSource)

    const queue = this.ensureQueue(segment.track, mimeType)
    await queue.append(toAppendBuffer(segment.bytes))
  }

  async appendMediaSegment(segment: CoreMediaSegment): Promise<void> {
    const queue = this.queues.get(segment.track)
    if (queue === undefined) {
      throw new Error(`Cannot append ${segment.track} media segment before init segment.`)
    }

    await queue.append(toAppendBuffer(segment.bytes))
    const mediaSource = this.requireMediaSource()
    const duration = segment.dtsEndMs / 1000
    if (Number.isFinite(duration) && duration > 0 && mediaSource.readyState === 'open') {
      mediaSource.duration = Math.max(mediaSource.duration, duration)
    }
  }

  async cleanupBefore(cutoff: number, options: MseCleanupOptions = {}): Promise<void> {
    if (!Number.isFinite(cutoff) || cutoff <= 0 || (!options.force && cutoff <= this.lastCleanupBefore + CLEANUP_STEP_SECONDS)) {
      return
    }

    this.lastCleanupBefore = cutoff
    await Promise.all(Array.from(this.queues.values(), (queue) => queue.cleanupBefore(cutoff)))
  }

  reset(): void {
    for (const queue of this.queues.values()) {
      queue.reset()
    }
    this.lastCleanupBefore = 0
  }

  destroy(): void {
    for (const queue of this.queues.values()) {
      queue.destroy()
    }
    this.queues.clear()

    if (this.mediaSource !== undefined) {
      for (const sourceBuffer of this.sourceBuffers.values()) {
        try {
          this.mediaSource.removeSourceBuffer(sourceBuffer)
        } catch {
          // Browser cleanup can race sourceclose during worker termination.
        }
      }
    }

    this.sourceBuffers.clear()
    this.mediaSource = undefined
  }

  private get primaryQueue(): SourceBufferQueue | undefined {
    return this.queues.get('video') ?? this.queues.get('muxed') ?? this.queues.get('audio')
  }

  private requireMediaSource(): MediaSource {
    if (this.mediaSource === undefined) {
      throw new Error('MediaSource has not been created.')
    }

    return this.mediaSource
  }

  private ensureQueue(track: CoreInitSegment['track'], mimeType: string): SourceBufferQueue {
    const existing = this.queues.get(track)
    if (existing !== undefined) {
      return existing
    }

    const sourceBuffer = this.requireMediaSource().addSourceBuffer(mimeType)
    const queue = new SourceBufferQueue(sourceBuffer)
    this.sourceBuffers.set(track, sourceBuffer)
    this.queues.set(track, queue)
    return queue
  }
}

type MediaSourceWithHandle = MediaSource & {
  readonly handle?: MediaSourceHandle
}

function waitForSourceOpen(mediaSource: MediaSource): Promise<void> {
  if (mediaSource.readyState === 'open') {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      mediaSource.removeEventListener('sourceopen', onOpen)
      mediaSource.removeEventListener('sourceclose', onClose)
      mediaSource.removeEventListener('error', onError)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('MediaSource closed before sourceopen.'))
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('MediaSource failed before sourceopen.'))
    }

    mediaSource.addEventListener('sourceopen', onOpen, { once: true })
    mediaSource.addEventListener('sourceclose', onClose, { once: true })
    mediaSource.addEventListener('error', onError, { once: true })
  })
}

function toAppendBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function createMp4Mime(track: CoreInitSegment['track'], codec: string): string {
  return track === 'audio' ? createMp4AudioMime(codec) : createMp4VideoMime(codec)
}

const CLEANUP_STEP_SECONDS = 0.25

type MseCleanupOptions = {
  force?: boolean
}
