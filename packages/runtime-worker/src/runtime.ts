import { createM1StaticFmp4Fixture } from './fixtures/m1-static-fmp4'
import { HttpFlvLoader, HttpFlvLoaderError, isAbortLikeError } from './loader/http-flv-loader'
import { MseController } from './mse/mse-controller'
import { coreErrorToPlayerError, coreMediaInfoToPlayerMediaInfo, coreWarningToPlayerWarning } from './wasm/rivmux-transmux-wasm'

import type { StreamLoader, StreamLoaderConfig, StreamLoaderStats } from './loader/loader'
import type { NormalizedRivmuxPlayerOptions, PlayerError, WorkerCommand, WorkerMessage } from 'rivmux-protocol'
import type { CoreEvent, TransmuxCoreHost } from './wasm/rivmux-transmux-wasm'

type RuntimeState = 'idle' | 'ready' | 'attached' | 'started' | 'stopped' | 'destroyed' | 'fatal-error'

export type RuntimeWorkerPort = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void
  close(): void
}

export type RuntimeMseController = {
  readonly appendQueueLength: number
  readonly sourceBufferUpdating: boolean
  readonly bufferedStart: number | undefined
  readonly bufferedEnd: number | undefined
  readonly bufferedDuration: number | undefined
  createMediaSourceHandle(): Promise<MediaSourceHandle>
  appendFixture(fixture: ReturnType<typeof createM1StaticFmp4Fixture>): Promise<void>
  destroy(): void
}

export type RuntimeWorkerDependencies = {
  createMseController?: () => RuntimeMseController
  createLoader?: (config: StreamLoaderConfig) => StreamLoader
  createTransmuxCore?: () => TransmuxCoreHost | undefined
}

export class RuntimeWorker {
  private readonly port: RuntimeWorkerPort
  private readonly createMseController: () => RuntimeMseController
  private readonly createLoader: (config: StreamLoaderConfig) => StreamLoader
  private readonly createTransmuxCore: () => TransmuxCoreHost | undefined
  private state: RuntimeState = 'idle'
  private url?: string
  private options?: NormalizedRivmuxPlayerOptions
  private mse?: RuntimeMseController
  private loader?: StreamLoader
  private transmuxCore?: TransmuxCoreHost
  private loaderRunId = 0
  private outputBytes = 0

  constructor(port: RuntimeWorkerPort, dependencies: RuntimeWorkerDependencies = {}) {
    this.port = port
    this.createMseController = dependencies.createMseController ?? (() => new MseController())
    this.createLoader = dependencies.createLoader ?? ((config) => new HttpFlvLoader(config))
    this.createTransmuxCore = dependencies.createTransmuxCore ?? (() => undefined)
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
          this.options = this.options === undefined ? undefined : { ...this.options, ...command.options }
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

    const handle = await this.mse.createMediaSourceHandle()
    this.post({ type: 'media-source-handle', handle }, [handle])
    this.state = 'attached'
  }

  private async start(): Promise<void> {
    if (this.mse === undefined || this.state === 'idle' || this.state === 'ready') {
      this.fail('runtime', 'RIVMUX_WORKER_START_REQUIRES_ATTACH', 'Worker start requires an attached MediaSource.', true)
      return
    }

    if (this.state === 'started') {
      return
    }

    const fixture = createM1StaticFmp4Fixture()
    await this.mse.appendFixture(fixture)
    this.state = 'started'
    this.outputBytes = fixture.initSegment.byteLength + fixture.mediaSegment.byteLength
    this.post({
      type: 'media-info',
      mediaInfo: {
        container: 'fmp4',
        videoCodec: fixture.codec,
        width: fixture.width,
        height: fixture.height,
      },
    })
    this.postStats()
    this.startLoader()
  }

  private async stop(): Promise<void> {
    await this.closeLoader()
    this.mse?.destroy()
    this.mse = undefined
    this.state = 'stopped'
    this.post({ type: 'stopped' })
  }

  private async destroy(): Promise<void> {
    await this.closeLoader()
    this.mse?.destroy()
    this.mse = undefined
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
    this.transmuxCore?.destroy()
    this.transmuxCore = this.createTransmuxCore()
    const runId = this.loaderRunId + 1
    this.loaderRunId = runId
    this.loader = loader

    void this.runLoader(loader, runId)
  }

  private async runLoader(loader: StreamLoader, runId: number): Promise<void> {
    try {
      await loader.open()

      while (this.isCurrentLoader(loader, runId)) {
        const chunk = await loader.read()
        if (chunk === null) {
          break
        }

        this.postStats(loader.stats)
        if (!this.processTransmuxEvents(this.transmuxCore?.pushChunk(chunk.bytes) ?? [])) {
          await this.closeCurrentLoader(loader, runId)
          return
        }
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
    this.post({
      type: 'stats',
      stats: {
        bytesReceived: loaderStats?.bytesReceived ?? this.loader?.stats.bytesReceived ?? 0,
        currentNetworkSpeed: loaderStats?.currentNetworkSpeed ?? this.loader?.stats.currentNetworkSpeed ?? 0,
        outputBytes: this.outputBytes,
        appendQueueLength: this.mse?.appendQueueLength ?? 0,
        sourceBufferUpdating: this.mse?.sourceBufferUpdating ?? false,
        bufferedStart: this.mse?.bufferedStart,
        bufferedEnd: this.mse?.bufferedEnd,
        bufferedDuration: this.mse?.bufferedDuration,
      },
    })
  }

  private processTransmuxEvents(events: CoreEvent[]): boolean {
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

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
    }
  }

  return cause
}
