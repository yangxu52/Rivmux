import { LatencyController } from '../latency/latency-controller'
import { HttpFlvLoader, HttpFlvLoaderError, isAbortLikeError } from '../loader/http-flv-loader'
import { Fmp4AppendBatcher } from '../mse/fmp4-append-batcher'
import { MseController } from '../mse/mse-controller'
import { MseUnsupportedMimeError } from '../mse/mime'
import { loadWasmTransmuxCoreHost } from '../wasm/wasm-loader'
import { coreErrorToPlayerError, coreMediaInfoToPlayerMediaInfo, coreWarningToPlayerWarning } from '../wasm/rivmux-transmux-wasm'

import type { BufferedRange } from '../latency/buffer-ranges'
import type { LatencyMetrics } from '../latency/latency-controller'
import type { StreamLoader, StreamLoaderConfig, StreamLoaderStats } from '../loader/loader'
import type { NormalizedRivmuxPlayerOptions, PlayerError, VideoElementState, WorkerCommand, WorkerMessage } from '@rivmux/protocol'
import type { CoreEvent, TransmuxCoreHost } from '../wasm/rivmux-transmux-wasm'

type RuntimeState = 'idle' | 'ready' | 'attached' | 'started' | 'stopped' | 'destroyed' | 'fatal-error'
type LifecycleCommandContext = {
  generation: number
  signal: AbortSignal
}
type RuntimeMseCleanupOptions = {
  force?: boolean
}

export type RuntimeWorkerPort = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void
  close(): void
}

export type RuntimeMseController = {
  readonly appendQueueLength: number
  readonly appendQueueBytes: number
  readonly sourceBufferUpdating: boolean
  readonly sourceBufferCount: number
  readonly bufferedStart: number | undefined
  readonly bufferedEnd: number | undefined
  readonly bufferedDuration: number | undefined
  readonly bufferedRanges: BufferedRange[]
  readonly bufferedRangeCount: number
  createMediaSourceHandle(): Promise<MediaSourceHandle>
  appendInitSegment(segment: Extract<CoreEvent, { type: 'initSegment' }>['data']): Promise<void>
  appendMediaSegment(segment: Extract<CoreEvent, { type: 'mediaSegment' }>['data']): Promise<void>
  cleanupBefore(cutoff: number, options?: RuntimeMseCleanupOptions): Promise<void>
  destroy(): void
}

export type RuntimeWorkerDependencies = {
  createMseController?: () => RuntimeMseController
  createLoader?: (config: StreamLoaderConfig) => StreamLoader
  createTransmuxCore?: (options: NormalizedRivmuxPlayerOptions) => TransmuxCoreHost | undefined | Promise<TransmuxCoreHost | undefined>
  detectRuntime?: () => PlayerError | undefined
  now?: () => number
}

export class RuntimeWorker {
  private readonly port: RuntimeWorkerPort
  private readonly createMseController: () => RuntimeMseController
  private readonly createLoader: (config: StreamLoaderConfig) => StreamLoader
  private readonly createTransmuxCore: (options: NormalizedRivmuxPlayerOptions) => TransmuxCoreHost | undefined | Promise<TransmuxCoreHost | undefined>
  private readonly detectRuntime: () => PlayerError | undefined
  private readonly now: () => number
  private state: RuntimeState = 'idle'
  private url?: string
  private options?: NormalizedRivmuxPlayerOptions
  private mse?: RuntimeMseController
  private loader?: StreamLoader
  private transmuxCore?: TransmuxCoreHost
  private latencyController?: LatencyController
  private videoState?: VideoElementState
  private lastLatencyMetrics: LatencyMetrics = {}
  private statsTimer?: ReturnType<typeof setInterval>
  private statsTickInFlight = false
  private loaderRunId = 0
  private outputBytes = 0
  private appendQueueMaxLength = 0
  private appendQueueMaxBytes = 0
  private fmp4AppendBatcher?: Fmp4AppendBatcher
  private fmp4AppendGeneration = 0
  private fmp4AppendTail: Promise<boolean> = Promise.resolve(true)
  private commandTail: Promise<void> = Promise.resolve()
  private lifecycleGeneration = 0
  private lifecycleAbortController = new AbortController()
  private loaderClosePromise?: Promise<void>
  private fatalCleanupPromise: Promise<void> = Promise.resolve()

  constructor(port: RuntimeWorkerPort, dependencies: RuntimeWorkerDependencies = {}) {
    this.port = port
    this.createMseController = dependencies.createMseController ?? (() => new MseController())
    this.createLoader = dependencies.createLoader ?? ((config) => new HttpFlvLoader(config))
    this.createTransmuxCore = dependencies.createTransmuxCore ?? ((options) => loadWasmTransmuxCoreHost(options.runtime.wasmUrl))
    this.detectRuntime = dependencies.detectRuntime ?? detectWorkerRuntime
    this.now = dependencies.now ?? (() => performance.now())
  }

  handleCommand(command: WorkerCommand): Promise<void> {
    if (command.type === 'stop' || command.type === 'destroy') {
      this.lifecycleGeneration += 1
      this.lifecycleAbortController.abort()
      this.lifecycleAbortController = new AbortController()
    }

    const context = {
      generation: this.lifecycleGeneration,
      signal: this.lifecycleAbortController.signal,
    }
    const handling = this.commandTail.then(() => this.executeCommand(command, context))
    this.commandTail = handling.catch(() => undefined)
    return handling
  }

  private async executeCommand(command: WorkerCommand, context: LifecycleCommandContext): Promise<void> {
    if (this.state === 'destroyed') {
      return
    }

    if ((command.type === 'attach-media-source' || command.type === 'start') && !this.isLifecycleContextCurrent(context)) {
      return
    }

    if (this.state === 'fatal-error') {
      if (command.type === 'stop') {
        this.post({ type: 'stopped' })
      }
      if (command.type !== 'destroy') {
        return
      }
    }

    try {
      switch (command.type) {
        case 'init':
          {
            const runtimeError = this.detectRuntime()
            if (runtimeError !== undefined) {
              this.failWithError(runtimeError)
              return
            }
          }
          this.url = command.url
          this.options = command.options
          this.latencyController = createLatencyController(command.options)
          this.state = 'ready'
          this.post({ type: 'ready' })
          return
        case 'attach-media-source':
          await this.attachMediaSource(context)
          return
        case 'start':
          await this.start(context)
          return
        case 'stop':
          await this.stop()
          return
        case 'update-options':
          this.options = this.options === undefined ? undefined : mergeOptions(this.options, command.options)
          if (this.options !== undefined) {
            this.latencyController = createLatencyController(this.options)
          }
          return
        case 'video-state':
          this.videoState = command.state
          {
            const policy = await raceLifecycleOperation(this.applyLatencyPolicy(context), context.signal)
            if (!policy.cancelled && this.isLifecycleContextCurrent(context) && this.state === 'started') {
              this.postStats()
            }
          }
          return
        case 'playback-control-result':
          this.latencyController?.recordPlaybackControlResult(command.result)
          return
        case 'destroy':
          await this.destroy()
          return
      }
    } catch (cause) {
      this.fail('runtime', 'RIVMUX_WORKER_COMMAND_FAILED', 'Worker command failed.', true, cause)
    }
  }

  private async attachMediaSource(context: LifecycleCommandContext): Promise<void> {
    if (this.state === 'idle') {
      this.fail('runtime', 'RIVMUX_WORKER_NOT_INITIALIZED', 'Worker must be initialized before attach.', true)
      return
    }

    if (this.mse === undefined) {
      this.mse = this.createMseController()
    }

    try {
      const attachment = await raceLifecycleOperation(this.mse.createMediaSourceHandle(), context.signal)
      if (attachment.cancelled || context.generation !== this.lifecycleGeneration) {
        return
      }
      const handle = attachment.value
      this.post({ type: 'media-source-handle', handle }, [handle])
      this.state = 'attached'
    } catch (cause) {
      if (context.generation !== this.lifecycleGeneration) {
        return
      }
      this.fail('mse', 'RIVMUX_MSE_ATTACH_FAILED', 'MSE media source attachment failed.', true, cause)
    }
  }

  private async start(context: LifecycleCommandContext): Promise<void> {
    const options = this.options
    if (this.mse === undefined || options === undefined || this.state === 'idle' || this.state === 'ready') {
      this.fail('runtime', 'RIVMUX_WORKER_START_REQUIRES_ATTACH', 'Worker start requires an attached MediaSource.', true)
      return
    }

    if (this.state === 'started') {
      return
    }

    let transmuxCore: TransmuxCoreHost
    try {
      const creationPromise = Promise.resolve(this.createTransmuxCore(options))
      const creation = await raceLifecycleOperation(creationPromise, context.signal, (lateCore) => lateCore?.destroy())
      if (creation.cancelled || context.generation !== this.lifecycleGeneration) {
        return
      }
      const createdCore = creation.value
      if (createdCore === undefined) {
        this.fail('runtime', 'RIVMUX_TRANSMUX_CORE_UNAVAILABLE', 'Transmux core is not available.', true)
        return
      }
      transmuxCore = createdCore
    } catch (cause) {
      if (context.generation !== this.lifecycleGeneration) {
        return
      }
      this.fail('runtime', 'RIVMUX_TRANSMUX_CORE_UNAVAILABLE', 'Transmux core is not available.', true, cause)
      return
    }

    this.transmuxCore?.destroy()
    this.transmuxCore = transmuxCore
    this.startFmp4AppendBatcher(context)
    this.state = 'started'
    this.outputBytes = 0
    this.appendQueueMaxLength = 0
    this.appendQueueMaxBytes = 0
    const initialPolicy = await raceLifecycleOperation(this.applyLatencyPolicy(context), context.signal)
    if (initialPolicy.cancelled || !this.isLifecycleContextCurrent(context)) {
      return
    }
    this.startStatsTimer()
    this.postStats()
    this.startLoader(context)
  }

  private async stop(): Promise<void> {
    await this.closeLoader()
    this.mse?.destroy()
    this.mse = undefined
    this.latencyController?.reset()
    this.videoState = undefined
    this.lastLatencyMetrics = {}
    this.state = 'stopped'
    this.post({ type: 'stopped' })
  }

  private async destroy(): Promise<void> {
    await this.fatalCleanupPromise
    await this.closeLoader()
    this.mse?.destroy()
    this.mse = undefined
    this.latencyController?.reset()
    this.videoState = undefined
    this.lastLatencyMetrics = {}
    this.state = 'destroyed'
    this.post({ type: 'destroyed' })
    this.port.close()
  }

  private startLoader(context: LifecycleCommandContext): void {
    const options = this.options
    const url = this.url
    if (options === undefined || url === undefined) {
      this.fail('runtime', 'RIVMUX_WORKER_NOT_INITIALIZED', 'Worker must be initialized before loader start.', true)
      return
    }

    const loader = this.createLoader({
      url,
      network: options.network,
    })
    const runId = this.loaderRunId + 1
    this.loaderRunId = runId
    this.loader = loader

    void this.runLoader(loader, runId, context)
  }

  private async runLoader(loader: StreamLoader, runId: number, context: LifecycleCommandContext): Promise<void> {
    try {
      await loader.open()

      while (this.isCurrentLoader(loader, runId) && this.isLifecycleContextCurrent(context)) {
        await this.applyLatencyPolicy(context)
        if (!this.isCurrentLoader(loader, runId) || !this.isLifecycleContextCurrent(context)) {
          return
        }
        const chunk = await loader.read()
        if (chunk === null || !this.isCurrentLoader(loader, runId) || !this.isLifecycleContextCurrent(context)) {
          break
        }

        this.postStats(loader.stats)
        if (!(await this.processTransmuxEvents(this.transmuxCore?.pushChunk(chunk.bytes) ?? [], context))) {
          await this.closeCurrentLoader(loader, runId)
          return
        }
        await this.applyLatencyPolicy(context)
        if (!this.isCurrentLoader(loader, runId) || !this.isLifecycleContextCurrent(context)) {
          return
        }
        this.postStats(loader.stats)
      }

      if (this.isCurrentLoader(loader, runId) && this.isLifecycleContextCurrent(context)) {
        if (!(await this.flushFmp4AppendBatches(context))) {
          return
        }
        this.postStats(loader.stats)
      }
    } catch (cause) {
      if (!this.isCurrentLoader(loader, runId) || isAbortLikeError(cause)) {
        return
      }

      await this.closeCurrentLoader(loader, runId)
      this.fail('network', getNetworkErrorCode(cause), 'HTTP Fetch loader failed.', true, cause)
      return
    } finally {
      if (this.isCurrentLoader(loader, runId)) {
        await this.closeCurrentLoader(loader, runId)
      }
    }
  }

  private async closeLoader(): Promise<void> {
    this.stopStatsTimer()
    this.discardFmp4AppendBatches()
    this.transmuxCore?.destroy()
    this.transmuxCore = undefined
    const loader = this.loader
    if (loader === undefined) {
      await this.loaderClosePromise
      return
    }

    this.loader = undefined
    this.loaderRunId += 1
    const closing = loader.close()
    this.loaderClosePromise = closing
    try {
      await closing
    } finally {
      if (this.loaderClosePromise === closing) {
        this.loaderClosePromise = undefined
      }
    }
  }

  private async closeCurrentLoader(loader: StreamLoader, runId: number): Promise<void> {
    if (this.loader !== loader || this.loaderRunId !== runId) {
      return
    }

    this.stopStatsTimer()
    this.discardFmp4AppendBatches()
    this.loader = undefined
    this.loaderRunId += 1
    this.transmuxCore?.destroy()
    this.transmuxCore = undefined
    await loader.close()
  }

  private isCurrentLoader(loader: StreamLoader, runId: number): boolean {
    return this.loader === loader && this.loaderRunId === runId && this.state === 'started'
  }

  private postStats(loaderStats?: StreamLoaderStats): void {
    const metrics = this.lastLatencyMetrics
    const mseStats = this.collectMseStats()
    const loaderSnapshot = loaderStats ?? this.loader?.stats
    this.post({
      type: 'stats',
      stats: {
        bytesReceived: loaderSnapshot?.bytesReceived ?? 0,
        currentNetworkSpeed: loaderSnapshot?.currentNetworkSpeed ?? 0,
        networkIdleMs: getNetworkIdleMs(loaderSnapshot, this.now()),
        outputBytes: this.outputBytes,
        appendQueueLength: mseStats.appendQueueLength,
        appendQueueBytes: mseStats.appendQueueBytes,
        appendQueueMaxLength: this.appendQueueMaxLength,
        appendQueueMaxBytes: this.appendQueueMaxBytes,
        loaderPaused: this.loader?.paused ?? false,
        sourceBufferUpdating: mseStats.sourceBufferUpdating,
        sourceBufferCount: mseStats.sourceBufferCount,
        bufferedStart: metrics.bufferedStart ?? this.mse?.bufferedStart,
        bufferedEnd: metrics.bufferedEnd ?? this.mse?.bufferedEnd,
        bufferedDuration: metrics.bufferedDuration ?? this.mse?.bufferedDuration,
        bufferedRangeCount: mseStats.bufferedRangeCount,
        currentTime: metrics.currentTime,
        liveLatency: metrics.liveLatency,
        playbackRate: metrics.playbackRate,
        readyState: metrics.readyState,
        droppedFrames: metrics.droppedFrames,
      },
    })
  }

  private async processTransmuxEvents(events: CoreEvent[], context: LifecycleCommandContext): Promise<boolean> {
    for (const event of events) {
      if (!this.isLifecycleContextCurrent(context)) {
        return false
      }
      switch (event.type) {
        case 'mediaInfo':
          this.post({ type: 'media-info', mediaInfo: coreMediaInfoToPlayerMediaInfo(event.data) })
          break
        case 'warning':
          this.post({ type: 'warning', warning: coreWarningToPlayerWarning(event.data) })
          break
        case 'fatalError':
          this.failWithError(coreErrorToPlayerError(event.data))
          return false
        case 'initSegment':
          if (!(await this.flushFmp4AppendBatches(context))) {
            return false
          }
          if (!(await this.appendToMse(context, () => this.mse?.appendInitSegment(event.data)))) {
            return false
          }
          if (!this.isLifecycleContextCurrent(context)) {
            return false
          }
          this.outputBytes += event.data.bytes.byteLength
          await this.applyLatencyPolicy(context)
          break
        case 'mediaSegment':
          {
            const batch = this.fmp4AppendBatcher?.push(event.data)
            if (batch !== undefined && !(await this.enqueueFmp4AppendBatch(batch, context))) {
              return false
            }
          }
          break
        case 'probeResult':
        case 'trackConfig':
        case 'sample':
        case 'metadata':
        case 'discontinuity':
          break
      }
    }

    return this.fmp4AppendTail
  }

  private startFmp4AppendBatcher(context: LifecycleCommandContext): void {
    this.discardFmp4AppendBatches()
    this.fmp4AppendTail = Promise.resolve(true)
    this.fmp4AppendBatcher = new Fmp4AppendBatcher((track) => {
      const batch = this.fmp4AppendBatcher?.flush(track)
      if (batch !== undefined) {
        void this.enqueueFmp4AppendBatch(batch, context)
      }
    })
  }

  private async flushFmp4AppendBatches(
    context: LifecycleCommandContext,
    track?: Extract<CoreEvent, { type: 'mediaSegment' }>['data']['track']
  ): Promise<boolean> {
    const batcher = this.fmp4AppendBatcher
    if (batcher === undefined) {
      return true
    }

    const batches = track === undefined ? batcher.flushAll() : [batcher.flush(track)].filter((batch): batch is NonNullable<typeof batch> => batch !== undefined)
    for (const batch of batches) {
      if (!(await this.enqueueFmp4AppendBatch(batch, context))) {
        return false
      }
    }
    return true
  }

  private enqueueFmp4AppendBatch(segment: Extract<CoreEvent, { type: 'mediaSegment' }>['data'], context: LifecycleCommandContext): Promise<boolean> {
    const generation = this.fmp4AppendGeneration
    const append = this.fmp4AppendTail.then(async (previousAppendSucceeded) => {
      if (!previousAppendSucceeded || generation !== this.fmp4AppendGeneration || this.state !== 'started' || !this.isLifecycleContextCurrent(context)) {
        return false
      }

      if (!(await this.appendToMse(context, () => this.mse?.appendMediaSegment(segment)))) {
        return false
      }

      if (!this.isLifecycleContextCurrent(context)) {
        return false
      }
      this.outputBytes += segment.bytes.byteLength
      await this.applyLatencyPolicy(context)
      return true
    })
    this.fmp4AppendTail = append.catch((cause) => {
      if (this.isLifecycleContextCurrent(context)) {
        this.fail('mse', 'RIVMUX_MSE_APPEND_FAILED', 'MSE append failed.', true, cause)
      }
      return false
    })
    return this.fmp4AppendTail
  }

  private discardFmp4AppendBatches(): void {
    this.fmp4AppendGeneration += 1
    this.fmp4AppendBatcher?.discard()
    this.fmp4AppendBatcher = undefined
    this.fmp4AppendTail = Promise.resolve(true)
  }

  private collectMseStats(): {
    appendQueueLength: number
    appendQueueBytes: number
    sourceBufferUpdating: boolean
    sourceBufferCount: number
    bufferedRangeCount: number
  } {
    const appendQueueLength = this.mse?.appendQueueLength ?? 0
    const appendQueueBytes = this.mse?.appendQueueBytes ?? 0
    this.appendQueueMaxLength = Math.max(this.appendQueueMaxLength, appendQueueLength)
    this.appendQueueMaxBytes = Math.max(this.appendQueueMaxBytes, appendQueueBytes)

    return {
      appendQueueLength,
      appendQueueBytes,
      sourceBufferUpdating: this.mse?.sourceBufferUpdating ?? false,
      sourceBufferCount: this.mse?.sourceBufferCount ?? 0,
      bufferedRangeCount: this.mse?.bufferedRangeCount ?? 0,
    }
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
        this.fail('unsupported', 'RIVMUX_UNSUPPORTED_MSE_CODEC', cause.message, true, cause)
        return false
      }

      this.fail('mse', 'RIVMUX_MSE_APPEND_FAILED', 'MSE append failed.', true, cause)
      return false
    }
  }

  private async retryAppendAfterQuotaCleanup(context: LifecycleCommandContext, append: () => Promise<void> | undefined): Promise<boolean> {
    const mse = this.mse
    const cutoff = this.quotaCleanupCutoff()
    if (mse === undefined || cutoff === undefined || cutoff <= 0) {
      return false
    }

    try {
      const cleanup = await raceLifecycleOperation(mse.cleanupBefore(cutoff, { force: true }), context.signal)
      if (cleanup.cancelled || !this.isLifecycleContextCurrent(context)) {
        return false
      }
      const retry = await raceLifecycleOperation(Promise.resolve(append()), context.signal)
      if (retry.cancelled || !this.isLifecycleContextCurrent(context)) {
        return false
      }
      this.post({
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

  private quotaCleanupCutoff(): number | undefined {
    const backwardBuffer = this.options?.latency.backwardBuffer ?? 0
    const currentTime = this.videoState?.currentTime
    if (currentTime !== undefined && Number.isFinite(currentTime)) {
      return Math.max(0, currentTime - backwardBuffer)
    }

    const bufferedEnd = this.mse?.bufferedEnd
    return bufferedEnd === undefined ? undefined : Math.max(0, bufferedEnd - backwardBuffer)
  }

  private async applyLatencyPolicy(context?: LifecycleCommandContext): Promise<void> {
    const latencyController = this.latencyController
    const mse = this.mse
    if (latencyController === undefined || mse === undefined) {
      return
    }

    const loader = this.loader
    const evaluation = latencyController.evaluate({
      ranges: mse.bufferedRanges,
      videoState: this.videoState,
      loaderPaused: loader?.paused ?? false,
      nowMs: this.now(),
    })
    this.lastLatencyMetrics = evaluation.metrics

    if (evaluation.cleanupBefore !== undefined) {
      await mse.cleanupBefore(evaluation.cleanupBefore)
    }

    if (context !== undefined && !this.isLifecycleContextCurrent(context)) {
      return
    }

    if (loader !== undefined && evaluation.loaderCommand === 'pause') {
      loader.pause()
    } else if (loader !== undefined && evaluation.loaderCommand === 'resume') {
      loader.resume()
    }

    if (evaluation.playbackControl !== undefined) {
      this.post({ type: 'playback-control', action: evaluation.playbackControl })
    }
  }

  private startStatsTimer(): void {
    this.stopStatsTimer()
    const intervalMs = this.options?.diagnostics.statsIntervalMs
    if (intervalMs === undefined || intervalMs <= 0) {
      return
    }

    this.statsTimer = setInterval(() => {
      void this.emitStatsTick()
    }, intervalMs)
  }

  private stopStatsTimer(): void {
    if (this.statsTimer === undefined) {
      return
    }

    clearInterval(this.statsTimer)
    this.statsTimer = undefined
    this.statsTickInFlight = false
  }

  private async emitStatsTick(): Promise<void> {
    if (this.statsTickInFlight || this.state !== 'started') {
      return
    }

    this.statsTickInFlight = true
    const context = this.currentLifecycleContext()
    try {
      const policy = await raceLifecycleOperation(this.applyLatencyPolicy(context), context.signal)
      if (!policy.cancelled && this.isLifecycleContextCurrent(context) && this.state === 'started') {
        this.postStats()
      }
    } catch (cause) {
      if (!this.isLifecycleContextCurrent(context)) {
        return
      }
      this.fail('mse', 'RIVMUX_MSE_LATENCY_POLICY_FAILED', 'MSE latency policy failed.', true, cause)
    } finally {
      this.statsTickInFlight = false
    }
  }

  private currentLifecycleContext(): LifecycleCommandContext {
    return {
      generation: this.lifecycleGeneration,
      signal: this.lifecycleAbortController.signal,
    }
  }

  private isLifecycleContextCurrent(context: LifecycleCommandContext): boolean {
    return !context.signal.aborted && context.generation === this.lifecycleGeneration
  }

  private fail(kind: PlayerError['kind'], code: string, message: string, terminal: boolean, cause?: unknown): void {
    const error = cause === undefined ? { kind, code, message, terminal } : { kind, code, message, terminal, cause: serializeCause(cause) }
    this.failWithError(error)
  }

  private failWithError(error: PlayerError): void {
    if (this.state === 'destroyed') {
      return
    }
    if (error.terminal) {
      this.enterFatalErrorState()
    }
    this.post({ type: 'error', error })
  }

  private enterFatalErrorState(): void {
    if (this.state === 'fatal-error' || this.state === 'destroyed') {
      return
    }

    this.state = 'fatal-error'
    this.discardFmp4AppendBatches()
    this.fatalCleanupPromise = this.closeLoader().catch(() => undefined)
    this.mse?.destroy()
    this.mse = undefined
    this.latencyController?.reset()
    this.videoState = undefined
    this.lastLatencyMetrics = {}
  }

  private post(message: WorkerMessage, transfer?: Transferable[]): void {
    this.port.postMessage(message, transfer)
  }
}

function getNetworkErrorCode(cause: unknown): string {
  return cause instanceof HttpFlvLoaderError ? cause.code : 'RIVMUX_HTTP_LOADER_FAILED'
}

function getNetworkIdleMs(stats: StreamLoaderStats | undefined, nowMs: number): number | undefined {
  const markerMs = stats?.lastChunkAtMs ?? stats?.startedAtMs
  if (markerMs === undefined) {
    return undefined
  }

  return Math.max(nowMs - markerMs, 0)
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
    }
  }

  return cause
}

function isQuotaExceededError(cause: unknown): boolean {
  return isNamedError(cause, 'QuotaExceededError')
}

function isNamedError(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && 'name' in value && (value as { name?: unknown }).name === name
}

function detectWorkerRuntime(): PlayerError | undefined {
  if (typeof fetch !== 'function') {
    return createUnsupportedRuntimeError('RIVMUX_UNSUPPORTED_FETCH', 'Fetch is not available in this worker runtime.')
  }

  if (typeof ReadableStream === 'undefined') {
    return createUnsupportedRuntimeError('RIVMUX_UNSUPPORTED_READABLE_STREAM', 'ReadableStream is not available in this worker runtime.')
  }

  if (typeof WebAssembly === 'undefined') {
    return createUnsupportedRuntimeError('RIVMUX_UNSUPPORTED_WASM', 'WebAssembly is not available in this worker runtime.')
  }

  if (typeof MediaSource === 'undefined') {
    return createUnsupportedRuntimeError('RIVMUX_UNSUPPORTED_MSE', 'MediaSource is not available in this worker runtime.')
  }

  if (MediaSource.canConstructInDedicatedWorker !== true) {
    return createUnsupportedRuntimeError('RIVMUX_UNSUPPORTED_WORKER_MSE', 'MediaSource cannot be constructed in this worker runtime.')
  }

  if (typeof MediaSource.isTypeSupported !== 'function') {
    return createUnsupportedRuntimeError('RIVMUX_UNSUPPORTED_MSE_TYPE_CHECK', 'MediaSource.isTypeSupported is not available in this worker runtime.')
  }

  return undefined
}

function createUnsupportedRuntimeError(code: string, message: string): PlayerError {
  return { kind: 'unsupported', code, message, terminal: true }
}

function createLatencyController(options: NormalizedRivmuxPlayerOptions): LatencyController {
  return new LatencyController({
    latency: options.latency,
    playback: options.playback,
  })
}

type LifecycleOperationResult<T> = { cancelled: true } | { cancelled: false; value: T }

function raceLifecycleOperation<T>(operation: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<LifecycleOperationResult<T>> {
  if (signal.aborted) {
    void operation.then(onLateValue, () => undefined)
    return Promise.resolve({ cancelled: true })
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      void operation.then(onLateValue, () => undefined)
      resolve({ cancelled: true })
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve({ cancelled: false, value })
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function mergeOptions(current: NormalizedRivmuxPlayerOptions, updates: Partial<NormalizedRivmuxPlayerOptions>): NormalizedRivmuxPlayerOptions {
  return {
    playback: {
      ...current.playback,
      ...updates.playback,
    },
    latency: {
      ...current.latency,
      ...updates.latency,
    },
    network: {
      ...current.network,
      ...updates.network,
      headers: {
        ...current.network.headers,
        ...updates.network?.headers,
      },
      retry: {
        ...current.network.retry,
        ...updates.network?.retry,
      },
    },
    runtime: {
      ...current.runtime,
      ...updates.runtime,
    },
    diagnostics: {
      ...current.diagnostics,
      ...updates.diagnostics,
    },
  }
}
