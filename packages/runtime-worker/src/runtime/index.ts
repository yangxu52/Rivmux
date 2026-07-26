import { LatencyController } from '../latency/latency-controller'
import { raceLifecycleOperation } from './lifecycle'
import { mergeOptions } from './options'
import { createPlayerStats, updateAppendQueueHighWaterMark } from './stats'
import { RuntimeSession } from './session'

import type { LatencyMetrics } from '../latency/latency-controller'
import type { StreamLoaderStats } from '../loader/loader'
import type { NormalizedRivmuxPlayerOptions, PlayerError, VideoElementState, WorkerCommand, WorkerMessage } from '@rivmux/protocol'
import type { LifecycleCommandContext } from './lifecycle'
import type { RuntimeState, RuntimeWorkerDependencies, RuntimeWorkerPort } from './types'

export type { RuntimeMseController, RuntimeWorkerDependencies, RuntimeWorkerPort } from './types'

export class RuntimeWorker {
  private readonly port: RuntimeWorkerPort
  private readonly detectRuntime: () => PlayerError | undefined
  private readonly now: () => number
  private state: RuntimeState = 'idle'
  private url?: string
  private options?: NormalizedRivmuxPlayerOptions
  private readonly session: RuntimeSession
  private latencyController?: LatencyController
  private videoState?: VideoElementState
  private lastLatencyMetrics: LatencyMetrics = {}
  private statsTimer?: ReturnType<typeof setInterval>
  private statsTickInFlight = false
  private appendQueueMaxLength = 0
  private appendQueueMaxBytes = 0
  private commandTail: Promise<void> = Promise.resolve()
  private lifecycleGeneration = 0
  private lifecycleAbortController = new AbortController()
  private fatalCleanupPromise: Promise<void> = Promise.resolve()

  constructor(port: RuntimeWorkerPort, dependencies: RuntimeWorkerDependencies = {}) {
    this.port = port
    this.detectRuntime = dependencies.detectRuntime ?? detectWorkerRuntime
    this.now = dependencies.now ?? (() => performance.now())
    this.session = new RuntimeSession({
      ...dependencies,
      isStarted: () => this.state === 'started',
      isLifecycleContextCurrent: (context) => this.isLifecycleContextCurrent(context),
      onMediaAppended: (context) => this.applyLatencyPolicy(context),
      onAppendError: (cause, context) => {
        if (this.isLifecycleContextCurrent(context)) {
          this.fail('mse', 'RIVMUX_MSE_APPEND_FAILED', 'MSE append failed.', true, cause)
        }
      },
      onLoaderClosing: () => this.stopStatsTimer(),
      onStats: (stats) => this.postStats(stats),
      onMessage: (message) => this.post(message),
      onFailure: (kind, code, message, cause) => this.fail(kind, code, message, true, cause),
      onPlayerError: (error) => this.failWithError(error),
      applyLatencyPolicy: (context) => this.applyLatencyPolicy(context),
      quotaCleanupCutoff: () => this.quotaCleanupCutoff(),
    })
  }

  handleCommand(command: WorkerCommand): Promise<void> {
    if (command.type === 'stop' || command.type === 'destroy') {
      this.invalidateLifecycle()
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

    try {
      const handle = await this.session.attach(context)
      if (handle === undefined || context.generation !== this.lifecycleGeneration) {
        return
      }
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
    if (!this.session.hasMse || options === undefined || this.state === 'idle' || this.state === 'ready') {
      this.fail('runtime', 'RIVMUX_WORKER_START_REQUIRES_ATTACH', 'Worker start requires an attached MediaSource.', true)
      return
    }

    if (this.state === 'started') {
      return
    }

    try {
      const transmuxCore = await this.session.createCore(options, context)
      if (context.generation !== this.lifecycleGeneration) {
        return
      }
      if (transmuxCore === undefined) {
        this.fail('runtime', 'RIVMUX_TRANSMUX_CORE_UNAVAILABLE', 'Transmux core is not available.', true)
        return
      }
      this.session.start(transmuxCore, context)
    } catch (cause) {
      if (context.generation !== this.lifecycleGeneration) {
        return
      }
      this.fail('runtime', 'RIVMUX_TRANSMUX_CORE_UNAVAILABLE', 'Transmux core is not available.', true, cause)
      return
    }

    this.state = 'started'
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
    this.session.destroyMse()
    this.latencyController?.reset()
    this.videoState = undefined
    this.lastLatencyMetrics = {}
    this.state = 'stopped'
    this.post({ type: 'stopped' })
  }

  private async destroy(): Promise<void> {
    await this.fatalCleanupPromise
    await this.closeLoader()
    this.session.destroyMse()
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

    this.session.runLoader(
      {
        url,
        network: options.network,
      },
      context
    )
  }

  private async closeLoader(): Promise<void> {
    this.stopStatsTimer()
    await this.session.close()
  }

  private postStats(loaderStats?: StreamLoaderStats): void {
    const mseStats = this.collectMseStats()
    const loaderSnapshot = loaderStats ?? this.session.loaderStats
    this.post({
      type: 'stats',
      stats: createPlayerStats({
        loaderStats: loaderSnapshot,
        mseStats,
        latencyMetrics: this.lastLatencyMetrics,
        outputBytes: this.session.emittedBytes,
        appendQueueMaxLength: this.appendQueueMaxLength,
        appendQueueMaxBytes: this.appendQueueMaxBytes,
        loaderPaused: this.session.loaderPaused,
        nowMs: this.now(),
      }),
    })
  }

  private collectMseStats() {
    const stats = this.session.collectMseStats()
    const highWaterMark = updateAppendQueueHighWaterMark({ length: this.appendQueueMaxLength, bytes: this.appendQueueMaxBytes }, stats)
    this.appendQueueMaxLength = highWaterMark.length
    this.appendQueueMaxBytes = highWaterMark.bytes

    return {
      ...stats,
    }
  }

  private quotaCleanupCutoff(): number | undefined {
    const backwardBuffer = this.options?.latency.backwardBuffer ?? 0
    const currentTime = this.videoState?.currentTime
    if (currentTime !== undefined && Number.isFinite(currentTime)) {
      return Math.max(0, currentTime - backwardBuffer)
    }

    const bufferedEnd = this.session.collectMseStats().bufferedEnd
    return bufferedEnd === undefined ? undefined : Math.max(0, bufferedEnd - backwardBuffer)
  }

  private async applyLatencyPolicy(context?: LifecycleCommandContext): Promise<void> {
    const latencyController = this.latencyController
    if (latencyController === undefined || !this.session.hasMse) {
      return
    }

    const evaluation = latencyController.evaluate({
      ranges: this.session.bufferedRanges,
      videoState: this.videoState,
      loaderPaused: this.session.loaderPaused,
      nowMs: this.now(),
    })
    this.lastLatencyMetrics = evaluation.metrics

    if (evaluation.cleanupBefore !== undefined) {
      await this.session.cleanupBefore(evaluation.cleanupBefore)
    }

    if (context !== undefined && !this.isLifecycleContextCurrent(context)) {
      return
    }

    if (evaluation.loaderCommand === 'pause') {
      this.session.pauseLoader()
    } else if (evaluation.loaderCommand === 'resume') {
      this.session.resumeLoader()
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
    this.invalidateLifecycle()
    this.session.discardAppend()
    this.fatalCleanupPromise = this.closeLoader().catch(() => undefined)
    this.session.destroyMse()
    this.latencyController?.reset()
    this.videoState = undefined
    this.lastLatencyMetrics = {}
  }

  private post(message: WorkerMessage, transfer?: Transferable[]): void {
    this.port.postMessage(message, transfer)
  }

  private invalidateLifecycle(): void {
    this.lifecycleGeneration += 1
    this.lifecycleAbortController.abort()
    this.lifecycleAbortController = new AbortController()
  }
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
