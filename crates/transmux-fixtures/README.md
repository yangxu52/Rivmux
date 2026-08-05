# Rivmux Transmux Fixtures

Rivmux 仓库自有的二进制媒体 fixture，用于转封装与浏览器验收测试。

该 crate 通过 `include_bytes!` 导出 fixture 字节，使 Rust 测试与浏览器测试服务器复用同一份资产。生成来源、命令和完整性摘要记录在 `fixtures/README.md`。

该 crate 仅用于仓库测试，不是普通用户依赖的媒体 API。
