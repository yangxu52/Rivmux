# ADR-0001：公共 API、包边界与运行时选择

- 状态：已接受
- 日期：2026-08-09
- 范围：M2-S1

## 背景

Rivmux 当前由 `rivmux`、`@rivmux/protocol` 和 `@rivmux/runtime-worker` 三个 TypeScript 包组成。M1 已稳定直播恢复、生命周期确认、自动播放诊断和能力探测，但 0.x 的源码导出仍包含测试注入、低层错误工厂和默认配置等过早公开的契约。Worker 协议还包含 Runtime 已实现但播放器 facade 不可达的 `update-options` 命令。

当前实现只提供 Dedicated Worker + Worker MSE runtime。Firefox 等不支持 Worker MSE 的浏览器未来可能需要主线程 MSE runtime；本 ADR 必须允许该演进，但不提前承诺未实现的实现细节。

## 决策

### 1. 包与依赖边界

- `rivmux` 是普通用户唯一受支持的入口和稳定兼容边界。
- `@rivmux/protocol` 是共享类型和 Worker 契约包，标记为 Internal。它可以作为 workspace/publish graph 中的内部依赖，但不承诺独立 API 的 1.0 兼容性。
- `@rivmux/runtime-worker` 是 Worker、WASM 资产和运行时实现包，标记为 Internal。普通用户不应直接依赖其 `WorkerClient`、Worker 工厂、MSE 控制器或 Worker bundle 导出。
- Runtime 包由 `rivmux` facade 选择和组装。未来可增加 `@rivmux/runtime-main-thread`，仍由 `rivmux` 统一选择；不要求应用直接注入 runtime 实现。
- 当前发布格式保持 ESM-only，不增加 CommonJS、UMD 或 global build。默认导出不增加，继续使用具名导出。

### 2. `RivmuxPlayer` 构造函数

公共构造函数只接受：

```ts
new RivmuxPlayer(url: string, options?: RivmuxPlayerOptions)
```

`RivmuxPlayerInternals`、`workerFactory`、`detectRuntime` 和 `idFactory` 是测试/内部注入能力，不得出现在普通公共 `.d.ts`。测试迁移到内部工厂、测试专用入口或等价的非公共注入面。

这是 0.x 的直接替换：`no migration, direct replacement`。

### 3. 公开选项

- 删除没有实际行为的 `diagnostics.debug`。
- 删除当前唯一有效值为 `true` 的 `runtime.preferWorkerMse`。
- 保留 `runtime.workerUrl` 和 `runtime.wasmUrl`，标记为 Experimental；它们用于 CSP、资产托管和特殊部署，不改变 runtime 业务语义。
- 当前 runtime 仍固定为 Worker MSE。未实现主线程 runtime 前，不能通过配置选择主线程路径。

未来新增 runtime 选择时使用：

```ts
runtime: {
  mode: 'auto' | 'worker' | 'main-thread'
}
```

语义：

- `auto`：选择当前环境可用且被 Rivmux 支持的最佳 runtime。
- `worker`：明确要求 Worker MSE；不可用时返回结构化 unsupported 错误。
- `main-thread`：明确要求已经随当前 Rivmux 版本发布的主线程 MSE runtime；当前环境不可用时返回结构化 unsupported 错误。

`runtime.mode` 与主线程 runtime 同时发布，且只有在能力探测、包资产和浏览器验证完成后才加入公共 API。

### 4. 生命周期与事件命名

保留以下生命周期方法：

```text
attach → start → stop → destroy
```

语义不改变：`attach()` 准备媒体管线，`start()` 启动流消费，`stop()` 停止且允许复用，`destroy()` 终止并释放实例。

公共初始化事件命名为 `initialized`，表示所选 runtime 初始化完成。它不表示媒体已解析、已追加首个片段、video 已触发 `canplay` 或已经开始播放。

公共稳定事件为：

```text
initialized
mediaInfo
stats
warning
error
reconnecting
recovered
stopped
destroyed
```

`started`、`worker-ready` 和 `media-source-handle` 保持内部 Worker 协议消息，不作为公共事件。

媒体准备就绪不新增 Rivmux 专用事件：应用使用绑定 video 元素的原生 `canplay`；实际开始播放使用原生 `playing`。`mediaInfo` 仅表示媒体信息已经解析。

### 5. 错误契约

- `PlayerError.kind` 及现有分类保持不变。
- `PlayerError.terminal` 保持不变，表示当前播放器实例是否无法继续正常工作；它不等同于宿主进程崩溃，也不单纯表示一次错误的严重程度。
- `PlayerWarning` 继续表示不终止播放的可诊断问题。
- `cause` 保留字段名，但公共 payload 必须是结构化、可克隆的错误信息；不得把跨 Worker 的原生 Error 实例作为稳定契约。
- 错误码统一使用 `RIVMUX_` 前缀。主包 README 和 API 清单列出的错误码进入 Stable；未列出的 Worker、Loader、MSE 队列和内部生命周期错误码属于 Internal，不承诺长期字符串兼容。
- 终止错误通过 `error` 事件报告，并使相关生命周期 Promise 以同一错误码拒绝；同一故障不得产生重复含义的错误事件。

### 6. 能力探测

当前 `isSupported()`/`getCapabilities()` 只反映默认 Worker MSE 链路和当前 codec 能力矩阵。

未来主线程 runtime 发布后：

- `runtime.mode: 'auto'` 成为默认策略。
- `isSupported()` 表示 auto 策略至少存在一条可用、受支持的 runtime 链路。
- `getCapabilities().runtime` 增加 `mainThreadMse` 等字段时，必须同步更新能力测试和文档；当前不提前加入未实现字段。

## 被拒绝的替代方案

1. 保留 `ready` 作为公共初始化事件：容易被理解为媒体可播放；浏览器已有 `canplay`，不再复用模糊名称。
2. 使用 `instantiated` 表示初始化完成：它只表达对象创建，不表达 runtime 初始化和资源准备完成。
3. 保留 `preferWorkerMse: boolean`：当前只有 `true` 有效，不是实际偏好；未来 runtime 选择需要可扩展的 mode，而不是把 boolean 语义重载。
4. 现在增加 `runtime.mode`：主线程实现、fallback、能力探测、资产边界尚未完成，提前公开会产生未兑现契约。
5. 通过播放器 facade 暴露当前 `update-options`：现有协议更新不经过 facade 校验，且会使主线程 playback/diagnostics 与 Worker 状态不同步。

## 后续影响

- M2-S1 实施必须同步更新源码导出、协议类型、生成声明、单元测试和 `packages/player/README.md`。
- 删除项均为 0.x 直接替换，不提供兼容别名。
- 在主线程 runtime 实现前，Firefox 仍可能因 Worker MSE 能力不足而返回 unsupported；这不是当前版本的 fallback 承诺。
- 主线程 runtime 的后续 ADR 必须补充 runtime 包资产、能力矩阵、选择优先级、CSP/CORS 和跨 runtime 行为一致性。
