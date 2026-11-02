# axnexus Fastify 集成实现计划

> **面向 AI 代理的工作者：** 按测试驱动开发逐任务实现；每个行为先看到失败，再修改生产代码。使用 E 盘 `codex/selection-protocol` 工作区。

**目标：** 提供可选 Fastify Selection 插件、显式 Web Request/Response 桥接，并统一服务端 Selection 路径配置。

**架构：** `src/selection/server/index.ts` 继续负责框架无关协议；`src/integrations/fastify.ts` 只注册隔离的 POST 路由并执行 Web/Fastify 转换。应用显式提供身份上下文，其他 Fastify 路由及 parser 保持原状。

**技术栈：** TypeScript NodeNext、Fastify 5.12.5（可选 peer `>=5.7.3 <6`）、Node test runner、pnpm、Chromium。

---

## 文件职责

- `src/selection/server/index.ts`：可配置 Selection 路径，默认保持 `/__axnexus/select`。
- `src/integrations/fastify.ts`：Fastify 插件和显式 Web Request/Response 桥接。
- `tests/selection/server.test.ts`：自定义路径与非法路径的回归测试。
- `tests/integrations/fastify.test.ts`：Fastify inject、prefix、bodyLimit、上下文、普通路由隔离和流式响应测试。
- `package.json`、`pnpm-lock.yaml`、`scripts/consumer-test.mjs`：可选入口、peer/dev 依赖和打包消费验证。
- `README.md`、`CHANGELOG.md`：安装、接入方式、边界与变更说明。

### 任务 1：服务端 endpoint 一致性

- [ ] 先在 `tests/selection/server.test.ts` 加用例：默认路径照旧；`endpoint: '/api/select'` 仅接受该路径；绝对 URL、查询和路径穿越配置在初始化时失败。
- [ ] 运行 `pnpm run build && node --test --experimental-strip-types tests/selection/server.test.ts`，确认新用例因路径固定或未校验配置而失败。
- [ ] 给 `createSelectionHandler` options 加 `endpoint?: string`，用 `new URL(endpoint, 'http://axnexus.invalid')` 校验它是规范化绝对路径，再把路由比较改为所配置路径。
- [ ] 运行同一测试，确认新旧用例都通过；独立提交这一行为。

### 任务 2：Fastify 原始请求与响应桥接

- [ ] 在 `tests/integrations/fastify.test.ts` 先写失败用例：Buffer 请求体按原字节进入 Web Request；已解析的普通对象没有原始 body 时拒绝隐式重建；Web Response 的状态、重复 Set-Cookie、内容类型和流式 body 经 Fastify inject 保留。
- [ ] 运行 `pnpm run build && node --test --experimental-strip-types tests/integrations/fastify.test.ts`，确认缺少 `./fastify` 实现导致失败。
- [ ] 在 `src/integrations/fastify.ts` 实现 `toWebRequest`：以固定内部 origin 或调用方给定 origin 构建 URL，复制请求头，使用 Fastify signal，只有原始 Buffer/Uint8Array/字符串或显式 body 才创建非 GET/HEAD 的 Web Request。
- [ ] 实现 `sendWebResponse`：先设置 reply status/headers，再将 Web ReadableStream 转成 Node stream 发送；无 body 时发送空响应。
- [ ] 跑定向测试，确认原字节和流式响应边界。

### 任务 3：隔离的 Selection Fastify 插件

- [ ] 在 `tests/integrations/fastify.test.ts` 加失败用例：`fastify.register(plugin, { prefix: '/api' })` 能请求默认和自定义 endpoint；`getContext` 将认证主体传给 Selection；超量或无效 JSON 返回协议错误；插件外 JSON/text 路由仍使用原 parser。
- [ ] 在 `src/integrations/fastify.ts` 实现 `createFastifySelectionPlugin`：普通封装插件中仅对 JSON 注册原始 Buffer parser，配置 POST 路由 bodyLimit；由 `getContext` 生成上下文；调用 Selection handler；将 Response 发送到 Fastify；route errorHandler 将解析器超量映射为 `REQUEST_TOO_LARGE`。
- [ ] 跑定向测试；对取消信号、权限拒绝和未知资源检查响应状态及无数据泄露。

### 任务 4：包契约、文档与完整验证

- [ ] 在 `package.json` 加 `./fastify` 导出、可选 Fastify peer 和固定 devDependency；用 `pnpm install` 更新锁文件。类型与消费测试应能从打包产物导入插件入口，根入口保持无 Fastify 运行时加载。
- [ ] 在 `README.md` 给出插件安装、路由注册、endpoint 对齐及显式普通 HTTP 桥接示例；说明 multipart、SSE 和 WebSocket 路由保持原业务实现。在 `CHANGELOG.md` 记录新增入口。
- [ ] 执行 `pnpm test`、`pnpm run test:types`、`pnpm run test:consumer`、`pnpm run test:browser`、`git diff --check`；读取通过/失败总数，再提交并更新当前 PR。
