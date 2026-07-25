import type { MediaInfo } from './media'
import type { PlayerError, PlayerStats, PlayerWarning } from './diagnostics'

/** Payload map for player events. */
export type PlayerEventMap = {
  ready: undefined
  mediaInfo: MediaInfo
  stats: PlayerStats
  warning: PlayerWarning
  error: PlayerError
  stopped: undefined
  destroyed: undefined
}

/** Player event name. */
export type PlayerEventType = keyof PlayerEventMap

/** Typed player event listener. */
export type PlayerEventListener<T extends PlayerEventType> = (payload: PlayerEventMap[T]) => void
