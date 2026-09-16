# Rivmux Protocol

`@rivmux/protocol` 是 Rivmux 浏览器包之间共享的 TypeScript 契约包，集中定义配置、能力、事件、诊断、媒体状态和 Worker 消息类型。

## 使用边界

- 该包只导出类型，不提供播放器或 Worker 运行时实现。
- 普通应用应从 [`rivmux`](../player/README.md) 导入用户需要的类型，不应直接依赖 Worker 协议或归一化配置。
- `@rivmux/protocol` 独立发布是为了连接主包与 [`@rivmux/runtime-worker`](../runtime-worker/README.md)；其内部消息结构不属于应用兼容面。

## 契约域

| 契约域      | 代表类型                                                                             | 主要用途                               |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| 配置        | `RivmuxPlayerOptions`、各分组配置和 `Normalized*` 类型                               | facade 输入与 Worker 初始化配置。      |
| 能力        | `RivmuxCapabilities`、`RuntimeCapabilities`、`DecodingCapabilities`、`SupportStatus` | 描述运行环境与 codec 前置探测结果。    |
| 事件与诊断  | `PlayerEventMap`、`PlayerError`、`PlayerWarning`、`PlayerStats` 和重连信息           | 统一主包对外事件及结构化诊断数据。     |
| 媒体与播放  | `MediaInfo`、`VideoElementState`、`PlaybackControlAction`、`PlaybackControlResult`   | 在主线程与 Worker 间传递媒体播放状态。 |
| Worker 协议 | `WorkerCommand`、`WorkerMessage`                                                     | 定义生命周期、媒体和诊断消息联合。     |

## 维护约束

- Worker 配置只在 `init` 命令中传入；当前没有运行期间动态更新选项的协议。
- Worker 命令和消息的变更必须同时更新主包、Runtime Worker 和协议测试。
- 被 `rivmux` 重新导出的用户类型发生变化时，必须同步主包 README 和公共 API 清单。
- Stable、Experimental 与 Internal 边界由主包公开契约决定，不能仅根据本包是否导出某个类型判断。

## 构建与验证

在仓库根目录执行：

```bash
pnpm --filter @rivmux/protocol run test
pnpm --filter @rivmux/protocol run typecheck
pnpm --filter @rivmux/protocol run build
```

## 许可证

[Apache License 2.0](./LICENSE)
