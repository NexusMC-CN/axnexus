# axnexus Nuxt 4 接入实现计划

> **面向 AI 代理的工作者：** 在现有 E 盘 `codex/selection-protocol` 工作区逐任务实现；测试先出现可解释的失败，再补最少实现。用户已经确认“接入说明＋Nitro 测试”，不加 Nuxt 运行时入口。

**目标：** 用真实 Nuxt/Nitro 验证 4.5.2 和 4.6.3 的 Selection 路由、SSR 身份隔离，并给出版本对应的 README 接入方法。

**架构：** axnexus 继续暴露框架无关的 `createSelectionHandler` 和 `createSelectionClient`。临时 Nuxt 消费应用安装打包产物，测试旧版 H3 桥接与新版标准 Web Request/Response，SSR 每请求创建客户端。

**技术栈：** TypeScript、Node 22、pnpm、Nuxt 4.5.2/4.6.3、Nitro、Node test runner。

---

## 文件职责

- `tests/nuxt/`：版本化 Nuxt 消费夹具，含 Selection 路由、SSR 页面及资源实现。
- `scripts/nuxt-consumer-test.mjs`：打包、安装、构建、启动临时应用并检查 HTTP/SSR 行为，最后清理临时目录和进程。
- `package.json`：增加独立的 `test:nuxt` 命令，不增加 Nuxt peer。
- `.github/workflows/ci.yml`：运行 Nuxt 4.5.2、4.6.3 冒烟矩阵。
- `README.md`、`CHANGELOG.md`：版本化服务端示例、SSR 请求作用域与测试覆盖说明。

### 任务 1：Nuxt 4.5 的 H3/Nitro 夹具

- [ ] 添加临时 Nuxt 4.5.2 应用的 Selection 资源、`server/api/__axnexus/select.post.ts` 和 SSR 页面；旧版路由用 `h3` 的 `toWebRequest(event)`/`sendWebResponse(event,response)`，处理器和客户端均设置 `/api/__axnexus/select`。
- [ ] 让测试先请求尚未启动的夹具，确认失败来自服务不可用；随后实现打包、安装、构建和生命周期管理。
- [ ] POST 有效选择并检查身份相关字段；再发送错误协议和另一身份的请求，检查状态与隔离。SSR 页面使用 `useAsyncData`，按请求创建 axnexus 客户端，通过当前事件 fetch 发送请求并显式转发 Cookie，渲染后关闭。
- [ ] 运行 `pnpm run test:nuxt` 中的 4.5 场景并确认通过。

### 任务 2：Nuxt 4.6 的标准 Web 夹具

- [ ] 添加 4.6.3 路由版本，显式从 `nuxt/server` 导入 `defineEventHandler`，把 `event.req` 交给 Selection handler 并直接返回 Response；SSR 页面沿用相同的请求作用域断言。
- [ ] 在测试脚本中让版本参数选择对应夹具；逐版本启动实际 Nitro 输出，在响应里断言授权身份、协议错误、`Content-Type` 和无跨请求状态泄露。
- [ ] 运行 4.6 场景；检查对 4.5 的回归。

### 任务 3：文档与 CI

- [ ] README 新增 Nuxt 4 接入节：4.5 H3 桥接、4.6+ 标准 Web 路由、`/api` 路径对齐、SSR Cookie/客户端生命周期，以及普通 REST 与 `useFetch` 的边界。CHANGELOG 记录兼容验证。
- [ ] 为 CI 加独立 Nuxt 矩阵，固定 4.5.2 和 4.6.3，执行同一个 `test:nuxt` 脚本；不改变既有 Node/Bun/Chromium 测试契约。
- [ ] 执行 `pnpm test`、`pnpm run test:types`、`pnpm run test:consumer`、`pnpm run test:browser`、`pnpm run test:nuxt`、`git diff --check`；核对 PR 文件范围，提交并更新 PR #3，等待远端 CI。
