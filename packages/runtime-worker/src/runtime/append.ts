import { Fmp4AppendBatcher } from '../mse/fmp4-append-batcher'

import type { LifecycleCommandContext } from './lifecycle'
import type { CoreEvent } from '../wasm/rivmux-transmux-wasm'

type MediaSegment = Extract<CoreEvent, { type: 'mediaSegment' }>['data']
type MediaTrack = MediaSegment['track']

export type RuntimeAppendControllerDependencies = {
  appendToMse: (segment: MediaSegment, context: LifecycleCommandContext) => Promise<boolean>
  isStarted: () => boolean
  isLifecycleContextCurrent: (context: LifecycleCommandContext) => boolean
  onAppended: (segment: MediaSegment, context: LifecycleCommandContext) => Promise<void>
  onError: (cause: unknown, context: LifecycleCommandContext) => void
}

/** Owns fMP4 batching and serialized MSE media-segment appends. */
export class RuntimeAppendController {
  private readonly dependencies: RuntimeAppendControllerDependencies
  private batcher?: Fmp4AppendBatcher
  private generation = 0
  private tail: Promise<boolean> = Promise.resolve(true)

  constructor(dependencies: RuntimeAppendControllerDependencies) {
    this.dependencies = dependencies
  }

  start(context: LifecycleCommandContext): void {
    this.discard()
    this.batcher = new Fmp4AppendBatcher((track) => {
      const batch = this.batcher?.flush(track)
      if (batch !== undefined) {
        void this.enqueue(batch, context)
      }
    })
  }

  push(segment: MediaSegment, context: LifecycleCommandContext): Promise<boolean> | undefined {
    const batch = this.batcher?.push(segment)
    return batch === undefined ? undefined : this.enqueue(batch, context)
  }

  async flush(context: LifecycleCommandContext, track?: MediaTrack): Promise<boolean> {
    const batcher = this.batcher
    if (batcher === undefined) {
      return true
    }

    const batches = track === undefined ? batcher.flushAll() : [batcher.flush(track)].filter((batch): batch is NonNullable<typeof batch> => batch !== undefined)
    for (const batch of batches) {
      if (!(await this.enqueue(batch, context))) {
        return false
      }
    }
    return true
  }

  async waitForTail(): Promise<boolean> {
    return this.tail
  }

  discard(): void {
    this.generation += 1
    this.batcher?.discard()
    this.batcher = undefined
    this.tail = Promise.resolve(true)
  }

  private enqueue(segment: MediaSegment, context: LifecycleCommandContext): Promise<boolean> {
    const generation = this.generation
    const append = this.tail.then(async (previousAppendSucceeded) => {
      if (
        !previousAppendSucceeded ||
        generation !== this.generation ||
        !this.dependencies.isStarted() ||
        !this.dependencies.isLifecycleContextCurrent(context)
      ) {
        return false
      }

      if (!(await this.dependencies.appendToMse(segment, context))) {
        return false
      }

      if (!this.dependencies.isLifecycleContextCurrent(context)) {
        return false
      }
      await this.dependencies.onAppended(segment, context)
      return true
    })
    this.tail = append.catch((cause) => {
      if (this.dependencies.isLifecycleContextCurrent(context)) {
        this.dependencies.onError(cause, context)
      }
      return false
    })
    return this.tail
  }
}
