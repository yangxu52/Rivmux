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

| Crate                      | 目录                                                     | 说明                               |
| -------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `rivmux_transmux_core`     | [`crates/transmux-core`](./crates/transmux-core)         | Rust transmux core crate.          |
| `rivmux_transmux_fixtures` | [`crates/transmux-fixtures`](./crates/transmux-fixtures) | Reserved fixture generation crate. |

## Development

本仓库开发与构建基于：

- `pnpm@10`
- `typescript ~6.0.3`
- `tsdown ^0.22.3`
- `vitest ^4.1.9`
- Rust 2024 edition

## Validation Notes

- CI runs package tests and Rust tests through `pnpm run test:ci`.
- Browser tests are local and release-before-cut validation items for now because installing Playwright browsers is slow and can stall CI. Future options are a separate workflow, manual trigger, browser cache, or nightly run.
- Rust/TypeScript file structure stays compact for M1. Split demuxer/muxer traits and codec subdirectories when MPEG-TS, HEVC, AV1, or additional muxer outputs make the current files too large.
- `packages/protocol/src/index.ts` stays single-file for M1. Split into public types, internal messages, media types, and error codes when the protocol surface grows further.

## Workspace Commands

```bash
pnpm run typecheck
pnpm run clippy
pnpm run test
pnpm run build
pnpm run build:release
pnpm run build:playground
pnpm run clean
```
