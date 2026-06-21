# Rivmux

> Modern browser video player workspace for low-latency HTTP-FLV playback and Rust-based transmuxing.

Rivmux 是一个 Node packages + Cargo crates 混合仓库，当前骨架聚焦 HTTP-FLV、Dedicated Worker runtime、TypeScript browser packages 与 Rust transmux core 的边界拆分。

## Packages

| 包名                    | 目录                                                   | 说明                                   |
| ----------------------- | ------------------------------------------------------ | -------------------------------------- |
| `rivmux-player`         | [`packages/player`](./packages/player)                 | Public browser player facade.          |
| `rivmux-runtime-worker` | [`packages/runtime-worker`](./packages/runtime-worker) | Dedicated Worker runtime package.      |
| `rivmux-shared`         | [`packages/shared`](./packages/shared)                 | Side-effect-free TypeScript contracts. |

## Crates

| Crate                      | 目录                                                     | 说明                       |
| -------------------------- | -------------------------------------------------------- | -------------------------- |
| `rivmux_transmux_core`     | [`crates/transmux-core`](./crates/transmux-core)         | Rust transmux core crate.  |
| `rivmux_transmux_fixtures` | [`crates/transmux-fixtures`](./crates/transmux-fixtures) | Fixture helpers for tests. |

## Development

本仓库开发与构建基于：

- `pnpm@10`
- `typescript ~5.9.3`
- `tsdown ^0.22.3`
- `vitest ^4.1.9`
- Rust 2024 edition

## Workspace Commands

```bash
pnpm run typecheck
pnpm run clippy
pnpm run test
pnpm run build
pnpm run clean
```
