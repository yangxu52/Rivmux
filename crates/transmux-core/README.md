# Rivmux Transmux Core

`rivmux_transmux_core` 是 Rivmux 的 Rust/WASM 转封装核心，负责增量解析 HTTP-FLV、归一化音视频数据，并生成 fragmented MP4 初始化片段和媒体片段。

## 使用边界

- Rust 入口 `TransmuxCore` 提供增量输入、事件输出和状态重置能力，主要供仓库测试和 WASM 适配层使用。
- WASM 入口 `WasmTransmuxCore` 由私有 workspace 包 `@rivmux/transmux-core` 构建，再由 [`@rivmux/runtime-worker`](../../packages/runtime-worker/README.md) 在 Dedicated Worker 中加载。
- 普通应用不应直接依赖 Rust crate、WASM 包装层或生成资产；用户入口和完整播放行为以 [`rivmux`](../../packages/player/README.md) 为准。

## 处理链路

```text
HTTP-FLV -> demux -> codec normalization -> track/sample -> fMP4 mux -> CoreEvent
```

Core 将容器输入转换为 `MediaInfo`、初始化片段、媒体片段、warning 和结构化错误等事件。网络加载、MSE、播放控制和浏览器能力判断由 Runtime Worker 与主包负责。

## 能力边界

| 层级              | 范围                                           | 说明                                       |
| ----------------- | ---------------------------------------------- | ------------------------------------------ |
| 主包 Stable       | HTTP-FLV + AVC/H.264 + AAC-LC                  | 受浏览器基础 MSE 能力约束。                |
| 主包条件化 Stable | Enhanced HTTP-FLV + HEVC/`hvc1` + AAC-LC       | 最终解码取决于环境和具体 codec profile。   |
| Core 实现层能力   | Enhanced `avc1`、AV1、Opus                     | 不自动构成主包 Stable 输入或组合兼容承诺。 |
| 当前产品范围外    | MPEG-TS、`hev1`、多轨、播放期间动态 codec 配置 | 不属于当前公开输入契约。                   |

HEVC 输出固定使用 `hvc1`。Core 负责生成准确 codec 信息，上层在实际流到达后执行最终 MSE MIME 校验。AV1 和 Opus 保持 Experimental。

## 内部媒体契约

- 解复用器必须先发出 `TrackConfig`，再发出属于该轨道的 `EncodedSample`。
- `TrackClock` 同时记录输入容器和 fMP4 的时标，时间线换算必须显式完成。
- codec 归一化器只产生 codec 配置与 `EncodedSample`，不依赖 FLV 标签或 fMP4 事件。
- `VideoCodecConfig` 和 `AudioCodecConfig` 保持容器无关；sample entry 与带内、带外配置由对应 codec 实现决定。

## 构建与验证

在仓库根目录执行：

```bash
cargo test -p rivmux_transmux_core
cargo clippy -p rivmux_transmux_core --all-targets --all-features -- -D warnings
pnpm --filter @rivmux/transmux-core run build
```

`pnpm` 构建通过 `wasm-pack` 生成 wasm-bindgen JavaScript 胶水、TypeScript 声明和 WASM 二进制。Runtime Worker 必须使用同一次构建产生的胶水代码与 WASM 资产。

## 许可证

[Apache License 2.0](./LICENSE)
