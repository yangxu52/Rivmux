import { HttpFlvLoader, HttpFlvLoaderError, isAbortLikeError } from '../loader/http-flv-loader'
import { isRecoverableLoaderError } from '../loader/retry-policy'
import { MseController } from '../mse/mse-controller'
import { MseUnsupportedMimeError } from '../mse/mime'
import { loadWasmTransmuxCoreHost } from '../wasm/wasm-loader'
import { coreErrorToPlayerError, coreMediaInfoToPlayerMediaInfo, coreWarningToPlayerWarning } from '../wasm/rivmux-transmux-wasm'
import { RuntimeAppendController } from './append'
import { raceLifecycleOperation } from './lifecycle'

import type { BufferedRange } from '../latency/buffer-ranges'
import type { StreamLoader, StreamLoaderConfig, StreamLoaderStats } from '../loader/loader'
import type { NormalizedRivmuxPlayerOptions, PlayerError, WorkerMessage } from '@rivmux/protocol'
import type { LifecycleCommandContext } from './lifecycle'
import type { CoreEvent, TransmuxCoreHost } from '../wasm/rivmux-transmux-wasm'
import type { RuntimeMseStatsSnapshot } from './stats'
import type { RuntimeMseController, RuntimeWorkerDependencies } from './types'

type RuntimeSessionMessage = Extract<WorkerMessage, { type: 'media-info' | 'warning' }>

export type RuntimeSessionDependencies = Pick<RuntimeWorkerDependencies, 'createMseController' | 'createLoader' | 'createTransmuxCore'> & {
  isStarted: () => boolean
  isLifecycleContextCurrent: (context: LifecycleCommandContext) => boolean
  onMediaAppended: (context: LifecycleCommandContext) => Promise<void>
  onAppendError: (cause: unknown, context: LifecycleCommandContext) => void
  onLoaderClosing: () => void
  onStats: (stats?: StreamLoaderStats) => void
  onMessage: (message: RuntimeSessionMessage) => void
  onRecoverableFailure: (cause: HttpFlvLoaderError, context: LifecycleCommandContext) => void
  onFailure: (kind: PlayerError['kind'], code: string, message: string, cause?: unknown) => void
  onPlayerError: (error: PlayerError) => void
  applyLatencyPolicy: (context: LifecycleCommandContext) => Promise<void>
  quotaCleanupCutoff: () => number | undefined
}

/** Owns all resources that exist only for an attached playback session. */
export class RuntimeSession {
  private readonly dependencies: RuntimeSessionDependencies
  private readonly createMseController: () => RuntimeMseController
  private readonly createLoader: (config: StreamLoaderConfig) => StreamLoader
  private readonly createTransmuxCore: (options: NormalizedRivmuxPlayerOptions) => TransmuxCoreHost | undefined | Promise<TransmuxCoreHost | undefined>
  private readonly isStarted: () => boolean
  private readonly isLifecycleContextCurrent: (context: LifecycleCommandContext) => boolean
  private mse?: RuntimeMseController
  private loader?: StreamLoader
  private transmuxCore?: TransmuxCoreHost
  private loaderRunId = 0
  private loaderClosePromise?: Promise<void>
  private outputBytes = 0
  private readonly appendController: RuntimeAppendController

  constructor(dependencies: RuntimeSessionDependencies) {
    this.dependencies = dependencies
    this.createMseController = dependencies.createMseController ?? (() => new MseController())
    this.createLoader = dependencies.createLoader ?? ((config) => new HttpFlvLoader(config))
    this.createTransmuxCore = dependencies.createTransmuxCore ?? ((options) => loadWasmTransmuxCoreHost(options.runtime.wasmUrl))
    this.isStarted = dependencies.isStarted
    this.isLifecycleContextCurrent = dependencies.isLifecycleContextCurrent
    this.appendController = new RuntimeAppendController({
      appendToMse: (segment, context) => this.appendToMse(context, () => this.mse?.appendMediaSegment(segment)),
      isStarted: dependencies.isStarted,
      isLifecycleContextCurrent: dependencies.isLifecycleContextCurrent,
      onAppended: async (segment, context) => {
        if (!this.isLifecycleContextCurrent(context)) {
          return
        }
        this.outputBytes += segment.bytes.byteLength
        await dependencies.onMediaAppended(context)
      },
      onError: dependencies.onAppendError,
    })
  }

  get hasMse(): boolean {
    return this.mse !== undefined
  }

  get loaderStats(): StreamLoaderStats | undefined {
    return this.loader?.stats
  }

  get loaderPaused(): boolean {
    return this.loader?.paused ?? false
  }

  get bufferedRanges(): BufferedRange[] {
    return this.mse?.bufferedRanges ?? []
  }

  get emittedBytes(): number {
    return this.outputBytes
  }

  async attach(context: LifecycleCommandContext): Promise<MediaSourceHandle | undefined> {
    this.mse ??= this.createMseController()
    const attachment = await raceLifecycleOperation(this.mse.createMediaSourceHandle(), context.signal)
    if (attachment.cancelled || !this.isLifecycleContextCurrent(context)) {
      return undefined
    }
    return attachment.value
  }

  async createCore(options: NormalizedRivmuxPlayerOptions, context: LifecycleCommandContext): Promise<TransmuxCoreHost | undefined> {
    const creation = await raceLifecycleOperation(Promise.resolve(this.createTransmuxCore(options)), context.signal, (lateCore) => lateCore?.destroy())
    if (creation.cancelled || !this.isLifecycleContextCurrent(context)) {
      return undefined
    }
    return creation.value
  }

  start(core: TransmuxCoreHost, context: LifecycleCommandContext): void {
    this.transmuxCore?.destroy()
    this.transmuxCore = core
    this.outputBytes = 0
    this.appendController.start(context)
  }

  runLoader(config: StreamLoaderConfig, context: LifecycleCommandContext): void {
    const { loader, runId } = this.startLoader(config)
    void this.consumeLoader(loader, runId, context)
  }

  async close(): Promise<void> {
    this.dependencies.onLoaderClosing()
    this.appendController.discard()
    this.transmuxCore?.destroy()
    this.transmuxCore = undefined
    const loader = this.loader
    if (loader === undefined) {
      await this.loaderClosePromise
      return
    }

    this.loader = undefined
    this.loaderRunId += 1
    await this.closeLoaderInstance(loader)
  }

  destroyMse(): void {
    this.mse?.destroy()
    this.mse = undefined
  }

  discardAppend(): void {
    this.appendController.discard()
  }

  collectMseStats(): RuntimeMseStatsSnapshot {
    return {
      appendQueueLength: this.mse?.appendQueueLength ?? 0,
      appendQueueBytes: this.mse?.appendQueueBytes ?? 0,
      sourceBufferUpdating: this.mse?.sourceBufferUpdating ?? false,
      sourceBufferCount: this.mse?.sourceBufferCount ?? 0,
      bufferedRangeCount: this.mse?.bufferedRangeCount ?? 0,
      bufferedStart: this.mse?.bufferedStart,
      bufferedEnd: this.mse?.bufferedEnd,
      bufferedDuration: this.mse?.bufferedDuration,
    }
  }

  cleanupBefore(cutoff: number, force = false): Promise<void> | undefined {
    return this.mse?.cleanupBefore(cutoff, force ? { force: true } : undefined)
  }

  pauseLoader(): void {
    this.loader?.pause()
  }

  resumeLoader(): void {
    this.loader?.resume()
  }

  private startLoader(config: StreamLoaderConfig): { loader: StreamLoader; runId: number } {
    const loader = this.createLoader(config)
    const runId = this.loaderRunId + 1
    this.loaderRunId = runId
    this.loader = loader
    return { loader, runId }
  }

  private pushChunk(bytes: Uint8Array): CoreEvent[] {
    return this.transmuxCore?.pushChunk(bytes) ?? []
  }

  private isCurrentLoader(loader: StreamLoader, runId: number): boolean {
    return this.loader === loader && this.loaderRunId === runId && this.isStarted()
  }

  private async closeCurrentLoader(loader: StreamLoader, runId: number): Promise<void> {
    if (this.loader !== loader || this.loaderRunId !== runId) {
      return
    }

    this.dependencies.onLoaderClosing()
    this.appendController.discard()
    this.loader = undefined
    this.loaderRunId += 1
    this.transmuxCore?.destroy()
    this.transmuxCore = undefined
    await this.closeLoaderInstance(loader)
  }

  private async closeLoaderInstance(loader: StreamLoader): Promise<void> {
    let closing: Promise<void>
    try {
      closing = loader.close()
    } catch (cause) {
      closing = Promise.reject(cause)
    }
    this.loaderClosePromise = closing
    try {
      await closing
    } finally {
      if (this.loaderClosePromise === closing) {
        this.loaderClosePromise = undefined
      }
    }
  }

  private async consumeLoader(loader: StreamLoader, runId: number, context: LifecycleCommandContext): Promise<void> {
    try {
      await loader.open()

      while (this.isCurrentLoader(loader, runId) && this.isLifecycleContextCurrent(context)) {
        await this.dependencies.applyLatencyPolicy(context)
        if (!this.isCurrentLoader(loader, runId) || !this.isLifecycleContextCurrent(context)) {
          return
        }
        const chunk = await loader.read()
        if (chunk === null) {
          if (this.isCurrentLoader(loader, runId) && this.isLifecycleContextCurrent(context)) {
            if (!(await this.appendController.flush(context))) {
              return
            }
            this.dependencies.onStats(loader.stats)
          }
          return
        }
        if (!this.isCurrentLoader(loader, runId) || !this.isLifecycleContextCurrent(context)) {
          return
        }

        this.dependencies.onStats(loader.stats)
        if (!(await this.processEvents(this.pushChunk(chunk.bytes), context))) {
          await this.closeCurrentLoader(loader, runId)
          return
        }
        await this.dependencies.applyLatencyPolicy(context)
        if (!this.isCurrentLoader(loader, runId) || !this.isLifecycleContextCurrent(context)) {
          return
        }
        this.dependencies.onStats(loader.stats)
      }
    } catch (cause) {
      if (!this.isCurrentLoader(loader, runId) || isAbortLikeError(cause)) {
        return
      }

      try {
        await this.closeCurrentLoader(loader, runId)
      } catch {
        // Preserve the original loader failure; cleanup failure is secondary here.
      }
      if (!this.isLifecycleContextCurrent(context)) {
        return
      }
      if (isRecoverableLoaderError(cause)) {
        this.dependencies.onRecoverableFailure(cause, context)
        return
      }
      const code = cause instanceof HttpFlvLoaderError ? cause.code : 'RIVMUX_HTTP_LOADER_FAILED'
      this.dependencies.onFailure('network', code, 'HTTP Fetch loader failed.', cause)
    } finally {
      if (this.isCurrentLoader(loader, runId)) {
        try {
          await this.closeCurrentLoader(loader, runId)
        } catch (cause) {
          if (this.isLifecycleContextCurrent(context)) {
            this.dependencies.onFailure('network', 'RIVMUX_HTTP_LOADER_CLOSE_FAILED', 'HTTP Fetch loader failed to close.', cause)
          }
        }
      }
    }
  }

  private async processEvents(events: CoreEvent[], context: LifecycleCommandContext): Promise<boolean> {
    for (const event of events) {
      if (!this.isLifecycleContextCurrent(context)) {
        return false
      }
      switch (event.type) {
        case 'mediaInfo':
          this.dependencies.onMessage({ type: 'media-info', mediaInfo: coreMediaInfoToPlayerMediaInfo(event.data) })
          break
        case 'warning':
          this.dependencies.onMessage({ type: 'warning', warning: coreWarningToPlayerWarning(event.data) })
          break
        case 'fatalError':
          this.dependencies.onPlayerError(coreErrorToPlayerError(event.data))
          return false
        case 'initSegment':
          if (!(await this.appendController.flush(context))) {
            return false
          }
          if (!(await this.appendToMse(context, () => this.mse?.appendInitSegment(event.data)))) {
            return false
          }
          if (!this.isLifecycleContextCurrent(context)) {
            return false
          }
          this.outputBytes += event.data.bytes.byteLength
          await this.dependencies.applyLatencyPolicy(context)
          break
        case 'mediaSegment': {
          const append = this.appendController.push(event.data, context)
          if (append !== undefined && !(await append)) {
            return false
          }
          break
        }
        case 'probeResult':
        case 'trackConfig':
        case 'sample':
        case 'metadata':
        case 'discontinuity':
          break
      }
    }

    return this.appendController.waitForTail()
  }

  private async appendToMse(context: LifecycleCommandContext, append: () => Promise<void> | undefined): Promise<boolean> {
    try {
      const result = await raceLifecycleOperation(Promise.resolve(append()), context.signal)
      if (result.cancelled || !this.isLifecycleContextCurrent(context)) {
        return false
      }
      return true
    } catch (cause) {
      if (!this.isLifecycleContextCurrent(context)) {
        return false
      }
      if (isQuotaExceededError(cause) && (await this.retryAppendAfterQuotaCleanup(context, append))) {
        return true
      }

      if (cause instanceof MseUnsupportedMimeError) {
        this.dependencies.onFailure('unsupported', 'RIVMUX_UNSUPPORTED_MSE_CODEC', cause.message, cause)
        return false
      }

      this.dependencies.onFailure('mse', 'RIVMUX_MSE_APPEND_FAILED', 'MSE append failed.', cause)
      return false
    }
  }

  private async retryAppendAfterQuotaCleanup(context: LifecycleCommandContext, append: () => Promise<void> | undefined): Promise<boolean> {
    const cutoff = this.dependencies.quotaCleanupCutoff()
    if (cutoff === undefined || cutoff <= 0) {
      return false
    }

    try {
      const cleanup = await raceLifecycleOperation(Promise.resolve(this.cleanupBefore(cutoff, true)), context.signal)
      if (cleanup.cancelled || !this.isLifecycleContextCurrent(context)) {
        return false
      }
      const retry = await raceLifecycleOperation(Promise.resolve(append()), context.signal)
      if (retry.cancelled || !this.isLifecycleContextCurrent(context)) {
        return false
      }
      this.dependencies.onMessage({
        type: 'warning',
        warning: {
          code: 'RIVMUX_MSE_QUOTA_RETRY',
          message: 'MSE quota was exceeded; old buffered ranges were cleaned before retrying append.',
        },
      })
      return true
    } catch {
      return false
    }
  }
}

function isQuotaExceededError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'name' in cause && (cause as { name?: unknown }).name === 'QuotaExceededError'
}
