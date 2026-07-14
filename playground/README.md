# rivmux-playground

`rivmux-playground` 是基于 Vue 3 + Vite 的测试页面，用于快速验证：

- 输入 HTTP-FLV URL 参数
- 使用 `rivmux` 直接播放 HTTP-FLV

## 启动方式

在仓库根目录：

```bash
pnpm install
pnpm --filter rivmux-playground dev
```

默认访问：`http://localhost:5173`

## 生产构建

先执行 `pnpm run build` 生成上游包，再执行：

```bash
pnpm --filter rivmux-playground build
```

Vite 会自动在 `dist/assets` 输出带哈希的 `rivmux-transmux-core-*.wasm`；应用使用 `rivmux` 时不需要额外复制或配置该二进制。

## 页面能力

- 编辑 `URL`
- 一键创建并播放
- 停止播放
