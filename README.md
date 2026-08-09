# Rivmux

Rivmux 是面向现代浏览器的低延迟 HTTP-FLV 播放器。它把网络加载、Rust/WASM 转封装和 MSE 缓冲放在 Dedicated Worker 中，尽量减少直播播放链路对主线程的占用。

当前项目重点是把常见的 HTTP-FLV 直播输入稳定转换为 fragmented MP4，并提供可预测的启动、重连、错误和资源清理行为。Rivmux 适合需要自主管理播放器生命周期、诊断信息和 Worker/WASM 资产的 Web 应用。

## 核心特点

- Dedicated Worker 内完成 HTTP 流式读取、转封装和 Worker MSE 管理。
- Rust 转封装核心编译为 WebAssembly，输入解析与 fMP4 输出具有共享测试契约。
- 面向直播的读空闲检测、指数退避重连和可取消生命周期。
- 结构化事件、warning 和 error，自动播放拒绝不会被误报为媒体终止错误。
- 创建播放器前可同步读取运行环境与解码能力矩阵。

## 支持范围

| 输入                                     | 等级         | 边界                                                 |
| ---------------------------------------- | ------------ | ---------------------------------------------------- |
| HTTP-FLV + AVC/H.264 + AAC-LC            | Stable       | 受浏览器基础 MSE 能力约束                            |
| Enhanced HTTP-FLV + HEVC/`hvc1` + AAC-LC | Stable       | 解码取决于浏览器、操作系统、设备和具体 codec profile |
| Enhanced HTTP-FLV + AV1                  | Experimental | 暂不形成稳定公共承诺                                 |
| Enhanced HTTP-FLV + Opus                 | Experimental | 暂不形成稳定公共承诺                                 |
| MPEG-TS                                  | 不支持       | 明确排除在当前产品输入范围之外                       |

HEVC Stable 表示 Rivmux 对限定输入的解析、`hvc1` 转封装、错误行为和生命周期提供稳定契约，不表示所有环境都具备 HEVC 解码能力。`hev1`、多轨 HEVC、播放期间动态 codec 配置切换以及 HEVC + Opus 不在 Stable 范围内。实际流到达后，Rivmux 会使用准确 codec string 执行最终 MSE 校验；环境不支持时产生 `RIVMUX_UNSUPPORTED_MSE_CODEC`。

## 快速开始

Rivmux 当前仅提供 ESM 包：

```bash
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

await player.attach(video)
await player.start()
```

完整接入方式、能力矩阵、配置、事件和部署要求见 [主包 README](./packages/player/README.md)。

## 工作区结构

| 名称                       | 目录                                                     | 职责                                  |
| -------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `rivmux`                   | [`packages/player`](./packages/player)                   | 面向用户的浏览器播放器入口            |
| `@rivmux/runtime-worker`   | [`packages/runtime-worker`](./packages/runtime-worker)   | Dedicated Worker 运行时与媒体资产     |
| `@rivmux/protocol`         | [`packages/protocol`](./packages/protocol)               | TypeScript 共享类型与 Worker 消息契约 |
| `rivmux_transmux_core`     | [`crates/transmux-core`](./crates/transmux-core)         | Rust/WASM 转封装核心                  |
| `rivmux_transmux_fixtures` | [`crates/transmux-fixtures`](./crates/transmux-fixtures) | 仓库自有媒体验收素材                  |

普通用户只需依赖 `rivmux`；其他包和 crate 主要服务于 Rivmux 内部构建与维护。

## 开发与验证

本仓库使用 `pnpm@10`、TypeScript、Vitest、tsdown 和 Rust 2024 edition。

```bash
pnpm run typecheck
pnpm run clippy
pnpm run test
pnpm run test:browser
pnpm run build
pnpm run build:release
```

浏览器验收使用最终构建的 Worker/WASM 资产。Playground 仅用于开发调试，不属于正式示例或发布验收项。

## 许可证

[Apache License 2.0](./LICENSE)
