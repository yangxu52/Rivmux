# 初版设计第一阶段验证结论

验证日期：2026-07-23  
代码基线：`59438f8 fix(mse): preserve muxed av source buffer for late codec configs`

## 范围

本文的“第一阶段”指初版设计中的完整首发阶段（覆盖其中的 M1–M7 子项），而不是仅指浏览器运行时证明这一项。

首发范围为 HTTP-FLV、H.264/AVC、可选 AAC-LC、fMP4、Dedicated Worker MSE 和 Chromium。MPEG2-TS 已裁剪，且不属于初版首发合同，不作为完成度缺口。

## 最终结论

**第一阶段功能实现已基本到位，但验收尚未完成；不应标记为第一阶段完成或进入正式发布。**

当前结论不是由 MPEG2-TS 缺失或已修复的 AVC/AAC MSE 回归导致，而是缺少可播放性与长稳性的浏览器验收证据。

## 已验证的能力

- 已实现 HTTP-FLV、AVC、可选 AAC-LC、Rust/WASM 转封装、Worker-owned MSE、fMP4 追加、多实例、生命周期和结构化错误链路。
- `59438f8` 修复了 Chromium 中 AVC + AAC 创建第二个 `SourceBuffer` 导致的 `QuotaExceededError`，并覆盖 AAC codec 配置晚到时仍保持一个 muxed `SourceBuffer` 的边界。
- `tests/browser/smoke.test.ts` 在真实 Chromium 中覆盖 HTTP-FLV 转封装与 MSE 追加、双实例、短暂网络停顿、小型网格、结构化网络错误和晚到 AAC 配置。
- 最终提交后执行 `pnpm run test:workspace` 成功：WASM 与包构建成功，13/13 测试通过。
- 本次变更验证期间，`pnpm run test:ci`、`pnpm run lint:check`、`pnpm run typecheck`、`pnpm run clippy`、`pnpm run format:check` 和 Git 差异空白检查均已通过。

## 未满足的验收项

| 验收项               | 当前事实                                                                                                                                          | 判定                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Chromium 可播放性    | 浏览器测试断言转封装输出、无错误和 `SourceBuffer` 数量，但未断言 `video.readyState` 达到可播放状态，也未断言 `currentTime` 前进。                 | 未完成                 |
| 静态 fMP4 浏览器证明 | 静态 fMP4 生命周期测试使用 Mock MSE；尚无基于真实 Chromium 的静态 fMP4 可播放性断言。                                                             | 未完成                 |
| 30 分钟稳定播放      | 未找到单路 H.264/AAC HTTP-FLV 在 Chromium 中连续播放至少 30 分钟的执行记录。                                                                      | 未完成                 |
| 浏览器发布门禁       | `test:ci` 与发布工作流均不执行 `test:workspace`。初版设计允许默认 CI 不跑浏览器测试，但要求在发布前执行；当前没有强制或可追溯的发布前浏览器验证。 | 未完成                 |
| MPEG2-TS             | 已从首发范围裁剪。根目录 `package.json` 仍将其写入项目描述，属于发布文案不一致。                                                                  | 非功能缺口，发布前修正 |

## 重新验收的必要条件

1. 在打包产物、Dedicated Worker MSE 和真实 Chromium 下，断言 `video.readyState` 达到可播放状态，并断言 `currentTime` 持续前进。
2. 对 H.264/AAC HTTP-FLV 执行至少 30 分钟稳定播放，并记录终端错误、缓冲范围、延迟与资源状态。
3. 将上述 Chromium 验证纳入发布前必经流程；不要求加入默认 PR CI，但必须在发布前自动执行或留下可审计记录。
4. 修正面向用户的 MPEG2-TS 支持描述，使其与首发范围一致。

完成以上四项后，才能将第一阶段标记为验收完成并进入正式发布。
