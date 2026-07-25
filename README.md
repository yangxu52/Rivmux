# Rivmux

> Modern browser video player workspace for low-latency HTTP-FLV playback and Rust-based transmuxing.

Rivmux 是一个 Node packages + Cargo crates 混合仓库，当前骨架聚焦 HTTP-FLV、Dedicated Worker runtime、TypeScript browser packages 与 Rust transmux core 的边界拆分。

## Packages

| 包名                     | 目录                                                   | 说明                                   |
| ------------------------ | ------------------------------------------------------ | -------------------------------------- |
| `rivmux`                 | [`packages/player`](./packages/player)                 | Public browser player facade.          |
| `@rivmux/runtime-worker` | [`packages/runtime-worker`](./packages/runtime-worker) | Dedicated Worker runtime package.      |
| `@rivmux/protocol`       | [`packages/protocol`](./packages/protocol)             | Side-effect-free TypeScript contracts. |

## Crates

| Crate                      | 目录                                                     | 说明                                  |
| -------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `rivmux_transmux_core`     | [`crates/transmux-core`](./crates/transmux-core)         | Rust transmux core crate.             |
| `rivmux_transmux_fixtures` | [`crates/transmux-fixtures`](./crates/transmux-fixtures) | Repository-owned media fixture crate. |

## Development

本仓库开发与构建基于：

- `pnpm@10`
- `typescript ~6.0.3`
- `tsdown ^0.22.3`
- `vitest ^4.1.9`
- Rust 2024 edition

## Validation Notes

- CI runs package and Rust tests through `pnpm run test:ci`, plus a dedicated Chromium job through `pnpm run test:browser`.
- Release publishing is gated by the same real Chromium playback suite.
- The first-release support contract is HTTP-FLV with H.264/AVC video and optional AAC-LC audio. HEVC, AV1, and Opus paths are experimental internal work and are not public support claims.
- Rust/TypeScript file structure stays compact for M1. Split demuxer/muxer traits and codec subdirectories when MPEG-TS, HEVC, AV1, or additional muxer outputs make the current files too large.
- `packages/protocol/src/index.ts` stays single-file for M1. Split into public types, internal messages, media types, and error codes when the protocol surface grows further.

## Workspace Commands

```bash
pnpm run typecheck
pnpm run clippy
pnpm run test
pnpm run test:browser
pnpm run build
pnpm run build:release
pnpm run build:playground
pnpm run clean
```
