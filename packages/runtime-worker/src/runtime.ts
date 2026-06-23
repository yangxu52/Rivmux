import { createM1StaticFmp4Fixture } from './fixtures/m1-static-fmp4'
import { MseController } from './mse/mse-controller'

import type { NormalizedRivmuxPlayerOptions, PlayerError, WorkerCommand, WorkerMessage } from 'rivmux-protocol'

type RuntimeState = 'idle' | 'ready' | 'attached' | 'started' | 'stopped' | 'destroyed' | 'fatal-error'

export type RuntimeWorkerPort = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void
  close(): void
}

export class RuntimeWorker {
  private readonly port: RuntimeWorkerPort
  private state: RuntimeState = 'idle'
  private options?: NormalizedRivmuxPlayerOptions
  private mse?: MseController

  constructor(port: RuntimeWorkerPort) {
    this.port = port
  }

  async handleCommand(command: WorkerCommand): Promise<void> {
    if (this.state === 'destroyed') {
      return
    }

    try {
      switch (command.type) {
        case 'init':
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
      this.mse = new MseController()
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
    this.post({
      type: 'media-info',
      mediaInfo: {
        container: 'fmp4',
        videoCodec: fixture.codec,
        width: fixture.width,
        height: fixture.height,
      },
    })
    this.post({
      type: 'stats',
      stats: {
        bytesReceived: 0,
        outputBytes: fixture.initSegment.byteLength + fixture.mediaSegment.byteLength,
        appendQueueLength: this.mse.appendQueueLength,
        sourceBufferUpdating: this.mse.sourceBufferUpdating,
        bufferedStart: this.mse.bufferedStart,
        bufferedEnd: this.mse.bufferedEnd,
        bufferedDuration: this.mse.bufferedDuration,
      },
    })
  }

  private async stop(): Promise<void> {
    this.mse?.destroy()
    this.mse = undefined
    this.state = 'stopped'
    this.post({ type: 'stopped' })
  }

  private async destroy(): Promise<void> {
    this.mse?.destroy()
    this.mse = undefined
    this.state = 'destroyed'
    this.post({ type: 'destroyed' })
    this.port.close()
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

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
    }
  }

  return cause
}
