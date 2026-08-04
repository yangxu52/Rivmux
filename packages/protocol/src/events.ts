import type { MediaInfo } from './media'
import type { PlayerError, PlayerStats, PlayerWarning } from './diagnostics'

/** Network failure category that caused a live stream reconnect. */
export type ReconnectReason = 'http-status' | 'network-error' | 'read-error' | 'read-timeout' | 'unexpected-eof'

/** Details emitted after the runtime schedules another connection attempt. */
export type ReconnectInfo = {
  /** One-based connection attempt number within the current recovery cycle. */
  attempt: number
  /** Maximum connection attempts in the current recovery cycle, including the failed connection. */
  maxAttempts: number
  /** Delay before the next connection attempt starts. */
  delayMs: number
  /** Failure category that caused this recovery cycle. */
  reason: ReconnectReason
}

/** Details emitted after a reconnected session appends its first media segment. */
export type RecoveryInfo = {
  /** Connection attempt that successfully recovered playback. */
  attempt: number
  /** Elapsed time between the recoverable failure and recovery. */
  downtimeMs: number
}

/** Payload map for player events. */
export type PlayerEventMap = {
  ready: undefined
  mediaInfo: MediaInfo
  stats: PlayerStats
  warning: PlayerWarning
  error: PlayerError
  reconnecting: ReconnectInfo
  recovered: RecoveryInfo
  stopped: undefined
  destroyed: undefined
}

/** Player event name. */
export type PlayerEventType = keyof PlayerEventMap

/** Typed player event listener. */
export type PlayerEventListener<T extends PlayerEventType> = (payload: PlayerEventMap[T]) => void
