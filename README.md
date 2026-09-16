# Rivmux

> A Rust/WebAssembly-powered, low-latency HTTP-FLV player for modern browsers.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](https://www.apache.org/licenses/LICENSE-2.0)
[![npm version](https://img.shields.io/npm/v/rivmux.svg?style=flat-square&logo=npm)](https://www.npmjs.com/package/rivmux)
![GitHub Stars](https://img.shields.io/github/stars/yangxu52/rivmux.svg?style=flat-square&label=Stars&logo=github)
![GitHub Forks](https://img.shields.io/github/forks/yangxu52/rivmux.svg?style=flat-square&label=Forks&logo=github)

Rivmux（Riv 源自拉丁语 _rivus_，意为“河流”；Mux 指媒体封装/复用；读作 `/ˈrɪvmʌks/`）是一款面向现代浏览器的低延迟 HTTP-FLV 播放器。它在 Dedicated Worker 中读取流数据，通过 Rust/WebAssembly 转封装核心生成 fragmented MP4，再借助 Worker MSE 驱动 `<video>`，使网络读取、媒体处理和 MSE 管理远离主线程。

Rivmux 作为播放器提供明确的生命周期、可调缓冲策略、网络恢复、能力探测和结构化诊断；其他 workspace 包与 Rust crate 主要服务于内部构建和维护。

## 核心能力

- **Worker 媒体管线**：在 Dedicated Worker 中完成流式 Fetch、转封装和 Worker MSE 管理。
- **Rust/WebAssembly 核心**：将 HTTP-FLV 音视频转换为适用于 MSE 的 fragmented MP4。
- **低延迟控制**：支持启动缓冲、目标延迟、直播边缘追帧、读取背压和历史缓冲清理。
- **网络恢复**：提供读空闲检测、指数退避、重试抖动以及可取消的重连流程。
- **结构化诊断**：通过类型化事件报告媒体信息、运行统计、warning、error 和恢复状态。
- **运行前探测**：同步检查基础运行条件和代表性 codec 解码能力，不创建 Worker 或发起网络请求。

## 支持范围

| 输入                                     | 等级         | 边界                                                 |
| ---------------------------------------- | ------------ | ---------------------------------------------------- |
| HTTP-FLV + AVC/H.264 + AAC-LC            | Stable       | 受浏览器基础 MSE 能力约束                            |
| Enhanced HTTP-FLV + HEVC/`hvc1` + AAC-LC | Stable       | 解码取决于浏览器、操作系统、设备和具体 codec profile |
| Enhanced HTTP-FLV + AV1                  | Experimental | 组合、兼容性和长期错误语义尚未形成稳定承诺           |
| Enhanced HTTP-FLV + Opus                 | Experimental | 组合、兼容性和长期错误语义尚未形成稳定承诺           |
| MPEG-TS                                  | 不支持       | 不属于当前产品输入边界                               |

`Stable` 表示 Rivmux 对限定输入的解析、转封装、错误行为和生命周期提供稳定契约，不表示所有浏览器环境都具备对应的解码能力。实际流到达后，Rivmux 会使用准确 codec string 执行最终 MSE 校验。

HEVC Stable 限于单视频轨、固定 codec 配置、Enhanced FLV `SequenceStart`、`CodedFrames` 和 HEVC `CodedFramesX`，输出 sample entry 为 `hvc1`。`hev1`、多轨 HEVC、播放期间动态 codec 配置切换以及 HEVC + Opus 不属于 Stable 范围；AV1 和 Opus 仍为 Experimental。

## 快速开始

`rivmux` 以 ESM-only 格式发布，面向浏览器 ESM Bundler。Vite 已完成验证；Node.js 仅支持 ESM 导入以及 SSR/能力探测调用，不提供播放运行时。浏览器播放依赖 Dedicated Worker、Worker MSE、流式 Fetch、ReadableStream 和 WebAssembly，当前没有主线程 MSE 降级路径。

```sh
pnpm add rivmux
```

```ts
import { RivmuxPlayer, isSupported } from 'rivmux'

if (!isSupported()) {
  throw new Error('当前浏览器不具备 Rivmux 基础运行能力')
}

const video = document.querySelector<HTMLVideoElement>('#player')

if (!video) {
  throw new Error('未找到 video 元素')
}

const player = new RivmuxPlayer('https://example.com/live.flv', {
  playback: { muted: true },
})

player.on('error', (error) => {
  console.error(`[${error.code}] ${error.message}`)
})

await player.attach(video)
await player.start()
```

完整接入方式、能力矩阵、配置、事件、错误和部署要求见 [Rivmux Player README](./packages/player/README.md)。

## 工作区结构

| 组件                       | 边界     | 目录                                                     | 职责                                  |
| -------------------------- | -------- | -------------------------------------------------------- | ------------------------------------- |
| `rivmux`                   | Public   | [`packages/player`](./packages/player)                   | 面向应用的浏览器播放器入口            |
| `@rivmux/runtime-worker`   | Internal | [`packages/runtime-worker`](./packages/runtime-worker)   | Dedicated Worker 运行时与媒体资产     |
| `@rivmux/protocol`         | Internal | [`packages/protocol`](./packages/protocol)               | TypeScript 共享类型与 Worker 消息契约 |
| `rivmux_transmux_core`     | Internal | [`crates/transmux-core`](./crates/transmux-core)         | Rust/WebAssembly 转封装核心           |
| `rivmux_transmux_fixtures` | Internal | [`crates/transmux-fixtures`](./crates/transmux-fixtures) | 仓库自有媒体验收素材                  |

普通应用不应直接依赖 Internal 组件；所需运行时、资产和公共类型均由 `rivmux` 统一提供。

## 开发与验证

开发环境需要 Node.js `^22.18.0 || >=24.11.0`、pnpm `>=10.0.0`、支持 Rust 2024 edition 的 Rust toolchain，以及 `wasm-pack`。

```sh
pnpm install
```

首次运行浏览器测试前安装 Playwright Chromium：

```sh
pnpm exec playwright install chromium
```

Linux 环境可能还需要按照 Playwright 文档安装系统依赖。

仓库级质量门禁：

```sh
pnpm run format:check
pnpm run lint:check
pnpm run typecheck
pnpm run clippy
pnpm run test
pnpm run build
pnpm run test:browser
```

`pnpm run test:browser` 会先执行 `pnpm run build`，再使用构建后的 Worker/WASM 资产验证真实播放链路；`pnpm run test` 覆盖 TypeScript packages、workspace 集成测试和 Rust workspace。

## 许可证

[Apache License 2.0](./LICENSE)
