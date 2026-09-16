# Rivmux Transmux Fixtures

`rivmux_transmux_fixtures` 保存 Rivmux 仓库自有的二进制媒体 fixture，用于验证转封装、资产完整性和浏览器实际播放。

## 使用边界

- 该 crate 只服务仓库测试，不是普通用户依赖的媒体 API。
- Rust 测试通过 `include_bytes!` 使用 fixture；浏览器测试服务器直接读取相同文件，避免维护两套媒体素材。
- 所有素材均由仓库生成，不包含第三方媒体内容。生成工具、命令和完整性摘要记录在 [`fixtures/README.md`](./fixtures/README.md)。

## 素材清单

| 文件           | Rust 常量      | 用途                                      |
| -------------- | -------------- | ----------------------------------------- |
| `h264-aac.flv` | `H264_AAC_FLV` | AVC/H.264 + AAC-LC Stable 播放与转封装。  |
| `hevc-aac.flv` | `HEVC_AAC_FLV` | HEVC/`hvc1` + AAC-LC 条件化 Stable 验收。 |

每个字节常量都有对应的 `*_SHA256` 常量。smoke 测试会校验文件长度、FLV 文件头和 SHA-256，防止素材被意外替换或截断。

## 维护流程

重新生成 fixture 时必须同时：

1. 使用 `fixtures/README.md` 中记录的 FFmpeg 命令和工具版本。
2. 更新二进制文件、`src/lib.rs` 中的 SHA-256 常量以及 fixture 元数据。
3. 运行完整性测试，并确认依赖该素材的 Core 和浏览器场景仍符合预期。

## 验证

在仓库根目录执行：

```bash
cargo test -p rivmux_transmux_fixtures
```

## 许可证

[Apache License 2.0](./LICENSE)
