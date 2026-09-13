# HTTP Client 深度拆分实现计划

> **面向实现者：** 按任务顺序执行，每个任务结束时运行列出的验证并更新复选框。公开入口和配置行为必须保持兼容。

**目标：** 将 866 行的 `src/core/client.ts` 拆成配置、控制、重试、单次尝试、执行管线和缓存策略模块，同时保持现有 HTTP 客户端行为不变。

**架构：** `client.ts` 只创建实例和适配公共方法；`pipeline.ts` 编排 setup、调度、总超时和重试；`attempt.ts` 执行一次 adapter/响应处理；其余模块提供纯策略和生命周期工具。内部模块不加入 `src/index.ts` 导出。

**技术栈：** TypeScript 5.9、NodeNext ESM、原生 Fetch/XHR/Node HTTP2、Node test runner、严格类型检查。

---

## 文件结构锁定

**创建：**

- `src/core/config.ts`：配置合并、请求体准备和配置归一化。
- `src/core/control.ts`：signal 组合、Promise 竞态、延迟和超时原因。
- `src/core/retry.ts`：重试策略、状态码判断和延迟计算。
- `src/core/cache-policy.ts`：缓存 key 和缓存资格判断。
- `src/core/attempt.ts`：单次 adapter 调用、响应读取和响应拦截器。
- `src/core/pipeline.ts`：请求生命周期、调度和重试编排。

**修改：**

- `src/core/client.ts`：删除已迁移的内部实现，只保留实例工厂和公共方法适配。
- `src/core/errors.ts`：集中错误归一化和响应拦截器错误包装，供 attempt/pipeline 共享。
- `src/core/types.ts`：增加仅供内部管线使用的依赖/结果类型（不从根入口导出）。
- `README.md`：更新内部结构和取消边界说明。

**测试：**

- 保留现有 `tests/**/*.test.ts` 行为测试。
- 在现有对应测试文件中增加模块边界和委托行为断言，不改变测试入口。

## 任务 1：提取控制与配置层

**文件：** 创建 `src/core/control.ts`、`src/core/config.ts`；修改 `src/core/client.ts`；测试 `tests/client.test.ts`。

- [x] **步骤 1：确认基线**

运行 `npm test`，记录当前通过数量；运行 `git diff --check`，确保开始迁移前工作区没有实现改动。

- [x] **步骤 2：迁移控制函数**

将 `signalReason`、`raceWithSignal`、`sleep`、`TIMEOUT_REASON` 移到 `control.ts`，导出最小内部 API，并让 `client.ts` 通过显式导入使用；保持 already-aborted 分支和 rejection observer 行为。

- [x] **步骤 3：迁移配置函数**

将 `mergeRateLimitOptions`、`normalizeRetry`、`normalizeTimeout`、`createResolvedConfig`、请求/响应 transform 辅助函数和默认 adapter 构造移到 `config.ts`；配置函数继续接收 `HttpClientConfig`/`RequestConfig` 并返回 `ResolvedRequestConfig`。

- [x] **步骤 4：验证控制与配置迁移**

运行 `npm run build`，再运行 `node --test --experimental-strip-types tests/client.test.ts`；预期所有客户端行为测试通过，且公开导出没有变化。

- [x] **步骤 5：提交**

运行 `git add src/core/control.ts src/core/config.ts src/core/client.ts tests/client.test.ts && git commit -m "refactor(http): extract request control and config"`。

## 任务 2：提取重试和缓存策略

**文件：** 创建 `src/core/retry.ts`、`src/core/cache-policy.ts`；修改 `src/core/client.ts`、`src/core/types.ts`；测试 `tests/core/enhancements.test.ts`、`tests/client.test.ts`。

- [x] **步骤 1：迁移纯重试策略**

将默认状态码、幂等方法集合、`isReadableStreamBody`、`shouldRetry`、`calculateRetryDelay`、`retryAfterMs` 和 `statusShouldThrow` 迁移到 `retry.ts`，保留 `RetryContext.delay` 的最终延迟语义。

- [x] **步骤 2：迁移缓存策略**

将 `cacheKey` 和缓存资格布尔条件迁移到 `cache-policy.ts`，定义一个接收 `ResolvedRequestConfig`、缓存设置及拦截器状态的纯函数，确保 request-specific signal/timeout/progress/rate-limit/transform 策略仍会跳过缓存。

- [x] **步骤 3：接入内部类型**

在 `types.ts` 增加不改变公开 API 的内部参数类型，令策略函数不依赖 `client.ts` 闭包变量；策略模块不得导入 `HttpClient` 实例。

- [x] **步骤 4：验证策略迁移**

运行 `npm run build` 和 `node --test --experimental-strip-types tests/client.test.ts tests/core/enhancements.test.ts`；重点确认 Retry-After、validateStatus、流 body 不重试和缓存 key 测试通过。

- [x] **步骤 5：提交**

运行 `git add src/core/retry.ts src/core/cache-policy.ts src/core/types.ts src/core/client.ts tests && git commit -m "refactor(http): isolate retry and cache policies"`。

## 任务 3：提取单次尝试响应层

**文件：** 创建 `src/core/attempt.ts`；修改 `src/core/client.ts`、`src/core/types.ts`；测试 `tests/core/response-api.test.ts`、`tests/client.test.ts`。

- [x] **步骤 1：定义依赖接口**

为单次尝试定义显式依赖：`adapter`、响应拦截器管理器、解析/读取函数、重试状态码集合、队列和时间戳信息；不得从模块级变量读取客户端状态。

- [x] **步骤 2：迁移单次执行逻辑**

将 adapter 调用、bodyless status、`maxBodySize`、JSON/response transform 和响应对象构造迁移到 `attempt.ts`，并让它调用 `errors.ts` 提供的 `toError`/`responseInterceptorError`；保留 response interceptor 只执行一次和取消分类逻辑。

- [x] **步骤 3：用管线调用单次尝试**

让原重试循环以 `executeAttempt(attemptConfig, deps)` 替代内联 adapter/响应代码；重试决策仍留在管线层。

- [x] **步骤 4：验证响应层**

运行 `npm run build` 和 `node --test --experimental-strip-types tests/client.test.ts tests/core/response-api.test.ts tests/adapters/*.test.ts`；预期 bodyless response、解析错误、响应拦截器取消和 HTTP2/HTTP3 adapter 测试全部通过。

- [x] **步骤 5：提交**

运行 `git add src/core/attempt.ts src/core/client.ts src/core/types.ts tests && git commit -m "refactor(http): extract single request attempt"`。

## 任务 4：提取执行管线并收窄 client.ts

**文件：** 创建 `src/core/pipeline.ts`；修改 `src/core/client.ts`、`README.md`；测试 `tests/**/*.test.ts`。

- [x] **步骤 1：定义管线依赖**

定义 `RequestPipelineDeps`，注入 defaults、adapter、request/response interceptors、`GetRequestCache` 和 `RateLimiter`；依赖由 `createHttpClient` 创建，pipeline 不创建全局单例。

- [x] **步骤 2：迁移生命周期编排**

将 setup signal race、总超时、缓存/去重、限速调度、每次重试重新执行 request interceptor、稳定 request ID、错误通知和最终归一化迁移到 `pipeline.ts`。

- [x] **步骤 3：让 client.ts 只保留公共 API**

保留 `createHttpClient`、实例依赖创建、`normalizePublicConfig` 和 HTTP 方法快捷方式；所有请求调用改为 `runRequestPipeline`，目标是 `client.ts` 小于 220 行且不再包含策略函数定义。

- [x] **步骤 4：更新结构文档**

在 README 的维护/目录说明中列出新模块职责，明确内部模块不属于公开导入路径；不新增旧路径兼容层。

- [x] **步骤 5：验证管线**

运行完整 `npm test`；预期所有测试通过且测试数量不下降。使用 `rg` 确认 `client.ts` 不再定义 retry/cache/response parsing helper。

- [x] **步骤 6：提交**

运行 `git add src/core/pipeline.ts src/core/client.ts README.md src/core/types.ts tests && git commit -m "refactor(http): move request lifecycle into pipeline"`。

## 任务 5：发布前验证与交付

**文件：** 不新增运行时代码；检查 `package.json`、`dist`、Git 状态。

- [ ] **步骤 1：构建和完整测试**

运行 `npm test`，确认 TypeScript build 和全部 Node tests 均通过。

- [ ] **步骤 2：打包检查**

串行运行 `npm pack --dry-run --json`，确认只包含 `dist`、`README.md`、`LICENSE` 和 `package.json`，没有 tests、设计文档或 `superpowers`。

- [ ] **步骤 3：入口 smoke**

运行根入口、`./dist/adapters/node-http2.js` 和 `./dist/adapters/node-http3.js` 的 ESM import 检查，确认公开工厂和 adapter 导出存在。

- [ ] **步骤 4：差异与远端检查**

运行 `git diff --check`、`git status --short --branch`、`git log -1 --oneline`；提交所有实现改动后推送 `git push origin main`，再用 `git ls-remote origin refs/heads/main` 核对远端指针。

- [ ] **步骤 5：交付说明**

报告 `client.ts` 最终行数、测试数量、包文件数量、提交哈希和仍保留的 HTTP/3 transport、XHR 字节限速边界。
