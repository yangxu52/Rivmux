import { getBufferedDuration, getBufferedStart, getLiveEdge, normalizeBufferedRanges } from '../latency/buffer-ranges'

import type { BufferedRange } from '../latency/buffer-ranges'

type SourceBufferOperation = { type: 'append'; data: ArrayBuffer } | { type: 'remove'; start: number; end: number }

export class SourceBufferQueue {
  private readonly sourceBuffer: SourceBuffer
  private readonly queue: SourceBufferOperation[] = []
  private pendingDrain?: Promise<void>
  private destroyed = false

  constructor(sourceBuffer: SourceBuffer) {
    this.sourceBuffer = sourceBuffer
  }

  get length(): number {
    return this.queue.length + (this.sourceBuffer.updating ? 1 : 0)
  }

  get updating(): boolean {
    return this.sourceBuffer.updating
  }

  get bufferedRanges(): BufferedRange[] {
    return normalizeBufferedRanges(this.sourceBuffer.buffered)
  }

  get bufferedStart(): number | undefined {
    return getBufferedStart(this.bufferedRanges)
  }

  get bufferedEnd(): number | undefined {
    return getLiveEdge(this.bufferedRanges)
  }

  get bufferedDuration(): number | undefined {
    return getBufferedDuration(this.bufferedRanges)
  }

  append(data: ArrayBuffer): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('SourceBufferQueue has been destroyed.'))
    }

    this.queue.push({ type: 'append', data })
    this.pendingDrain ??= this.drain()
    return this.pendingDrain
  }

  cleanupBefore(cutoff: number): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('SourceBufferQueue has been destroyed.'))
    }

    const removals = this.createCleanupOperations(cutoff)
    if (removals.length === 0) {
      return this.pendingDrain ?? Promise.resolve()
    }

    this.queue.unshift(...removals)
    this.pendingDrain ??= this.drain()
    return this.pendingDrain
  }

  reset(): void {
    this.queue.length = 0
  }

  destroy(): void {
    this.destroyed = true
    this.reset()
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.destroyed) {
        await this.waitForIdle()
        const operation = this.queue.shift()

        if (operation?.type === 'append') {
          this.sourceBuffer.appendBuffer(operation.data)
        } else if (operation?.type === 'remove') {
          this.sourceBuffer.remove(operation.start, operation.end)
        }
      }

      await this.waitForIdle()
    } finally {
      this.pendingDrain = undefined
    }
  }

  private createCleanupOperations(cutoff: number): SourceBufferOperation[] {
    if (!Number.isFinite(cutoff) || cutoff <= 0) {
      return []
    }

    return this.bufferedRanges
      .map((range) => ({ type: 'remove' as const, start: range.start, end: Math.min(range.end, cutoff) }))
      .filter((operation) => operation.end > operation.start)
  }

  private waitForIdle(): Promise<void> {
    if (!this.sourceBuffer.updating) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.sourceBuffer.removeEventListener('updateend', onUpdateEnd)
        this.sourceBuffer.removeEventListener('error', onError)
        this.sourceBuffer.removeEventListener('abort', onAbort)
      }
      const onUpdateEnd = (): void => {
        cleanup()
        resolve()
      }
      const onError = (): void => {
        cleanup()
        reject(new Error('SourceBuffer append failed.'))
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('SourceBuffer append was aborted.'))
      }

      this.sourceBuffer.addEventListener('updateend', onUpdateEnd, { once: true })
      this.sourceBuffer.addEventListener('error', onError, { once: true })
      this.sourceBuffer.addEventListener('abort', onAbort, { once: true })
    })
  }
}
