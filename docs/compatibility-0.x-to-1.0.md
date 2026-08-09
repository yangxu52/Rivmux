# Rivmux 0.x → 1.0 兼容策略

## 总原则

Rivmux 当前处于 0.x。为了移除错误或过早公开的契约，允许不兼容调整；每项调整必须明确迁移路径。Stable API 在 1.0 冻结时形成长期兼容承诺，Experimental API 不保证保持不变，Internal API 不提供应用迁移承诺。

## 直接替换项

以下项目采用 `no migration, direct replacement`：

| 0.x 项目                                               | 1.0 前动作          | 替代方式                                                          |
| ------------------------------------------------------ | ------------------- | ----------------------------------------------------------------- |
| `new RivmuxPlayer(url, options, internals)` 第三个参数 | 删除                | 测试使用内部工厂或测试专用入口；应用只使用两个参数                |
| `diagnostics.debug`                                    | 删除                | 暂无替代；需要诊断时使用 `stats`、`warning` 和应用日志            |
| `runtime.preferWorkerMse`                              | 删除                | 当前仅支持 Worker MSE；未来使用 `runtime.mode`                    |
| Worker `update-options` 命令                           | 删除不可达协议能力  | 未来重新设计经过 facade 校验的公开更新 API                        |
| `ready` 公共事件                                       | 改为 `initialized`  | 监听 `initialized`；媒体可播放监听 video 原生 `canplay`           |
| `DEFAULT_RIVMUX_PLAYER_OPTIONS`                        | 从普通用户 API 移除 | 在 `new RivmuxPlayer(url, options)` 中使用默认配置                |
| `normalizePlayerOptions()`                             | 从普通用户 API 移除 | 由播放器内部完成归一化和校验                                      |
| `createPlayerError()`                                  | 从普通用户 API 移除 | 应用处理 `PlayerError` 或 Promise rejection                       |
| `Normalized*` 配置类型                                 | 从普通用户 API 移除 | 使用 `RivmuxPlayerOptions` 传入部分配置；归一化结果不属于应用契约 |
| 默认导出                                               | 不提供              | 使用 `import { RivmuxPlayer } from 'rivmux'` 等具名导入           |

## 保持稳定的主要契约

- `RivmuxPlayer` 两参数构造函数。
- `attach()`、`start()`、`stop()`、`destroy()` 的生命周期语义。
- `initialized`、`mediaInfo`、`stats`、`warning`、`error`、`reconnecting`、`recovered`、`stopped`、`destroyed` 事件。`initialized` 在 `attach()` 期间 runtime 完成初始化后触发；媒体可播放和实际播放仍监听 video 原生 `canplay` 与 `playing`。
- `PlayerError.kind`、`PlayerError.terminal`、`PlayerError.code`、`PlayerError.message` 和结构化 `cause` 形状。
- 能力探测函数及其当前返回结构；未来新增 runtime 能力字段必须增量发布并同步文档。

## 错误码兼容

主包 README 和公共 API 清单列出的错误码属于 Stable。未列出的 Worker、Loader、MSE 队列和内部生命周期错误码属于 Internal，应用不得依赖其具体字符串；应用应优先依据 `kind`、`terminal` 和公开错误码处理。

## 未来 runtime 选择

当前版本没有公开 `runtime.mode`，也没有主线程 MSE runtime。未来实现完成后新增：

```ts
runtime: {
  mode: 'auto' | 'worker' | 'main-thread'
}
```

旧版本没有 `runtime.mode` 时，行为等价于当前唯一的 Worker MSE runtime。未来 `runtime.mode` 与主线程 runtime 同时发布；`auto` 选择至少一条可用 runtime，显式 `worker` 或 `main-thread` 在当前环境能力不足时返回结构化 unsupported 错误。

## 包边界迁移

普通应用应从 `@rivmux/protocol` 和 `@rivmux/runtime-worker` 迁移到 `rivmux`：

```ts
// 迁移前：不受支持的直接依赖
import type { PlayerError } from '@rivmux/protocol'

// 迁移后：受支持入口
import type { PlayerError } from 'rivmux'
```

Worker URL、WASM URL、Worker client 和 MSE 实现不属于应用兼容面。应用若直接导入内部包，升级时必须自行承担调整风险。
