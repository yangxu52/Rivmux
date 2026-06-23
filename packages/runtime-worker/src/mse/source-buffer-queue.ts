export class SourceBufferQueue {
  private readonly sourceBuffer: SourceBuffer
  private readonly queue: ArrayBuffer[] = []
  private pendingAppend?: Promise<void>
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

  get bufferedStart(): number | undefined {
    return this.sourceBuffer.buffered.length === 0 ? undefined : this.sourceBuffer.buffered.start(0)
  }

  get bufferedEnd(): number | undefined {
    const { buffered } = this.sourceBuffer
    return buffered.length === 0 ? undefined : buffered.end(buffered.length - 1)
  }

  get bufferedDuration(): number | undefined {
    const start = this.bufferedStart
    const end = this.bufferedEnd
    return start === undefined || end === undefined ? undefined : Math.max(0, end - start)
  }

  append(data: ArrayBuffer): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('SourceBufferQueue has been destroyed.'))
    }

    this.queue.push(data)
    this.pendingAppend ??= this.drain()
    return this.pendingAppend
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
        const data = this.queue.shift()

        if (data !== undefined) {
          this.sourceBuffer.appendBuffer(data)
        }
      }

      await this.waitForIdle()
    } finally {
      this.pendingAppend = undefined
    }
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
