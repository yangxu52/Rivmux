# Rivmux Player

Public browser player facade for Rivmux low-latency live playback.

`rivmux` loads HTTP-FLV streams in a dedicated worker, transmuxes supported
audio/video into fragmented MP4, and attaches the resulting media stream to a
browser `<video>` element.

## Install

```sh
pnpm add rivmux
```

```sh
npm install rivmux
```

## Basic Usage

Always wait for `attach()` before calling `start()`. `attach()` initializes the
worker and connects the internal `MediaSourceHandle` to the video element.

```ts
import { RivmuxPlayer } from 'rivmux'

const video = document.querySelector<HTMLVideoElement>('#player')

if (!video) {
  throw new Error('Missing video element')
}

const player = new RivmuxPlayer('https://example.com/live.flv', {
  playback: {
    muted: true,
  },
})

player.on('mediaInfo', (info) => {
  console.log('media info', info)
})

player.on('error', (error) => {
  console.error(`[${error.code}] ${error.message}`)
})

await player.attach(video)
await player.start()

// Later:
await player.stop()
await player.destroy()
```

## Player Lifecycle

```ts
const player = new RivmuxPlayer(url, options)
```

| Call                              | Description                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `new RivmuxPlayer(url, options?)` | Creates a player instance for one stream URL.                                                            |
| `await player.attach(video)`      | Attaches the player to a `<video>` element and prepares the worker/MSE pipeline.                         |
| `await player.start()`            | Starts loading, transmuxing, buffering, and playback control. Call after `attach()`.                     |
| `await player.stop()`             | Stops loading, detaches the media source, and keeps the instance reusable.                               |
| `await player.destroy()`          | Releases the worker, timers, listeners, and video source. The instance cannot be reused after this call. |
| `player.on(type, listener)`       | Subscribes to a player event.                                                                            |
| `player.off(type, listener)`      | Removes a previously registered listener.                                                                |

## Options

All options are optional. Missing fields are merged with
`DEFAULT_RIVMUX_PLAYER_OPTIONS`.

```ts
import { RivmuxPlayer } from 'rivmux'

const player = new RivmuxPlayer('https://example.com/live.flv', {
  playback: {
    autoPlay: true,
    muted: true,
  },
  latency: {
    startupBuffer: 0.35,
    target: 1.2,
    max: 2.5,
    maxForwardBuffer: 4,
    backwardBuffer: 1.5,
  },
  network: {
    credentials: 'include',
    headers: {
      Authorization: 'Bearer token',
    },
    retry: {
      maxAttempts: 5,
      backoffMs: 500,
    },
  },
  runtime: {
    workerUrl: '/assets/rivmux-runtime-worker.js',
    wasmUrl: '/assets/rivmux-transmux-core.wasm',
  },
  diagnostics: {
    statsIntervalMs: 1000,
    debug: false,
  },
})
```

### `playback`

| Option     | Default | Description                                                                       |
| ---------- | ------- | --------------------------------------------------------------------------------- |
| `autoPlay` | `true`  | Lets the runtime request `video.play()` when enough startup buffer is available.  |
| `muted`    | `false` | Sets `video.muted`. Many browsers require muted playback for autoplay with audio. |

### `latency`

Values are in seconds.

| Option             | Default | Description                                                                                    |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `startupBuffer`    | `0.35`  | Buffered duration required before automatic playback starts.                                   |
| `target`           | `1.2`   | Desired live latency. The runtime uses this when resuming fetches and restoring playback rate. |
| `max`              | `2.5`   | Maximum tolerated live latency before the runtime seeks closer to the live edge.               |
| `maxForwardBuffer` | `4`     | Forward buffer threshold where the loader may pause to avoid excessive buffering.              |
| `backwardBuffer`   | `1.5`   | Amount of buffer to keep behind the current playhead during cleanup.                           |

### `network`

| Option              | Default         | Description                                                       |
| ------------------- | --------------- | ----------------------------------------------------------------- |
| `headers`           | `{}`            | Extra request headers for the HTTP-FLV stream.                    |
| `credentials`       | `'same-origin'` | Fetch credentials mode for stream requests.                       |
| `retry.maxAttempts` | `3`             | Maximum stream request attempts before reporting a network error. |
| `retry.backoffMs`   | `500`           | Base retry delay in milliseconds.                                 |

### `runtime`

| Option            | Default             | Description                                                                                                                                         |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preferWorkerMse` | `true`              | Prefers the worker-backed MSE pipeline when the browser supports it.                                                                                |
| `workerUrl`       | bundled worker URL  | Overrides the worker script URL. Use this when serving worker assets from a fixed public path.                                                      |
| `wasmUrl`         | bundled WASM module | Overrides the WASM asset URL. If provided, the matching wasm-bindgen JS glue file must be available at the same path with `.js` instead of `.wasm`. |
| `wasmModule`      | `undefined`         | Reserved for custom runtime integrations that provide a precompiled `WebAssembly.Module`.                                                           |

### `diagnostics`

| Option            | Default | Description                                                                                                        |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `statsIntervalMs` | `1000`  | Requested stats interval in milliseconds. Runtime reporting is clamped internally for stable video-state feedback. |
| `debug`           | `false` | Enables debug-oriented behavior where supported by the runtime.                                                    |

## Events

```ts
import type { MediaInfo, PlayerError, PlayerStats, PlayerWarning } from 'rivmux'

player.on('ready', () => {})
player.on('mediaInfo', (info: MediaInfo) => {})
player.on('stats', (stats: PlayerStats) => {})
player.on('warning', (warning: PlayerWarning) => {})
player.on('error', (error: PlayerError) => {})
player.on('stopped', () => {})
player.on('destroyed', () => {})
```

| Event       | Payload         | Description                                                             |
| ----------- | --------------- | ----------------------------------------------------------------------- |
| `ready`     | `undefined`     | The worker/runtime is initialized.                                      |
| `mediaInfo` | `MediaInfo`     | Stream container and codec metadata has been detected.                  |
| `stats`     | `PlayerStats`   | Runtime diagnostics such as bytes, buffer, latency, and playback state. |
| `warning`   | `PlayerWarning` | Recoverable issue reported by the runtime.                              |
| `error`     | `PlayerError`   | Runtime, network, demux, codec, mux, MSE, or unsupported-feature error. |
| `stopped`   | `undefined`     | The stream has stopped and the media source has been detached.          |
| `destroyed` | `undefined`     | The worker/runtime has been destroyed.                                  |

## Type Imports

The player package re-exports the key public types from `@rivmux/protocol`:

```ts
import type {
  DiagnosticsOptions,
  LatencyOptions,
  MediaInfo,
  NetworkOptions,
  PlaybackOptions,
  PlayerError,
  PlayerStats,
  PlayerWarning,
  RivmuxPlayerOptions,
  RuntimeOptions,
} from 'rivmux'
```

Use `normalizePlayerOptions(options)` if you need to inspect a fully populated
options object with defaults applied.
