import { PlayerEventEmitter } from './events'
import { createPlayerError, playerErrorToException } from './errors'
import { detectMainThreadRuntime } from './feature-detect'
import { normalizePlayerOptions } from './options'
import { PlaybackController } from './playback-controller'
import { createRuntimeWorker, getBundledWasmUrl, WorkerClient } from '@rivmux/runtime-worker'

import type {
  NormalizedRivmuxPlayerOptions,
  PlaybackControlAction,
  PlayerError,
  PlayerEventListener,
  PlayerEventType,
  RivmuxPlayerOptions,
  WorkerMessage,
} from '@rivmux/protocol'
import type { RuntimeWorkerFactory } from '@rivmux/runtime-worker'

type PlayerState = 'idle' | 'attached' | 'starting' | 'started' | 'stopping' | 'stopped' | 'fatal-error' | 'destroying' | 'destroyed'

export type RivmuxPlayerInternals = {
  workerFactory?: RuntimeWorkerFactory
  detectRuntime?: () => PlayerError | undefined
  idFactory?: () => string
}

/**
 * Public browser player facade for one HTTP-FLV stream.
 *
 * Create one instance per stream URL, call `attach(video)` first, then
 * `start()`. Call `destroy()` when the instance is no longer needed.
 */
export class RivmuxPlayer {
  /** Original stream URL passed to the constructor. */
  readonly url: string

  /** Fully normalized options with defaults applied. */
  readonly options: NormalizedRivmuxPlayerOptions
  private readonly id: string
  private readonly events = new PlayerEventEmitter()
  private readonly workerFactory: RuntimeWorkerFactory
  private readonly detectRuntime: () => PlayerError | undefined
  private readonly playback: PlaybackController
  private workerClient?: WorkerClient
  private state: PlayerState = 'idle'
  private lifecycleGeneration = 0
  private terminalError?: PlayerError
  private autoplayWarningEmitted = false
  private startPromise?: Promise<void>
  private stopPromise?: Promise<void>
  private destroyPromise?: Promise<void>

  /**
   * Creates a player instance for one stream URL.
   *
   * The instance does not start network loading until `start()` is called.
   */
  constructor(url: string, options?: RivmuxPlayerOptions, internals: RivmuxPlayerInternals = {}) {
    this.url = url
    this.options = normalizePlayerOptions(options)
    this.id = internals.idFactory?.() ?? createPlayerId()
    this.workerFactory = internals.workerFactory ?? createRuntimeWorker
    this.detectRuntime = internals.detectRuntime ?? detectMainThreadRuntime
    this.playback = new PlaybackController(this.options.playback)
  }

  /**
   * Attaches this player to a video element and prepares the worker/MSE pipe.
   *
   * Await this method before calling `start()`.
   */
  async attach(video: HTMLVideoElement): Promise<void> {
    this.assertOperational('attach')
    const lifecycleGeneration = this.lifecycleGeneration

    if (this.playback.attached && !this.playback.isAttachedTo(video)) {
      throw playerErrorToException(createPlayerError('runtime', 'RIVMUX_ALREADY_ATTACHED', 'This player is already attached to a video element.', false))
    }

    const runtimeError = this.detectRuntime()
    if (runtimeError !== undefined) {
      this.events.emit('error', runtimeError)
      throw playerErrorToException(runtimeError)
    }

    this.playback.attach(video)
    this.ensureWorkerClient()
    await this.workerClient?.waitForMediaSourceHandle({ type: 'attach-media-source' })
    if (!this.isLifecycleOperationCurrent(lifecycleGeneration)) {
      return
    }
    this.state = 'attached'
  }

  /**
   * Waits until the worker has created the transmux core and scheduled stream
   * consumption for this playback session.
   *
   * This does not wait for media data, `canplay`, or `video.play()`. Requires a
   * successful `attach(video)` call first.
   */
  start(): Promise<void> {
    try {
      this.assertOperational('start')
    } catch (cause) {
      return Promise.reject(cause)
    }

    if (!this.playback.attached || this.workerClient === undefined) {
      return Promise.reject(
        playerErrorToException(createPlayerError('runtime', 'RIVMUX_START_REQUIRES_ATTACH', 'start() requires a previously attached video element.', false))
      )
    }

    if (this.state === 'started') {
      return Promise.resolve()
    }

    if (this.startPromise !== undefined) {
      return this.startPromise
    }

    const lifecycleGeneration = this.lifecycleGeneration
    const previousState = this.state
    this.state = 'starting'
    const starting = this.performStart(this.workerClient, lifecycleGeneration, previousState === 'stopped').finally(() => {
      if (this.startPromise === starting) {
        this.startPromise = undefined
      }
    })
    this.startPromise = starting
    return starting
  }

  private async performStart(workerClient: WorkerClient, lifecycleGeneration: number, restart: boolean): Promise<void> {
    try {
      if (restart) {
        await workerClient.waitForMediaSourceHandle({ type: 'attach-media-source' })
        this.assertStartOperationCurrent(lifecycleGeneration)
      }

      await workerClient.waitForStarted({ type: 'start' })
      this.assertStartOperationCurrent(lifecycleGeneration)
    } catch (cause) {
      if (this.isLifecycleOperationCurrent(lifecycleGeneration) && this.state === 'starting') {
        this.state = restart ? 'stopped' : 'attached'
      }
      throw toPublicStartError(cause)
    }

    this.state = 'started'
    this.startVideoStateReporting()
  }

  /**
   * Stops loading and detaches the current media source.
   *
   * The instance remains reusable; call `start()` again to restart the same
   * stream after the player has stopped.
   */
  stop(): Promise<void> {
    if (this.state === 'destroyed' || this.state === 'destroying') {
      return Promise.resolve()
    }

    if (this.state === 'fatal-error') {
      return Promise.resolve()
    }

    if (this.stopPromise !== undefined) {
      return this.stopPromise
    }

    this.lifecycleGeneration += 1
    this.state = 'stopping'
    const lifecycleGeneration = this.lifecycleGeneration
    const stopping = this.performStop(lifecycleGeneration).finally(() => {
      if (this.stopPromise === stopping) {
        this.stopPromise = undefined
      }
    })
    this.stopPromise = stopping
    return stopping
  }

  private async performStop(lifecycleGeneration: number): Promise<void> {
    const workerClient = this.workerClient
    if (workerClient === undefined) {
      if (this.isLifecycleOperationCurrent(lifecycleGeneration)) {
        this.autoplayWarningEmitted = false
        this.state = 'stopped'
        this.events.emit('stopped', undefined)
      }
      return
    }

    this.playback.stopStateReporting()
    try {
      await workerClient.waitForStopped({ type: 'stop' })
    } catch (error) {
      if (!this.isLifecycleOperationCurrent(lifecycleGeneration)) {
        return
      }
      throw error
    }
    if (!this.isLifecycleOperationCurrent(lifecycleGeneration)) {
      return
    }
    this.playback.detachSource()
    this.autoplayWarningEmitted = false
    this.state = 'stopped'
  }

  /**
   * Releases worker resources, timers, listeners, and the attached video source.
   *
   * The instance is terminal after destroy and cannot be attached or started
   * again.
   */
  async destroy(): Promise<void> {
    if (this.state === 'destroyed') {
      return
    }

    if (this.destroyPromise !== undefined) {
      return this.destroyPromise
    }

    this.lifecycleGeneration += 1
    this.state = 'destroying'
    this.destroyPromise = this.performDestroy()
    return this.destroyPromise
  }

  private async performDestroy(): Promise<void> {
    const workerClient = this.workerClient
    this.workerClient = undefined
    this.playback.stopStateReporting()
    let destroyError: unknown

    if (workerClient !== undefined) {
      try {
        await workerClient.waitForDestroyed({ type: 'destroy' })
      } catch (error) {
        destroyError = error
      } finally {
        workerClient.dispose()
      }
    } else {
      this.events.emit('destroyed', undefined)
    }

    this.playback.release()

    this.state = 'destroyed'
    this.events.clear()

    if (destroyError !== undefined) {
      throw destroyError
    }
  }

  /** Registers an event listener for a typed player event. */
  on<T extends PlayerEventType>(type: T, listener: PlayerEventListener<T>): void {
    this.events.on(type, listener)
  }

  /** Removes a previously registered event listener. */
  off<T extends PlayerEventType>(type: T, listener: PlayerEventListener<T>): void {
    this.events.off(type, listener)
  }

  private ensureWorkerClient(): void {
    if (this.workerClient !== undefined) {
      return
    }

    const worker = this.workerFactory(this.options)
    this.workerClient = new WorkerClient(worker, {
      onMessage: (message) => this.handleWorkerMessage(message),
      onError: (error) => {
        this.enterFatalErrorState(error)
        this.events.emit('error', error)
      },
    })
    this.workerClient.post({ type: 'init', id: this.id, url: this.url, options: withBundledWasmUrl(this.options) })
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    if (this.state === 'destroyed') {
      return
    }

    if ((this.state === 'destroying' && message.type !== 'destroyed') || this.state === 'fatal-error') {
      return
    }

    switch (message.type) {
      case 'ready':
        this.events.emit('ready', undefined)
        return
      case 'media-source-handle':
        this.attachMediaSourceHandle(message.handle)
        return
      case 'started':
        return
      case 'media-info':
        this.events.emit('mediaInfo', message.mediaInfo)
        return
      case 'stats':
        this.events.emit('stats', message.stats)
        return
      case 'warning':
        this.events.emit('warning', message.warning)
        return
      case 'reconnecting':
        this.events.emit('reconnecting', message.info)
        return
      case 'recovered':
        this.events.emit('recovered', message.info)
        return
      case 'error':
        if (message.error.terminal) {
          this.enterFatalErrorState(message.error)
        }
        this.events.emit('error', message.error)
        return
      case 'playback-control':
        void this.applyPlaybackControl(message.action)
        return
      case 'stopped':
        this.events.emit('stopped', undefined)
        return
      case 'destroyed':
        this.events.emit('destroyed', undefined)
        return
    }
  }

  private attachMediaSourceHandle(handle: MediaSourceHandle): void {
    if (this.state === 'started') {
      this.autoplayWarningEmitted = false
      this.playback.detachSource()
    }
    if (!this.playback.attachMediaSourceHandle(handle)) {
      const error = createPlayerError(
        'runtime',
        'RIVMUX_ATTACH_HANDLE_WITHOUT_VIDEO',
        'Worker returned a MediaSourceHandle before a video element was attached.',
        true
      )
      this.events.emit('error', error)
      throw playerErrorToException(error)
    }
  }

  private startVideoStateReporting(): void {
    const intervalMs = Math.max(100, Math.min(this.options.diagnostics.statsIntervalMs, 250))
    const workerClient = this.workerClient
    if (workerClient === undefined) {
      return
    }

    this.playback.startStateReporting(intervalMs, (state) => {
      if (this.state === 'started' && this.workerClient === workerClient) {
        workerClient.post({ type: 'video-state', state })
      }
    })
  }

  private async applyPlaybackControl(action: PlaybackControlAction): Promise<void> {
    const workerClient = this.workerClient
    const lifecycleGeneration = this.lifecycleGeneration
    if (!this.playback.attached || workerClient === undefined || this.state !== 'started') {
      return
    }

    const result = await this.playback.applyControl(action)
    if (!this.isLifecycleOperationCurrent(lifecycleGeneration) || this.state !== 'started' || this.workerClient !== workerClient) {
      return
    }
    workerClient.post({ type: 'playback-control-result', result })
    if (
      action.type === 'play' &&
      action.reason === 'startup-buffer-ready' &&
      this.options.playback.autoPlay &&
      !result.accepted &&
      !this.autoplayWarningEmitted
    ) {
      this.autoplayWarningEmitted = true
      this.events.emit('warning', {
        code: 'RIVMUX_AUTOPLAY_REJECTED',
        message: '浏览器拒绝了自动播放；请在用户手势处理器中调用 video.play() 恢复播放。',
        cause: result.error,
      })
    }
  }

  private enterFatalErrorState(error: PlayerError): void {
    if (this.state === 'destroyed' || this.state === 'destroying' || this.state === 'fatal-error') {
      return
    }

    this.lifecycleGeneration += 1
    this.terminalError = error
    this.state = 'fatal-error'
    this.playback.release()
  }

  private assertOperational(method: string): void {
    if (this.state === 'fatal-error' && this.terminalError !== undefined) {
      throw playerErrorToException(this.terminalError)
    }

    if (this.state === 'stopping') {
      throw playerErrorToException(
        createPlayerError('runtime', 'RIVMUX_PLAYER_STOPPING', `RivmuxPlayer.${method}() cannot be called while stop() is pending.`, false)
      )
    }

    if (this.state !== 'destroyed' && this.state !== 'destroying') {
      return
    }

    const code = this.state === 'destroying' ? 'RIVMUX_PLAYER_DESTROYING' : 'RIVMUX_PLAYER_DESTROYED'
    throw playerErrorToException(createPlayerError('runtime', code, `RivmuxPlayer.${method}() cannot be called after destroy() begins.`, true))
  }

  private isLifecycleOperationCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration && this.state !== 'fatal-error' && this.state !== 'destroying' && this.state !== 'destroyed'
  }

  private assertStartOperationCurrent(generation: number): void {
    if (this.isLifecycleOperationCurrent(generation) && this.state === 'starting') {
      return
    }

    const action = this.state === 'destroying' || this.state === 'destroyed' ? 'destroy' : 'stop'
    throw createPlayerError('runtime', 'RIVMUX_START_CANCELLED', `Start was cancelled by ${action}.`, false)
  }
}

function toPublicStartError(cause: unknown): Error {
  return isPlayerError(cause) ? playerErrorToException(cause) : cause instanceof Error ? cause : new Error(String(cause))
}

function isPlayerError(value: unknown): value is PlayerError {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<PlayerError>
  return (
    typeof candidate.kind === 'string' && typeof candidate.code === 'string' && typeof candidate.message === 'string' && typeof candidate.terminal === 'boolean'
  )
}

function createPlayerId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `rivmux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function withBundledWasmUrl(options: NormalizedRivmuxPlayerOptions): NormalizedRivmuxPlayerOptions {
  if (options.runtime.wasmUrl !== undefined) {
    return options
  }

  return {
    ...options,
    runtime: {
      ...options.runtime,
      wasmUrl: getBundledWasmUrl(),
    },
  }
}
