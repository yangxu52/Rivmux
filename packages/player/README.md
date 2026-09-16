# Rivmux Player

> A Rust/WebAssembly-powered, low-latency HTTP-FLV player for modern browsers.

`rivmux`（Riv 源自拉丁语 _rivus_，意为“河流”；Mux 指媒体封装/复用；读作 `/ˈrɪvmʌks/`）是一款面向现代浏览器的低延迟 HTTP-FLV 播放器。它在 Dedicated Worker 中读取流数据，通过 Rust/WebAssembly 转封装核心生成 fragmented MP4，再借助 Worker MSE 驱动 `<video>`。网络读取与媒体处理远离主线程，同时向应用提供清晰的生命周期、可调缓冲策略和结构化诊断。

## 安装与运行要求

```sh
pnpm add rivmux
```

`rivmux` 以 ESM-only 格式发布，面向浏览器 ESM Bundler，不提供 CommonJS、UMD 或全局变量构建。Vite 已完成验证，其他 bundler 暂不形成兼容承诺。

Node.js 仅支持 ESM 导入以及 SSR/能力探测调用，不提供播放运行时。浏览器播放依赖 Dedicated Worker、Worker MSE、流式 Fetch、ReadableStream 和 WebAssembly；当前没有主线程 MSE 降级路径。

## 快速开始

调用 `start()` 前必须等待 `attach()` 完成。`attach()` 会初始化 Worker，并将内部 `MediaSourceHandle` 连接到 `<video>` 元素。

```ts
import { RivmuxPlayer } from 'rivmux'

const video = document.querySelector<HTMLVideoElement>('#player')

if (!video) {
  throw new Error('未找到 video 元素')
}

const player = new RivmuxPlayer('https://example.com/live.flv', {
  playback: {
    muted: true,
  },
})

player.on('mediaInfo', (info) => {
  console.log('媒体信息', info)
})

player.on('error', (error) => {
  console.error(`[${error.code}] ${error.message}`)
})

await player.attach(video)
await player.start()

// 不再使用时：
await player.stop()
await player.destroy()
```

## 支持范围与能力探测

### Codec 支持边界

| 输入                                     | 等级         | 说明                               |
| ---------------------------------------- | ------------ | ---------------------------------- |
| HTTP-FLV + AVC/H.264 + AAC-LC            | Stable       | 受浏览器基础 MSE 能力约束          |
| Enhanced HTTP-FLV + HEVC/`hvc1` + AAC-LC | Stable       | 浏览器解码能力是条件化的           |
| Enhanced HTTP-FLV + AV1                  | Experimental | 实现层实验能力，组合与兼容性未承诺 |
| Enhanced HTTP-FLV + Opus                 | Experimental | 实现层实验能力，组合与兼容性未承诺 |
| MPEG-TS                                  | 不支持       | 不属于当前产品输入边界             |

HEVC Stable 的具体范围是单视频轨、固定 codec 配置、Enhanced FLV `SequenceStart`、`CodedFrames` 和 HEVC `CodedFramesX`，输出 sample entry 为 `hvc1`。最终解码能力取决于浏览器、操作系统、设备以及具体 HEVC profile、level、bit depth 和 chroma format；Rivmux 不维护固定 profile/level allowlist。结构合法但环境不支持准确 MIME 时会产生终止错误 `RIVMUX_UNSUPPORTED_MSE_CODEC`。

`hev1`、多轨 HEVC、播放期间动态 codec 配置切换和 HEVC + Opus 不属于 Stable 范围。AV1 与 Opus 仍为 Experimental；当前未承诺它们与其他音视频 codec 的组合、浏览器兼容矩阵或稳定错误语义。

### 运行环境探测

创建播放器前可同步读取基础运行环境和解码能力：

```ts
import { getCapabilities, isSupported } from 'rivmux'

if (!isSupported()) {
  throw new Error('当前环境不具备 Rivmux 基础运行能力')
}

const capabilities = getCapabilities()
console.log(capabilities.decoding.stableProfiles.hevcAac)
```

```ts
type SupportStatus = 'supported' | 'unsupported' | 'unknown'

type RivmuxCapabilities = {
  supported: boolean
  runtime: {
    dedicatedWorker: boolean
    workerMse: boolean
    fetchStreaming: boolean
    readableStream: boolean
    webAssembly: boolean
  }
  decoding: {
    video: {
      avc: SupportStatus
      hevc: SupportStatus
      av1: SupportStatus
    }
    audio: {
      aac: SupportStatus
      opus: SupportStatus
    }
    stableProfiles: {
      avcAac: SupportStatus
      hevcAac: SupportStatus
    }
  }
}
```

`isSupported()` 始终等于 `getCapabilities().supported`。这里的 `supported` 只表示基础运行条件可用，不保证具体媒体流能够播放。

解码矩阵通过同步的 `MediaSource.isTypeSupported()` 对代表性 codec 执行前置判断：`supported` 表示环境报告支持，`unsupported` 表示环境明确拒绝，`unknown` 表示 API 不可用或无法可靠判断。该结果不会改变输入的 Stable、Experimental 或不支持边界，也不替代真实流校验。Rivmux 取得实际 codec、profile 和 level 后，仍会使用准确 MIME 做最终 MSE 校验。

能力探测不会创建 Worker、发起网络请求或修改 DOM。在 SSR 和 Node.js 环境中调用不会抛错：基础能力为 `false`，无法判断的解码能力为 `unknown`。

## 播放器生命周期

```ts
const player = new RivmuxPlayer(url, options)
```

| 调用或属性                        | 含义                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `new RivmuxPlayer(url, options?)` | 为一个流地址创建播放器实例。                                 |
| `player.url`                      | 构造播放器时传入的只读流地址。                               |
| `await player.attach(video)`      | 绑定 `<video>` 元素并准备 Worker/MSE 链路。                  |
| `await player.start()`            | 启动加载、转封装、缓冲与播放控制；必须在 `attach()` 后调用。 |
| `await player.stop()`             | 停止加载并解绑媒体源；无需重新 `attach()` 即可再次启动。     |
| `await player.destroy()`          | 释放 Worker、定时器、监听器和媒体源；实例不可再用。          |
| `player.on(type, listener)`       | 订阅播放器事件。                                             |
| `player.off(type, listener)`      | 移除先前注册的监听器。                                       |

`attach()` 完成只表示媒体源句柄已经连接；`start()` 完成只表示 Worker 已建立本次启动所需的加载、转封装和 MSE 会话。两者都不表示已经解析出媒体信息、已经追加首个媒体片段，也不表示 `<video>` 已触发 `canplay` 或开始播放。请通过 `mediaInfo`、`stats`、`error` 和 video 元素事件观察后续结果。

同一启动过程中的并发 `start()` 调用会等待同一个操作，不会重复发送启动命令。播放器已经启动后再次调用 `start()` 会直接完成。若 `stop()` 或 `destroy()` 在启动确认前开始，待处理的 `start()` 会以 `RIVMUX_START_CANCELLED` 拒绝，而停止或销毁操作仍会正常完成。启动确认前发生的终止错误会使待处理的 `start()` 以相同错误码拒绝；启动确认后的错误通过 `error` 事件报告。

## 配置

所有配置均为可选项，缺省字段会由播放器内部默认值补齐。

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
  },
})
```

### `playback`

| 配置项     | 默认值  | 含义                                                                 |
| ---------- | ------- | -------------------------------------------------------------------- |
| `autoPlay` | `true`  | 启动缓冲足够时，由运行时请求 `video.play()`。                        |
| `muted`    | `false` | 设置 `video.muted`；浏览器通常要求媒体静音后才能无用户手势自动播放。 |

### `latency`

以下数值单位均为秒。

| 配置项             | 默认值 | 含义                                             |
| ------------------ | ------ | ------------------------------------------------ |
| `startupBuffer`    | `0.35` | 发起自动播放前需要的缓冲时长。                   |
| `target`           | `1.2`  | 目标直播延迟；恢复读取和播放速率时使用。         |
| `max`              | `2.5`  | 最大可接受直播延迟；超过后向直播边缘追帧。       |
| `maxForwardBuffer` | `4`    | 前向缓冲上限；Loader 可暂停读取以避免过度缓冲。  |
| `backwardBuffer`   | `1.5`  | 清理缓冲时在当前播放位置之前保留的历史缓冲时长。 |

### `network`

| 配置项               | 默认值          | 含义                                                                                     |
| -------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `headers`            | `{}`            | HTTP-FLV 请求附带的额外请求头。                                                          |
| `credentials`        | `'same-origin'` | Fetch 请求的 credentials 模式。                                                          |
| `readIdleTimeoutMs`  | `10000`         | 主动读取期间持续无数据的超时时间；Loader 因背压暂停时不计时。                            |
| `retry.maxAttempts`  | `3`             | 单次故障恢复周期允许的连接总次数，包含发生故障的当前连接；成功恢复后下一次故障重新计数。 |
| `retry.backoffMs`    | `500`           | 指数退避的基础延迟，单位为毫秒。                                                         |
| `retry.maxBackoffMs` | `8000`          | 应用抖动后的最大退避延迟，单位为毫秒。                                                   |
| `retry.jitterRatio`  | `0.2`           | 对称抖动比例，取值范围为 `0` 至 `1`；`0` 表示关闭抖动。                                  |

跨源 HTTP-FLV 地址必须满足浏览器 CORS 规则。使用自定义请求头或 `credentials: 'include'` 时，流服务还需正确处理预检请求并允许相应的请求头和凭据；配置错误可能表现为网络异常并进入重试，但不会通过重连自行恢复。

### `runtime`

`runtime.workerUrl` 和 `runtime.wasmUrl` 是 Experimental 资产部署覆盖项；它们嵌套在稳定的 `RivmuxPlayerOptions` 形状中，但不改变当前固定的 Worker MSE runtime，也不承诺跨 bundler、CSP 或部署方式的长期兼容性。

| 配置项      | 默认值             | 含义                                                                          |
| ----------- | ------------------ | ----------------------------------------------------------------------------- |
| `workerUrl` | 包内 Worker URL    | 高级配置，用于覆盖包内 Dedicated Worker 脚本 URL。                            |
| `wasmUrl`   | 包内 WASM 模块 URL | 高级配置，用于覆盖 WASM URL；必须与包含 wasm-bindgen 胶水的 Worker 版本匹配。 |

### `diagnostics`

| 配置项            | 默认值 | 含义                                                         |
| ----------------- | ------ | ------------------------------------------------------------ |
| `statsIntervalMs` | `1000` | 请求的统计上报间隔，单位为毫秒；运行时会在内部限制实际范围。 |

## 事件与错误

### 事件

```ts
import type { MediaInfo, PlayerError, PlayerStats, PlayerWarning, ReconnectInfo, RecoveryInfo } from 'rivmux'

player.on('initialized', () => {})
player.on('mediaInfo', (info: MediaInfo) => {})
player.on('stats', (stats: PlayerStats) => {})
player.on('warning', (warning: PlayerWarning) => {})
player.on('reconnecting', (info: ReconnectInfo) => {})
player.on('recovered', (info: RecoveryInfo) => {})
player.on('error', (error: PlayerError) => {})
player.on('stopped', () => {})
player.on('destroyed', () => {})
```

| 事件           | 数据            | 含义                                                                                                         |
| -------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `initialized`  | `undefined`     | `attach()` 期间所选 runtime 完成 `init` 后触发；同一 runtime 实例只触发一次，不表示 `canplay` 或 `playing`。 |
| `mediaInfo`    | `MediaInfo`     | 已识别媒体容器和 codec 信息。                                                                                |
| `stats`        | `PlayerStats`   | 字节数、缓冲、延迟和播放状态等运行时统计。                                                                   |
| `warning`      | `PlayerWarning` | Runtime 报告的可恢复问题。                                                                                   |
| `reconnecting` | `ReconnectInfo` | 已确定执行下一次连接，并给出连接序号、最大次数、延迟和故障原因。                                             |
| `recovered`    | `RecoveryInfo`  | 新会话的首个媒体片段已经成功追加；仅建立 HTTP 连接不会触发该事件。                                           |
| `error`        | `PlayerError`   | Runtime、网络、demux、codec、mux、MSE 或环境不支持错误。                                                     |
| `stopped`      | `undefined`     | 播放已停止，媒体源已解绑。                                                                                   |
| `destroyed`    | `undefined`     | Worker runtime 已销毁。                                                                                      |

用户事件监听器中的异常属于宿主应用异常，不属于 Rivmux 播放错误，也不会转换为 `PlayerError`。单个监听器抛出异常时，其他监听器仍会继续执行，`stop()`、`destroy()` 等生命周期 Promise 也会按内部状态正常完成。Rivmux 会优先通过平台的 `globalThis.reportError()` 报告该异常；平台不支持时使用 `console.error()` 降级报告。

### 错误与 warning

`error` 事件提供结构化的 `PlayerError`，`warning` 事件提供可恢复的 `PlayerWarning`：

```ts
type PlayerErrorKind = 'network' | 'unsupported' | 'demux' | 'codec' | 'mux' | 'mse' | 'runtime'

type PlayerErrorCause = {
  name: string
  message: string
}

type PlayerError = {
  kind: PlayerErrorKind
  code: string
  message: string
  terminal: boolean
  cause?: PlayerErrorCause
}

type PlayerWarning = {
  code: string
  message: string
  cause?: PlayerErrorCause
}
```

`terminal: true` 表示当前播放器实例不能继续正常工作。非终止错误仍通过 `error` 事件报告；warning 不会进入终止错误路径。

当前 Stable error/warning code 如下：

| 类别           | code                                 | 说明                                                 |
| -------------- | ------------------------------------ | ---------------------------------------------------- |
| 生命周期与调用 | `RIVMUX_ALREADY_ATTACHED`            | 播放器已绑定其他 video 元素，不能重复绑定。          |
| 生命周期与调用 | `RIVMUX_START_REQUIRES_ATTACH`       | 尚未成功完成 `attach()` 就调用了 `start()`。         |
| 生命周期与调用 | `RIVMUX_START_CANCELLED`             | 待处理的 `start()` 被 `stop()` 或 `destroy()` 取消。 |
| 生命周期与调用 | `RIVMUX_PLAYER_STOPPING`             | `stop()` 尚未完成时调用了冲突的生命周期操作。        |
| 生命周期与调用 | `RIVMUX_PLAYER_DESTROYING`           | `destroy()` 进行中，播放器已不再接受新操作。         |
| 生命周期与调用 | `RIVMUX_PLAYER_DESTROYED`            | 播放器已销毁，实例不能继续使用。                     |
| 配置           | `RIVMUX_INVALID_LATENCY_OPTION`      | 延迟配置数值无效或配置项之间不满足约束。             |
| 配置           | `RIVMUX_INVALID_NETWORK_OPTION`      | 读取超时或重试配置无效。                             |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_WORKER`          | 当前环境不支持 Dedicated Worker。                    |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_FETCH`           | 当前环境不具备所需的流式 Fetch 能力。                |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_READABLE_STREAM` | 当前环境不支持 `ReadableStream`。                    |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_WASM`            | 当前环境不支持 WebAssembly。                         |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_MSE`             | 当前环境不支持 Media Source Extensions。             |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_WORKER_MSE`      | Dedicated Worker 中无法构造 `MediaSource`。          |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_MSE_TYPE_CHECK`  | 当前环境缺少 `MediaSource.isTypeSupported()`。       |
| 能力与媒体     | `RIVMUX_UNSUPPORTED_MSE_CODEC`       | MSE 不支持实际媒体流对应的准确 codec MIME。          |
| 运行行为       | `RIVMUX_RECONNECT_EXHAUSTED`         | 当前故障恢复周期已用尽允许的连接次数。               |
| warning        | `RIVMUX_AUTOPLAY_REJECTED`           | 浏览器拒绝自动播放，可在用户手势中恢复播放。         |

未列出的 Worker、Loader、MSE 队列和内部生命周期错误码属于内部实现，应用不应依赖其具体字符串。

## 常见运行行为

### 自动播放拒绝

浏览器可能根据自动播放策略拒绝 Rivmux 请求的 `video.play()`。无用户手势的直播场景建议设置 `playback.muted: true`，以提高自动播放成功率。拒绝会产生非终止 warning `RIVMUX_AUTOPLAY_REJECTED`，其 `cause` 保留浏览器错误的 `name` 和 `message`；该 warning 不会中断网络加载、转封装或缓冲，也不会触发 `error` 事件。

Rivmux 在同一播放会话中不会自动重复调用 `play()`。调用方可以在按钮点击等真实用户手势处理器内直接恢复：

```ts
button.addEventListener('click', () => {
  void video.play()
})
```

设置 `playback.autoPlay: false` 后，Rivmux 不会主动请求启动播放，也不会产生该 warning。

### 直播连接恢复

Rivmux 会为以下直播网络故障重建 Loader、转封装核心和 MSE 播放会话：

- HTTP `408`、`429` 和 `5xx`。
- 建连或读取阶段的网络异常。
- 已建立直播流后的异常 EOF。
- 主动读取期间超过 `network.readIdleTimeoutMs` 未收到数据。

HTTP `401`、`403` 和其他不可恢复的 `4xx` 不会重试。媒体解析、codec、mux 和 MSE 错误也不进入网络恢复流程。恢复次数耗尽后会产生一次终止错误 `RIVMUX_RECONNECT_EXHAUSTED`。

恢复采用指数退避、最大延迟和抖动。等待重连或重建会话期间调用 `stop()` 或 `destroy()` 会立即取消恢复，不会继续创建连接。恢复会更换 `MediaSourceHandle`，因此可能出现短暂中断和时间线重置；当前不承诺无缝续播或跨连接连续时间线。

## Worker/WASM 部署

多数应用无需设置 `runtime.workerUrl` 和 `runtime.wasmUrl`。默认资产 URL 会被 Vite 跟踪，并随应用构建输出。

只有在固定公共路径或 CDN 部署 Rivmux 资产时才需要覆盖：

```ts
const player = new RivmuxPlayer('https://example.com/live.flv', {
  runtime: {
    workerUrl: 'https://cdn.example.com/rivmux/<version>/rivmux-runtime-worker.js',
    wasmUrl: 'https://cdn.example.com/rivmux/<version>/rivmux-transmux-core.wasm',
  },
})
```

`workerUrl` 不会推导 `wasmUrl`。覆盖两项时必须发布同一版本的 Worker/WASM 资产对，并使用相同缓存版本策略。两者都是可执行资产地址，不得由不可信输入拼接。`workerUrl` 还必须满足目标浏览器对 module Dedicated Worker 的加载限制；不允许直接加载跨源 Worker 时，应通过同源公共路径提供该脚本。宿主应用需配置兼容的 CSP 和 CORS，并以 `application/wasm` 提供 WASM 文件。

## 公共类型

主包会重新导出以下 Stable 类型：

```ts
import type {
  DecodingCapabilities,
  DiagnosticsOptions,
  LatencyOptions,
  MediaInfo,
  NetworkOptions,
  PlaybackOptions,
  PlayerError,
  PlayerErrorCause,
  PlayerErrorKind,
  PlayerEventListener,
  PlayerEventMap,
  PlayerEventType,
  PlayerStats,
  PlayerWarning,
  ReconnectInfo,
  ReconnectReason,
  RecoveryInfo,
  RivmuxCapabilities,
  RivmuxPlayerOptions,
  RuntimeCapabilities,
  SupportStatus,
} from 'rivmux'
```

`RivmuxPlayerOptions` 的整体配置形状属于 Stable，其中嵌套的 `runtime` 字段用于承载 Experimental 资产部署选项。主包也会导出对应的 Experimental 类型：

```ts
import type { RuntimeOptions } from 'rivmux'
```

配置归一化、错误构造函数和 Worker 通信契约属于内部实现，不构成应用 API。

## 许可证

[Apache License 2.0](./LICENSE)
