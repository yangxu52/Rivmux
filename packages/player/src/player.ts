import { PlayerEventEmitter } from './events'
import { createPlayerError } from './errors'
import { detectMainThreadRuntime } from './feature-detect'
import { normalizePlayerOptions } from './options'
import { createDefaultWorkerFactory, playerErrorToException, WorkerClient } from './worker-client'

import type { NormalizedRivmuxPlayerOptions, PlayerError, PlayerEventListener, PlayerEventType, RivmuxPlayerOptions, WorkerMessage } from 'rivmux-protocol'
import type { WorkerFactory } from './worker-client'

type PlayerState = 'idle' | 'attached' | 'started' | 'stopped' | 'destroyed'

export type RivmuxPlayerInternals = {
  workerFactory?: WorkerFactory
  detectRuntime?: () => PlayerError | undefined
  idFactory?: () => string
}

export class RivmuxPlayer {
  readonly url: string
  readonly options: NormalizedRivmuxPlayerOptions
  private readonly id: string
  private readonly events = new PlayerEventEmitter()
  private readonly workerFactory: WorkerFactory
  private readonly detectRuntime: () => PlayerError | undefined
  private workerClient?: WorkerClient
  private video?: HTMLVideoElement
  private state: PlayerState = 'idle'

  constructor(url: string, options?: RivmuxPlayerOptions, internals: RivmuxPlayerInternals = {}) {
    this.url = url
    this.options = normalizePlayerOptions(options)
    this.id = internals.idFactory?.() ?? createPlayerId()
    this.workerFactory = internals.workerFactory ?? createDefaultWorkerFactory()
    this.detectRuntime = internals.detectRuntime ?? detectMainThreadRuntime
  }

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

    if (this.options.playback.autoPlay) {
      await this.video.play()
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'destroyed') {
      return
    }

    if (this.workerClient === undefined) {
      this.state = 'stopped'
      this.events.emit('stopped', undefined)
      return
    }

    await this.workerClient.waitForStopped({ type: 'stop' })
    this.detachVideoSource()
    this.state = 'stopped'
  }

  async destroy(): Promise<void> {
    if (this.state === 'destroyed') {
      return
    }

    const workerClient = this.workerClient
    this.workerClient = undefined

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

  on<T extends PlayerEventType>(type: T, listener: PlayerEventListener<T>): void {
    this.events.on(type, listener)
  }

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

  private detachVideoSource(): void {
    if (this.video === undefined) {
      return
    }

    this.video.pause()
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
