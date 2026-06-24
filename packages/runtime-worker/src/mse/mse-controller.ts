import { M1_VIDEO_MIME, assertMseSupport, createMp4VideoMime } from './mime'
import { SourceBufferQueue } from './source-buffer-queue'

import type { M1StaticFmp4Fixture } from '../fixtures/m1-static-fmp4'
import type { CoreInitSegment, CoreMediaSegment } from '../wasm/rivmux-transmux-wasm'

export class MseController {
  private mediaSource?: MediaSource
  private sourceBuffer?: SourceBuffer
  private queue?: SourceBufferQueue

  get appendQueueLength(): number {
    return this.queue?.length ?? 0
  }

  get sourceBufferUpdating(): boolean {
    return this.queue?.updating ?? false
  }

  get bufferedStart(): number | undefined {
    return this.queue?.bufferedStart
  }

  get bufferedEnd(): number | undefined {
    return this.queue?.bufferedEnd
  }

  get bufferedDuration(): number | undefined {
    return this.queue?.bufferedDuration
  }

  async createMediaSourceHandle(): Promise<MediaSourceHandle> {
    assertMseSupport(M1_VIDEO_MIME)

    const mediaSource = new MediaSource()
    this.mediaSource = mediaSource

    const handle = (mediaSource as MediaSourceWithHandle).handle
    if (handle === undefined) {
      throw new Error('MediaSourceHandle is not available.')
    }

    return handle
  }

  async appendFixture(fixture: M1StaticFmp4Fixture): Promise<void> {
    const mediaSource = this.mediaSource
    if (mediaSource === undefined) {
      throw new Error('MediaSource has not been created.')
    }

    await waitForSourceOpen(mediaSource)

    const sourceBuffer = this.sourceBuffer ?? mediaSource.addSourceBuffer(fixture.mimeType)
    this.sourceBuffer = sourceBuffer
    this.queue ??= new SourceBufferQueue(sourceBuffer)
    await this.queue.append(fixture.initSegment)
    await this.queue.append(fixture.mediaSegment)
    mediaSource.duration = fixture.duration
  }

  async appendInitSegment(segment: CoreInitSegment): Promise<void> {
    if (segment.track !== 'video') {
      throw new Error(`Unsupported init segment track: ${segment.track}.`)
    }

    const mediaSource = this.requireMediaSource()
    const mimeType = createMp4VideoMime(segment.codec)
    assertMseSupport(mimeType)
    await waitForSourceOpen(mediaSource)

    const sourceBuffer = this.sourceBuffer ?? mediaSource.addSourceBuffer(mimeType)
    this.sourceBuffer = sourceBuffer
    this.queue ??= new SourceBufferQueue(sourceBuffer)
    await this.queue.append(toAppendBuffer(segment.bytes))
  }

  async appendMediaSegment(segment: CoreMediaSegment): Promise<void> {
    if (segment.track !== 'video') {
      throw new Error(`Unsupported media segment track: ${segment.track}.`)
    }

    if (this.queue === undefined) {
      throw new Error('Cannot append media segment before init segment.')
    }

    await this.queue.append(toAppendBuffer(segment.bytes))
    const mediaSource = this.requireMediaSource()
    const duration = segment.dtsEndMs / 1000
    if (Number.isFinite(duration) && duration > 0 && mediaSource.readyState === 'open') {
      mediaSource.duration = Math.max(mediaSource.duration, duration)
    }
  }

  reset(): void {
    this.queue?.reset()
  }

  destroy(): void {
    this.queue?.destroy()
    this.queue = undefined

    if (this.mediaSource !== undefined && this.sourceBuffer !== undefined) {
      try {
        this.mediaSource.removeSourceBuffer(this.sourceBuffer)
      } catch {
        // Browser cleanup can race sourceclose during worker termination.
      }
    }

    this.sourceBuffer = undefined
    this.mediaSource = undefined
  }

  private requireMediaSource(): MediaSource {
    if (this.mediaSource === undefined) {
      throw new Error('MediaSource has not been created.')
    }

    return this.mediaSource
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
