export type { PlayerEventListener, PlayerEventType, RivmuxPlayerOptions } from 'rivmux-protocol'

import type { PlayerEventListener, PlayerEventType, RivmuxPlayerOptions } from 'rivmux-protocol'

export class RivmuxPlayer {
  readonly url: string
  readonly options?: RivmuxPlayerOptions

  constructor(url: string, options?: RivmuxPlayerOptions) {
    this.url = url
    this.options = options
  }

  attach(_video: HTMLVideoElement): Promise<void> {
    return Promise.reject(createNotImplementedError('attach'))
  }

  start(): Promise<void> {
    return Promise.reject(createNotImplementedError('start'))
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }

  destroy(): Promise<void> {
    return Promise.resolve()
  }

  on<T extends PlayerEventType>(_type: T, _listener: PlayerEventListener<T>): void {}

  off<T extends PlayerEventType>(_type: T, _listener: PlayerEventListener<T>): void {}
}

function createNotImplementedError(method: string): Error {
  return new Error(`RivmuxPlayer.${method} is not implemented in the current skeleton.`)
}
