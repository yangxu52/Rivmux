# Rivmux 公共 API 清单

本清单是 M2-S1 的边界基线。普通应用只依赖 `rivmux`；其他包和未列出的导出均不构成稳定公共 API。

## `rivmux`

### Stable

运行时导出：

- `RivmuxPlayer`
- `getCapabilities()`
- `isSupported()`

稳定类型：

- `RivmuxPlayerOptions`、`PlaybackOptions`、`LatencyOptions`、`NetworkOptions`、`DiagnosticsOptions`
- `MediaInfo`
- `PlayerEventMap`、`PlayerEventType`、`PlayerEventListener`
- `PlayerError`、`PlayerErrorKind`、`PlayerWarning`、`PlayerStats`
- `PlayerErrorCause`
- `ReconnectReason`、`ReconnectInfo`、`RecoveryInfo`
- `RivmuxCapabilities`、`RuntimeCapabilities`、`DecodingCapabilities`、`SupportStatus`

`RivmuxPlayerOptions` 的整体配置形状属于 Stable；其中 `runtime` 嵌套字段只承载资产地址覆盖，具体的 `RuntimeOptions` 和 `workerUrl`/`wasmUrl` 仍属于 Experimental。除该嵌套字段外，当前稳定配置字段的语义进入 1.0 兼容范围。

稳定生命周期：

- `attach(video)`
- `start()`
- `stop()`
- `destroy()`
- `on(type, listener)` / `off(type, listener)`
- `url` 只读属性

稳定事件：

- `initialized`（Worker runtime 在 `attach()` 期间完成 `init` 后触发；`await attach()` 仍需等待 MediaSourceHandle，事件不表示 `canplay` 或 `playing`。同一 runtime 实例只触发一次。）
- `mediaInfo`
- `stats`
- `warning`
- `error`
- `reconnecting`
- `recovered`
- `stopped`
- `destroyed`

媒体“准备可播放”与“实际播放”分别使用 video 原生 `canplay` 和 `playing` 事件，不增加 `mediaReady` 公共事件。

主包当前文档列出的稳定错误码和 warning code 包括：

- 生命周期和调用：`RIVMUX_ALREADY_ATTACHED`、`RIVMUX_START_REQUIRES_ATTACH`、`RIVMUX_START_CANCELLED`、`RIVMUX_PLAYER_STOPPING`、`RIVMUX_PLAYER_DESTROYING`、`RIVMUX_PLAYER_DESTROYED`。
- 配置：`RIVMUX_INVALID_LATENCY_OPTION`、`RIVMUX_INVALID_NETWORK_OPTION`。
- 能力和媒体：`RIVMUX_UNSUPPORTED_WORKER`、`RIVMUX_UNSUPPORTED_FETCH`、`RIVMUX_UNSUPPORTED_READABLE_STREAM`、`RIVMUX_UNSUPPORTED_WASM`、`RIVMUX_UNSUPPORTED_MSE`、`RIVMUX_UNSUPPORTED_WORKER_MSE`、`RIVMUX_UNSUPPORTED_MSE_TYPE_CHECK`、`RIVMUX_UNSUPPORTED_MSE_CODEC`。
- 运行行为错误：`RIVMUX_RECONNECT_EXHAUSTED`。
- warning code：`RIVMUX_AUTOPLAY_REJECTED`；它只通过 `warning` 事件报告，不通过 `error` 事件报告。

错误对象的稳定字段为：

```ts
type PlayerError = {
  kind: PlayerErrorKind
  code: string
  message: string
  terminal: boolean
  cause?: { name: string; message: string }
}
```

`PlayerWarning` 使用 `code`、`message` 和可选的同形状 `cause`。`terminal: true` 表示当前播放器实例不能继续正常工作；非终止错误仍通过 `error` 事件报告，但只有关联的生命周期 Promise 才会因该错误拒绝，具体触发条件以主包 README 的错误码说明为准。

### Experimental

- `runtime.workerUrl`
- `runtime.wasmUrl`
- `RuntimeOptions`

这两个选项只覆盖已打包资产地址，不保证跨 bundler、CSP 或部署方式的长期兼容性。

### Removed

- `RivmuxPlayerInternals` 及构造函数第三参数。
- `createPlayerError()`。
- `diagnostics.debug`。
- `runtime.preferWorkerMse`。
- `DEFAULT_RIVMUX_PLAYER_OPTIONS`、`normalizePlayerOptions()`。
- `Normalized*` 配置类型。
- 默认导出。

### Internal

- Worker 命令、Worker 消息、Worker 工厂、`WorkerClient`、MSE 控制器和 WASM host。

## `@rivmux/protocol`

Internal。该包只维护跨包 TypeScript 类型和 Worker 契约。其类型可能被 `rivmux` 重导出，但普通应用不应直接依赖该包的独立 API 或 Worker 消息结构。

## `@rivmux/runtime-worker`

Internal。该包包含 Worker 客户端、Worker 工厂、Worker bundle 和 WASM 资产。普通应用不应直接导入其实现类、Worker entry 导出或资产路径；这些内容由 `rivmux` 统一组装。

## 标记的两个维度

API 的 Stable/Experimental/Internal 描述接口兼容性；Codec 支持矩阵中的 Stable/Experimental/不支持描述媒体输入范围，二者互不提升或替代。能力矩阵中的 `supported` 只表示环境前置探测结果，也不等于 Codec 支持等级或实际播放成功。

## 稳定性标记规则

- Stable：进入 1.0 兼容承诺；新增字段可以向后兼容地增加，但不随意改变既有语义。
- Experimental：有实际用途，但 1.0 前允许调整或删除。
- Internal：实现、测试或跨包契约；不承诺普通用户可用性和字符串兼容。
