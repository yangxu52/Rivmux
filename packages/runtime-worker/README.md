# Rivmux Runtime Worker

`@rivmux/runtime-worker` 是 Rivmux 主包使用的 Dedicated Worker 运行时，负责 HTTP-FLV 加载、WASM 转封装核心、MSE SourceBuffer、播放延迟控制、重连和生命周期清理。

该包提供 Worker 脚本、WASM 资产和内部生命周期客户端，普通用户不应直接依赖。用户接入请使用 `rivmux`，以获得稳定的播放器 API、类型和错误语义。

维护时需保证 Worker/WASM 资产来自同一次构建，并保持与 `@rivmux/protocol` 的消息契约一致。发布前必须验证资产 URL、CSP/CORS 和配对版本。
