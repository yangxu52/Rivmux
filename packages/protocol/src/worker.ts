import type { PlayerError, PlayerStats, PlayerWarning } from './diagnostics'
import type { ReconnectInfo, RecoveryInfo } from './events'
import type { MediaInfo, PlaybackControlAction, PlaybackControlResult, VideoElementState } from './media'
import type { NormalizedRivmuxPlayerOptions } from './options'

/** Command sent from the player facade to the runtime worker. */
export type WorkerCommand =
  | { type: 'init'; id: string; url: string; options: NormalizedRivmuxPlayerOptions }
  | { type: 'attach-media-source' }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'video-state'; state: VideoElementState }
  | { type: 'playback-control-result'; result: PlaybackControlResult }
  | { type: 'destroy' }

/** Message sent from the runtime worker to the player facade. */
export type WorkerMessage =
  | { type: 'worker-ready' }
  | { type: 'ready' }
  | { type: 'media-source-handle'; handle: MediaSourceHandle }
  | { type: 'started' }
  | { type: 'media-info'; mediaInfo: MediaInfo }
  | { type: 'stats'; stats: PlayerStats }
  | { type: 'warning'; warning: PlayerWarning }
  | { type: 'error'; error: PlayerError }
  | { type: 'reconnecting'; info: ReconnectInfo }
  | { type: 'recovered'; info: RecoveryInfo }
  | { type: 'playback-control'; action: PlaybackControlAction }
  | { type: 'stopped' }
  | { type: 'destroyed' }
