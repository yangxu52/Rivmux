# Rivmux Player

Public browser player facade for Rivmux low-latency live playback.

`rivmux` loads HTTP-FLV streams in a dedicated worker, transmuxes supported
audio/video into fragmented MP4, and attaches the resulting media stream to a
browser `<video>` element.

M1 supports only the dedicated-worker MSE runtime path. Main-thread MSE is not available.

The first-release support contract is HTTP-FLV with H.264/AVC video and optional
AAC-LC audio. MPEG-TS is roadmap work. Existing HEVC, AV1, and Opus core paths
are experimental internals and are not supported public inputs.

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

`attach()` 完成只表示媒体源句柄已经连接；`start()` 完成只表示 Worker 已建立本次启动所需的内部加载、转封装和 MSE 会话。两者都不表示已经解析出媒体信息、已经追加首个媒体片段，也不表示 `<video>` 已触发 `canplay` 或开始播放。请通过 `mediaInfo`、`stats`、`error` 和视频元素事件观察后续结果。

同一启动过程中的并发 `start()` 调用会等待同一个操作，不会重复发送启动命令。播放器已经启动后再次调用 `start()` 会直接完成。若 `stop()` 或 `destroy()` 在启动确认前开始，待处理的 `start()` 会以 `RIVMUX_START_CANCELLED` 拒绝，而停止或销毁操作仍会正常完成。终止错误会使 `start()` 以相同错误码拒绝。

上述规则收紧了旧版本中“发送启动命令后立即完成”的时序；依赖旧时序的调用方应改为等待 `start()`，并将媒体就绪逻辑放到对应事件中。

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
    readIdleTimeoutMs: 10000,
    headers: {
      Authorization: 'Bearer token',
    },
    retry: {
      maxAttempts: 5,
      backoffMs: 500,
      maxBackoffMs: 8000,
      jitterRatio: 0.2,
    },
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

| Option               | Default         | Description                                                                              |
| -------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `headers`            | `{}`            | HTTP-FLV 请求附带的额外请求头。                                                          |
| `credentials`        | `'same-origin'` | Fetch 请求的 credentials 模式。                                                          |
| `readIdleTimeoutMs`  | `10000`         | 主动读取期间持续无数据的超时时间；Loader 因背压暂停时不计时。                            |
| `retry.maxAttempts`  | `3`             | 单次故障恢复周期允许的连接总次数，包含发生故障的当前连接；成功恢复后下一次故障重新计数。 |
| `retry.backoffMs`    | `500`           | 指数退避的基础延迟，单位为毫秒。                                                         |
| `retry.maxBackoffMs` | `8000`          | 应用抖动后的最大退避延迟，单位为毫秒。                                                   |
| `retry.jitterRatio`  | `0.2`           | 对称抖动比例，取值范围为 `0` 至 `1`；`0` 表示关闭抖动。                                  |

### `runtime`

| Option            | Default             | Description                                                                                                               |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `preferWorkerMse` | `true`              | Must remain `true` in M1. Main-thread MSE fallback is not implemented.                                                    |
| `workerUrl`       | bundled worker URL  | Advanced override for the packaged Dedicated Worker script URL.                                                           |
| `wasmUrl`         | bundled WASM module | Advanced override for the packaged WASM binary URL. It must match the Worker release that contains the wasm-bindgen glue. |

### Advanced Asset Deployment

Most applications should omit `runtime.workerUrl` and `runtime.wasmUrl`. The
default package assets are tracked by Vite and emitted with the application
build.

Set these options only when your deployment serves Rivmux assets from a fixed
public path or CDN:

```ts
const player = new RivmuxPlayer('https://example.com/live.flv', {
  runtime: {
    workerUrl: 'https://cdn.example.com/rivmux/0.4.0/rivmux-runtime-worker.js',
    wasmUrl: 'https://cdn.example.com/rivmux/0.4.0/rivmux-transmux-core.wasm',
  },
})
```

`workerUrl` does not derive `wasmUrl`; when you override both assets, publish
them as a matching release pair. Treat both URLs as trusted executable asset
locations and never construct them from untrusted input. The host application
is responsible for compatible CSP and CORS policies, serving the WASM asset as
`application/wasm`, and cache-busting the Worker/WASM pair together.

### `diagnostics`

| Option            | Default | Description                                                                                                        |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `statsIntervalMs` | `1000`  | Requested stats interval in milliseconds. Runtime reporting is clamped internally for stable video-state feedback. |
| `debug`           | `false` | Enables debug-oriented behavior where supported by the runtime.                                                    |

## Events

```ts
import type { MediaInfo, PlayerError, PlayerStats, PlayerWarning, ReconnectInfo, RecoveryInfo } from 'rivmux'

player.on('ready', () => {})
player.on('mediaInfo', (info: MediaInfo) => {})
player.on('stats', (stats: PlayerStats) => {})
player.on('warning', (warning: PlayerWarning) => {})
player.on('reconnecting', (info: ReconnectInfo) => {})
player.on('recovered', (info: RecoveryInfo) => {})
player.on('error', (error: PlayerError) => {})
player.on('stopped', () => {})
player.on('destroyed', () => {})
```

| Event          | Payload         | Description                                                        |
| -------------- | --------------- | ------------------------------------------------------------------ |
| `ready`        | `undefined`     | Worker runtime 已初始化。                                          |
| `mediaInfo`    | `MediaInfo`     | 已识别媒体容器和 codec 信息。                                      |
| `stats`        | `PlayerStats`   | 字节数、缓冲、延迟和播放状态等运行时统计。                         |
| `warning`      | `PlayerWarning` | Runtime 报告的可恢复问题。                                         |
| `reconnecting` | `ReconnectInfo` | 已确定执行下一次连接，并给出连接序号、最大次数、延迟和故障原因。   |
| `recovered`    | `RecoveryInfo`  | 新会话的首个媒体片段已经成功追加；仅建立 HTTP 连接不会触发该事件。 |
| `error`        | `PlayerError`   | Runtime、网络、demux、codec、mux、MSE 或环境不支持错误。           |
| `stopped`      | `undefined`     | 播放已停止，媒体源已解绑。                                         |
| `destroyed`    | `undefined`     | Worker runtime 已销毁。                                            |

用户事件监听器中的异常属于宿主应用异常，不属于 Rivmux 播放错误，也不会转换为 `PlayerError`。单个监听器抛出异常时，其他监听器仍会继续执行，`stop()`、`destroy()` 等生命周期 Promise 也会按内部状态正常完成。Rivmux 会优先通过平台的 `globalThis.reportError()` 报告该异常；平台不支持时使用 `console.error()` 降级报告。

## 直播连接恢复

Rivmux 会为以下直播网络故障重建 Loader、转封装核心和 MSE 播放会话：

- HTTP `408`、`429` 和 `5xx`。
- 建连或读取阶段的网络异常。
- 已建立直播流后的异常 EOF。
- 主动读取期间超过 `network.readIdleTimeoutMs` 未收到数据。

HTTP `401`、`403` 和其他不可恢复的 `4xx` 不会重试。媒体解析、codec、mux 和 MSE 错误也不进入网络恢复流程。恢复次数耗尽后会产生一次终止错误 `RIVMUX_RECONNECT_EXHAUSTED`。

恢复采用指数退避、最大延迟和抖动。等待重连或重建会话期间调用 `stop()` 或 `destroy()` 会立即取消恢复，不会继续创建连接。恢复会更换 `MediaSourceHandle`，因此可能出现短暂中断和时间线重置；当前不承诺无缝续播或跨连接连续时间线。

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
  ReconnectInfo,
  ReconnectReason,
  RecoveryInfo,
  RivmuxPlayerOptions,
  RuntimeOptions,
} from 'rivmux'
```

Use `normalizePlayerOptions(options)` if you need to inspect a fully populated
options object with defaults applied.
