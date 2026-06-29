import { PlayerEventEmitter } from './events'
import { createPlayerError, playerErrorToException } from './errors'
import { detectMainThreadRuntime } from './feature-detect'
import { normalizePlayerOptions } from './options'
import { createRuntimeWorker, WorkerClient } from '@rivmux/runtime-worker'

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

type PlayerState = 'idle' | 'attached' | 'started' | 'stopped' | 'destroyed'

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
  private workerClient?: WorkerClient
  private video?: HTMLVideoElement
  private videoStateTimer?: ReturnType<typeof setInterval>
  private state: PlayerState = 'idle'

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
  }

  /**
   * Attaches this player to a video element and prepares the worker/MSE pipe.
   *
   * Await this method before calling `start()`.
   */
  async attach(video: HTMLVideoElement): Promise<void> {
    this.assertNotDestroyed('attach')

    if (this.video !== undefined && this.video !== video) {
      throw playerErrorToException(createPlayerError('runtime', 'RIVMUX_ALREADY_ATTACHED', 'This player is already attached to a video element.', false))
    }

    const runtimeError = this.detectRuntime()
    if (runtimeError !== undefined) {
      this.events.emit('error', runtimeError)
      throw playerErrorToException(runtimeError)
    }

    this.video = video
    this.applyPlaybackOptions(video)
    this.ensureWorkerClient()
    await this.workerClient?.waitForMediaSourceHandle({ type: 'attach-media-source' })
    this.state = 'attached'
  }

  /**
   * Starts loading, transmuxing, buffering, and playback control.
   *
   * Requires a successful `attach(video)` call first.
   */
  async start(): Promise<void> {
    this.assertNotDestroyed('start')

    if (this.video === undefined || this.workerClient === undefined) {
      throw playerErrorToException(createPlayerError('runtime', 'RIVMUX_START_REQUIRES_ATTACH', 'start() requires a previously attached video element.', false))
    }

    if (this.state === 'started') {
      return
    }

    if (this.state === 'stopped') {
      await this.workerClient.waitForMediaSourceHandle({ type: 'attach-media-source' })
      this.state = 'attached'
    }

    this.workerClient.post({ type: 'start' })
    this.state = 'started'
    this.startVideoStateReporting()
  }

  /**
   * Stops loading and detaches the current media source.
   *
   * The instance remains reusable; call `start()` again to restart the same
   * stream after the player has stopped.
   */
  async stop(): Promise<void> {
    if (this.state === 'destroyed') {
      return
    }

    if (this.workerClient === undefined) {
      this.state = 'stopped'
      this.events.emit('stopped', undefined)
      return
    }

    this.stopVideoStateReporting()
    await this.workerClient.waitForStopped({ type: 'stop' })
    this.detachVideoSource()
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

    const workerClient = this.workerClient
    this.workerClient = undefined
    this.stopVideoStateReporting()

    if (workerClient !== undefined) {
      try {
        await workerClient.waitForDestroyed({ type: 'destroy' })
      } finally {
        workerClient.dispose()
      }
    } else {
      this.events.emit('destroyed', undefined)
    }

    if (this.video !== undefined) {
      this.detachVideoSource()
      this.video = undefined
    }

    this.state = 'destroyed'
    this.events.clear()
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
      onError: (error) => this.events.emit('error', error),
    })
    this.workerClient.post({ type: 'init', id: this.id, url: this.url, options: this.options })
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    if (this.state === 'destroyed') {
      return
    }

    switch (message.type) {
      case 'ready':
        this.events.emit('ready', undefined)
        return
      case 'media-source-handle':
        this.attachMediaSourceHandle(message.handle)
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
      case 'error':
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
    if (this.video === undefined) {
      const error = createPlayerError(
        'runtime',
        'RIVMUX_ATTACH_HANDLE_WITHOUT_VIDEO',
        'Worker returned a MediaSourceHandle before a video element was attached.',
        true
      )
      this.events.emit('error', error)
      throw playerErrorToException(error)
    }

    Reflect.set(this.video, 'srcObject', handle)
  }

  private applyPlaybackOptions(video: HTMLVideoElement): void {
    video.muted = this.options.playback.muted
    video.autoplay = this.options.playback.autoPlay
  }

  private startVideoStateReporting(): void {
    this.stopVideoStateReporting()
    this.postVideoState()

    const intervalMs = Math.max(100, Math.min(this.options.diagnostics.statsIntervalMs, 250))
    this.videoStateTimer = setInterval(() => {
      this.postVideoState()
    }, intervalMs)
  }

  private stopVideoStateReporting(): void {
    if (this.videoStateTimer === undefined) {
      return
    }

    clearInterval(this.videoStateTimer)
    this.videoStateTimer = undefined
  }

  private postVideoState(): void {
    const video = this.video
    const workerClient = this.workerClient
    if (video === undefined || workerClient === undefined || this.state !== 'started') {
      return
    }

    const droppedFrames = getDroppedFrames(video)
    workerClient.post({
      type: 'video-state',
      state: {
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        readyState: video.readyState,
        playbackRate: video.playbackRate,
        paused: video.paused,
        ...(droppedFrames === undefined ? {} : { droppedFrames }),
      },
    })
  }

  private async applyPlaybackControl(action: PlaybackControlAction): Promise<void> {
    const video = this.video
    const workerClient = this.workerClient
    if (video === undefined || workerClient === undefined || this.state !== 'started') {
      return
    }

    try {
      switch (action.type) {
        case 'play':
          await video.play()
          break
        case 'set-playback-rate':
          video.playbackRate = action.playbackRate
          break
        case 'seek':
          video.currentTime = action.targetTime
          break
      }

      workerClient.post({ type: 'playback-control-result', result: { type: action.type, accepted: true } })
      this.postVideoState()
    } catch (cause) {
      workerClient.post({
        type: 'playback-control-result',
        result: {
          type: action.type,
          accepted: false,
          message: cause instanceof Error ? cause.message : String(cause),
        },
      })
    }
  }

  private detachVideoSource(): void {
    if (this.video === undefined) {
      return
    }

    this.video.pause()
    this.video.playbackRate = 1
    this.video.removeAttribute('src')
    this.video.srcObject = null
    this.video.load()
  }

  private assertNotDestroyed(method: string): void {
    if (this.state !== 'destroyed') {
      return
    }

    throw playerErrorToException(createPlayerError('runtime', 'RIVMUX_PLAYER_DESTROYED', `RivmuxPlayer.${method}() cannot be called after destroy().`, true))
  }
}

function createPlayerId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `rivmux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function getDroppedFrames(video: HTMLVideoElement): number | undefined {
  const quality = video.getVideoPlaybackQuality?.()
  if (quality !== undefined && Number.isFinite(quality.droppedVideoFrames)) {
    return quality.droppedVideoFrames
  }

  const webkitDroppedFrameCount = (video as HTMLVideoElement & { webkitDroppedFrameCount?: number }).webkitDroppedFrameCount
  return Number.isFinite(webkitDroppedFrameCount) ? webkitDroppedFrameCount : undefined
}
