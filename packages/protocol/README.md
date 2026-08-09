# Rivmux Protocol

`@rivmux/protocol` 提供 Rivmux 浏览器包共享的 TypeScript 类型与 Worker 消息契约。

该包面向内部包边界维护，不是普通用户的播放器入口。`rivmux` 会重新导出用户需要的选项、事件、错误、媒体信息和能力矩阵类型；应用代码应优先依赖 `rivmux`。

关键导出包括：

- `RivmuxPlayerOptions` 及各分组配置类型。
- `PlayerEventMap`、`PlayerError`、`PlayerWarning` 和重连信息类型；播放器初始化事件为 `initialized`。
- `RivmuxCapabilities`、`RuntimeCapabilities`、`DecodingCapabilities` 与 `SupportStatus`。
- 主线程与 Dedicated Worker 之间使用的生命周期、媒体和诊断消息契约。Worker 选项在 `init` 命令中一次性传入；当前不提供动态选项更新命令。

协议变更必须同步更新播放器、Worker 和对应测试；公开类型当前采用手动维护方式。
