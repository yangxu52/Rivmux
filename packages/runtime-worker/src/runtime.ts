import { createM1StaticFmp4Fixture } from './fixtures/m1-static-fmp4'
import { LatencyController } from './latency/latency-controller'
import { HttpFlvLoader, HttpFlvLoaderError, isAbortLikeError } from './loader/http-flv-loader'
import { MseController } from './mse/mse-controller'
import { loadWasmTransmuxCoreHost } from './wasm/wasm-loader'
import { coreErrorToPlayerError, coreMediaInfoToPlayerMediaInfo, coreWarningToPlayerWarning } from './wasm/rivmux-transmux-wasm'

import type { BufferedRange } from './latency/buffer-ranges'
import type { LatencyMetrics } from './latency/latency-controller'
import type { StreamLoader, StreamLoaderConfig, StreamLoaderStats } from './loader/loader'
import type { NormalizedRivmuxPlayerOptions, PlayerError, VideoElementState, WorkerCommand, WorkerMessage } from 'rivmux-protocol'
import type { CoreEvent, TransmuxCoreHost } from './wasm/rivmux-transmux-wasm'

type RuntimeState = 'idle' | 'ready' | 'attached' | 'started' | 'stopped' | 'destroyed' | 'fatal-error'

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
  appendFixture(fixture: ReturnType<typeof createM1StaticFmp4Fixture>): Promise<void>
  appendInitSegment(segment: Extract<CoreEvent, { type: 'initSegment' }>['data']): Promise<void>
  appendMediaSegment(segment: Extract<CoreEvent, { type: 'mediaSegment' }>['data']): Promise<void>
  cleanupBefore(cutoff: number): Promise<void>
  destroy(): void
}

export type RuntimeWorkerDependencies = {
  createMseController?: () => RuntimeMseController
  createLoader?: (config: StreamLoaderConfig) => StreamLoader
  createTransmuxCore?: (options: NormalizedRivmuxPlayerOptions) => TransmuxCoreHost | undefined | Promise<TransmuxCoreHost | undefined>
  now?: () => number
}

export class RuntimeWorker {
  private readonly port: RuntimeWorkerPort
  private readonly createMseController: () => RuntimeMseController
  private readonly createLoader: (config: StreamLoaderConfig) => StreamLoader
  private readonly createTransmuxCore: (options: NormalizedRivmuxPlayerOptions) => TransmuxCoreHost | undefined | Promise<TransmuxCoreHost | undefined>
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

  constructor(port: RuntimeWorkerPort, dependencies: RuntimeWorkerDependencies = {}) {
    this.port = port
    this.createMseController = dependencies.createMseController ?? (() => new MseController())
    this.createLoader = dependencies.createLoader ?? ((config) => new HttpFlvLoader(config))
    this.createTransmuxCore = dependencies.createTransmuxCore ?? ((options) => loadWasmTransmuxCoreHost(options.runtime.wasmUrl))
    this.now = dependencies.now ?? (() => performance.now())
  }

  async handleCommand(command: WorkerCommand): Promise<void> {
    if (this.state === 'destroyed') {
      return
    }

    try {
      switch (command.type) {
        case 'init':
          this.url = command.url
          this.options = command.options
          this.latencyController = createLatencyController(command.options)
          this.state = 'ready'
          this.post({ type: 'ready' })
          return
        case 'attach-media-source':
          await this.attachMediaSource()
          return
        case 'start':
          await this.start()
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
          await this.applyLatencyPolicy()
          this.postStats()
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

  private async attachMediaSource(): Promise<void> {
    if (this.state === 'idle') {
      this.fail('runtime', 'RIVMUX_WORKER_NOT_INITIALIZED', 'Worker must be initialized before attach.', true)
      return
    }

    if (this.mse === undefined) {
      this.mse = this.createMseController()
    }

    try {
      const handle = await this.mse.createMediaSourceHandle()
      this.post({ type: 'media-source-handle', handle }, [handle])
      this.state = 'attached'
    } catch (cause) {
      this.fail('mse', 'RIVMUX_MSE_ATTACH_FAILED', 'MSE media source attachment failed.', true, cause)
    }
  }

  private async start(): Promise<void> {
    const options = this.options
    if (this.mse === undefined || options === undefined || this.state === 'idle' || this.state === 'ready') {
      this.fail('runtime', 'RIVMUX_WORKER_START_REQUIRES_ATTACH', 'Worker start requires an attached MediaSource.', true)
      return
    }

    if (this.state === 'started') {
      return
    }

    const fixture = createM1StaticFmp4Fixture()
    const transmuxCore = await this.createTransmuxCore(options)
    const hasTransmuxCore = transmuxCore !== undefined
    if (transmuxCore !== undefined) {
      this.transmuxCore?.destroy()
      this.transmuxCore = transmuxCore
    } else {
      try {
        await this.mse.appendFixture(fixture)
      } catch (cause) {
        this.fail('mse', 'RIVMUX_MSE_APPEND_FAILED', 'MSE append failed.', true, cause)
        return
      }
    }
    this.state = 'started'
    this.outputBytes = hasTransmuxCore ? 0 : fixture.initSegment.byteLength + fixture.mediaSegment.byteLength
    this.appendQueueMaxLength = 0
    this.appendQueueMaxBytes = 0
    if (!hasTransmuxCore) {
      this.post({
        type: 'media-info',
        mediaInfo: {
          container: 'fmp4',
          videoCodec: fixture.codec,
          width: fixture.width,
          height: fixture.height,
        },
      })
    }
    this.startStatsTimer()
    await this.applyLatencyPolicy()
    this.postStats()
    this.startLoader()
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

  private startLoader(): void {
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

    void this.runLoader(loader, runId)
  }

  private async runLoader(loader: StreamLoader, runId: number): Promise<void> {
    try {
      await loader.open()

      while (this.isCurrentLoader(loader, runId)) {
        await this.applyLatencyPolicy()
        const chunk = await loader.read()
        if (chunk === null) {
          break
        }

        this.postStats(loader.stats)
        if (!(await this.processTransmuxEvents(this.transmuxCore?.pushChunk(chunk.bytes) ?? []))) {
          await this.closeCurrentLoader(loader, runId)
          return
        }
        await this.applyLatencyPolicy()
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
    const loader = this.loader
    if (loader === undefined) {
      return
    }

    this.loader = undefined
    this.loaderRunId += 1
    this.transmuxCore?.destroy()
    this.transmuxCore = undefined
    await loader.close()
  }

  private async closeCurrentLoader(loader: StreamLoader, runId: number): Promise<void> {
    if (this.loader !== loader || this.loaderRunId !== runId) {
      return
    }

    this.stopStatsTimer()
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

  private async processTransmuxEvents(events: CoreEvent[]): Promise<boolean> {
    for (const event of events) {
      switch (event.type) {
        case 'mediaInfo':
          this.post({ type: 'media-info', mediaInfo: coreMediaInfoToPlayerMediaInfo(event.data) })
          break
        case 'warning':
          this.post({ type: 'warning', warning: coreWarningToPlayerWarning(event.data) })
          break
        case 'fatalError':
          this.post({ type: 'error', error: coreErrorToPlayerError(event.data) })
          this.state = 'fatal-error'
          return false
        case 'initSegment':
          if (!(await this.appendToMse(() => this.mse?.appendInitSegment(event.data)))) {
            return false
          }
          this.outputBytes += event.data.bytes.byteLength
          await this.applyLatencyPolicy()
          break
        case 'mediaSegment':
          if (!(await this.appendToMse(() => this.mse?.appendMediaSegment(event.data)))) {
            return false
          }
          this.outputBytes += event.data.bytes.byteLength
          await this.applyLatencyPolicy()
          break
        case 'probeResult':
        case 'videoConfig':
        case 'audioConfig':
        case 'videoSample':
        case 'audioSample':
        case 'metadata':
        case 'discontinuity':
          break
      }
    }

    return true
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

  private async appendToMse(append: () => Promise<void> | undefined): Promise<boolean> {
    try {
      await append()
      return true
    } catch (cause) {
      this.fail('mse', 'RIVMUX_MSE_APPEND_FAILED', 'MSE append failed.', true, cause)
      return false
    }
  }

  private async applyLatencyPolicy(): Promise<void> {
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
    try {
      await this.applyLatencyPolicy()
      this.postStats()
    } catch (cause) {
      this.fail('mse', 'RIVMUX_MSE_LATENCY_POLICY_FAILED', 'MSE latency policy failed.', true, cause)
    } finally {
      this.statsTickInFlight = false
    }
  }

  private fail(kind: PlayerError['kind'], code: string, message: string, terminal: boolean, cause?: unknown): void {
    const error = cause === undefined ? { kind, code, message, terminal } : { kind, code, message, terminal, cause: serializeCause(cause) }
    if (terminal) {
      this.state = 'fatal-error'
    }
    this.post({ type: 'error', error })
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

function createLatencyController(options: NormalizedRivmuxPlayerOptions): LatencyController {
  return new LatencyController({
    latency: options.latency,
    playback: options.playback,
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
