# Rivmux Runtime Worker

`@rivmux/runtime-worker` 是 Rivmux 的 Dedicated Worker 运行时，负责从 HTTP-FLV 网络输入到 Worker MSE 缓冲的完整后台处理链路。

## 使用边界

- 该包提供 `WorkerClient`、Worker 工厂、Worker bundle 和 WASM 资产装配能力，供 [`rivmux`](../player/README.md) 内部使用。
- 普通应用不应直接导入内部类、Worker 入口或资产路径；用户接入、类型和错误语义均以主包为准。
- 当前只有 Worker MSE 运行路径，不提供主线程 MSE 降级实现。

## 运行职责

| 领域         | 职责                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------- |
| 网络加载     | 流式读取 HTTP-FLV，处理读空闲、背压、重试与取消。                                                   |
| 转封装       | 加载 [`rivmux_transmux_core`](../../crates/transmux-core/README.md)，将 FLV 转换为 fragmented MP4。 |
| MSE          | 创建 Worker `MediaSource`，管理 SourceBuffer、追加队列和缓冲清理。                                  |
| 直播控制     | 计算延迟、追赶直播边缘，并向主线程请求播放控制。                                                    |
| 生命周期诊断 | 处理初始化、启动、停止、销毁、恢复、统计和结构化错误。                                              |

## 生命周期与协议

- 配置通过 `init` 命令一次性确定，运行期间不支持动态更新。
- Worker 内部确认包括 `initialized`、`started`、`stopped` 和 `destroyed`；主包负责把内部消息转换为公共 Promise 与事件语义。
- Worker 消息必须与 [`@rivmux/protocol`](../protocol/README.md) 保持一致，内部消息名称不构成普通应用 API。
- 用户事件监听器异常与 Worker 生命周期错误相互隔离，不能阻塞内部请求确认和资源清理。

## 资产与部署

构建过程会把 wasm-bindgen JavaScript 胶水打入 Worker bundle，并将同一次 Core 构建产生的 WASM 复制为 `rivmux-transmux-core.wasm`。最终运行资产包括 `rivmux-runtime-worker.js` 和对应的 WASM 文件。

覆盖 `runtime.workerUrl` 或 `runtime.wasmUrl` 时，两个地址必须指向同一版本的资产。部署侧还需验证 CSP、CORS、`application/wasm` MIME 和缓存版本策略。

## 构建与验证

在仓库根目录执行：

```bash
pnpm --filter @rivmux/runtime-worker run test
pnpm --filter @rivmux/runtime-worker run typecheck
pnpm run build
```

根级 `build` 会先构建 Transmux Core，再构建 Runtime Worker 和其他 TypeScript 包，避免 Worker 胶水与 WASM 资产错配。

## 许可证

[Apache License 2.0](./LICENSE)
