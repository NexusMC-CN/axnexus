# axnexus 传输增强实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在保持现有 Axios 风格请求兼容性的前提下，完成 headers、传输进度、限速调度、完整响应和可选 HTTP/2/HTTP/3 adapter 的模块化扩展。

**架构：** 将现有请求生命周期收敛到 `core`，把 header 语义、传输流、adapter、缓存、安全和工具拆到独立目录。默认入口只静态依赖 Fetch/XHR 可用代码，Node HTTP/2 通过独立导出路径加载，HTTP/3 通过注入式 QUIC transport 提供能力。

**技术栈：** TypeScript 5.9、ESM、原生 Fetch/XHR/ReadableStream、Node 内置测试运行器、零运行时第三方依赖。

---

## 文件与职责总览

**创建：**

- `src/core/client.ts`：实例 API、请求生命周期、重试和完整响应方法。
- `src/core/pipeline.ts`：配置解析、拦截器、调度器和 adapter 编排。
- `src/core/errors.ts`、`src/core/interceptors.ts`、`src/core/types.ts`：核心类型与错误。
- `src/headers/headers.ts`、`src/headers/methods.ts`、`src/headers/presets.ts`：AxiosHeaders 和 method defaults。
- `src/transfer/progress.ts`、`src/transfer/upload.ts`、`src/transfer/download.ts`、`src/transfer/rate-limiter.ts`、`src/transfer/multipart.ts`：进度、流、限速和 multipart 辅助。
- `src/adapters/fetch.ts`、`src/adapters/xhr.ts`、`src/adapters/types.ts`、`src/adapters/node-http2.ts`、`src/adapters/node-http3.ts`：传输 adapter 和协议扩展。
- `src/cache/get-cache.ts`、`src/security/csrf.ts`、`src/security/header-sanitizer.ts`、`src/utils/query.ts`、`src/utils/body.ts`、`src/utils/response.ts`：现有能力按职责迁移。
- `tests/core/*.test.ts`、`tests/headers/*.test.ts`、`tests/transfer/*.test.ts`、`tests/adapters/*.test.ts`：新增模块测试。

**修改：**

- `src/index.ts`：导出稳定公共 API，默认入口不加载 Node 内置模块。
- `package.json`：增加 `./node-http2`、`./node-http3` 条件导出和测试脚本匹配新目录。
- `README.md`：补充 headers、进度、限速、完整响应和 adapter 示例及运行环境限制。

**兼容保留：** 根目录旧模块保留 re-export 文件，确保现有内部导入和 AVMCBBS 后续接入的迁移成本可控；实现代码只放在新目录。

### 任务 1：迁移核心类型与目录边界

**文件：**
- 创建：`src/core/types.ts`、`src/core/errors.ts`、`src/core/interceptors.ts`、`src/core/client.ts`、`src/core/pipeline.ts`
- 修改：`src/types.ts`、`src/errors.ts`、`src/interceptors.ts`、`src/client.ts`
- 测试：`tests/core/compatibility.test.ts`

- [ ] **步骤 1：编写失败的兼容测试**

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHttpClient } from '../../src/index.js';

test('legacy root entry keeps data-returning request API', async () => {
  const client = createHttpClient({ adapter: async () => new Response('{"ok":true}') });
  assert.deepEqual(await client.get('/health'), { ok: true });
});
```

- [ ] **步骤 2：运行兼容测试确认迁移基线**

运行：`node --test --experimental-strip-types tests/core/compatibility.test.ts`

预期：现有入口通过；新目录文件尚不存在时，新增测试保持可运行并记录迁移前基线。

- [ ] **步骤 3：迁移实现并保留 re-export**

把现有类型、错误、拦截器和 client 实现拆到 `src/core`，将 `src/types.ts`、`src/errors.ts`、`src/interceptors.ts`、`src/client.ts` 改为只 re-export 新路径。`HttpAdapter` 扩展为可返回 adapter metadata 的结构，`HttpResponse.headers` 改为 `AxiosHeaders`，同时保留对 `HeadersInit` 的输入兼容。

- [ ] **步骤 4：运行构建与全量旧测试**

运行：`npm test`

预期：既有 24 个测试全部通过；若测试数量因新增测试增加，所有失败必须来自尚未实现的明确功能而不是路径或类型错误。

- [ ] **步骤 5：Commit**

```bash
git add src/core src/types.ts src/errors.ts src/interceptors.ts src/client.ts tests/core/compatibility.test.ts
git commit -m "refactor: organize axnexus core modules"
```

### 任务 2：实现 AxiosHeaders 与 method defaults

**文件：**
- 创建：`src/headers/headers.ts`、`src/headers/methods.ts`、`src/headers/presets.ts`
- 修改：`src/core/types.ts`、`src/core/pipeline.ts`、`src/index.ts`
- 测试：`tests/headers/headers.test.ts`、`tests/headers/methods.test.ts`

- [ ] **步骤 1：编写失败测试**

覆盖大小写不敏感 `set/get/has/delete/clear`、rewrite predicate、`normalize(true)`、`concat`、`toJSON`、`toString`、迭代、shortcut，以及 `common`/method/request 的覆盖顺序和 CR/LF 拒绝。

- [ ] **步骤 2：运行 headers 测试确认失败**

运行：`node --test --experimental-strip-types tests/headers/*.test.ts`

预期：因 `AxiosHeaders` 和 method merge 尚未导出而失败。

- [ ] **步骤 3：实现最小 header 容器**

以规范化名称为 key 保存原始名称和值，实现 `HeaderValue` 清理、parser、matcher、批量操作、迭代器和 shortcut。发送前将 `null`、`false`、`undefined` 过滤为字符串 map，并对非法名称和值抛出 `ERR_INVALID_HEADER`。

- [ ] **步骤 4：接入请求配置解析**

在 pipeline 中按 defaults -> common -> method -> request 合并，大小写冲突只保留 request 优先的单一键；将最终 `AxiosHeaders` 转换为 adapter 可发送的 `Headers`。

- [ ] **步骤 5：运行 headers 测试与构建**

运行：`node --test --experimental-strip-types tests/headers/*.test.ts; npm run build`

预期：新增 headers 测试全部通过，TypeScript 零错误。

- [ ] **步骤 6：Commit**

```bash
git add src/headers src/core/types.ts src/core/pipeline.ts src/index.ts tests/headers
git commit -m "feat: add axios-style headers"
```

### 任务 3：实现进度事件、multipart 和限速调度

**文件：**
- 创建：`src/transfer/progress.ts`、`src/transfer/upload.ts`、`src/transfer/download.ts`、`src/transfer/rate-limiter.ts`、`src/transfer/multipart.ts`
- 修改：`src/core/types.ts`、`src/core/pipeline.ts`
- 测试：`tests/transfer/progress.test.ts`、`tests/transfer/rate-limiter.test.ts`、`tests/transfer/multipart.test.ts`

- [ ] **步骤 1：编写失败测试**

使用可控时钟和假的可读流验证进度 `loaded/total/percent/rate/estimated`、未知长度不产生百分比、最小间隔节流、最终事件、token bucket、请求频率、并发、优先级、资源组、队列超时和取消。

- [ ] **步骤 2：运行 transfer 测试确认失败**

运行：`node --test --experimental-strip-types tests/transfer/*.test.ts`

预期：因 transfer 模块和调度器尚未存在而失败。

- [ ] **步骤 3：实现 progress 计算与节流**

实现单调 `loaded`、基于时间窗口的 `rate`、只在 total 为有限非负数时计算 `percent`，并在完成或错误时清理 interval/timer。监听器异常不得破坏请求主流程。

- [ ] **步骤 4：实现流包装和 multipart 辅助**

为下载 `ReadableStream` 提供逐块计数包装；为可观察请求体提供上传计数包装；`createFormData` 只负责追加字段/文件，不复制或缓存大文件。

- [ ] **步骤 5：实现调度器**

采用 token bucket + priority queue，任务状态包含 `queued/running/completed/canceled/failed`；每个客户端独立实例，`resourceGroup` 共享 bucket 和并发计数；所有等待用可取消 timer，队列超时抛 `ERR_RATE_LIMIT_QUEUE_TIMEOUT`。

- [ ] **步骤 6：运行 transfer 测试与构建**

运行：`node --test --experimental-strip-types tests/transfer/*.test.ts; npm run build`

预期：所有 transfer 测试通过，限速测试不依赖真实墙钟超过 200ms 的等待。

- [ ] **步骤 7：Commit**

```bash
git add src/transfer src/core/types.ts src/core/pipeline.ts tests/transfer
git commit -m "feat: add transfer progress and rate limiting"
```

### 任务 4：拆分 Fetch/XHR adapter 与响应解析

**文件：**
- 创建：`src/adapters/types.ts`、`src/adapters/fetch.ts`、`src/adapters/xhr.ts`、`src/utils/body.ts`、`src/utils/response.ts`、`src/security/header-sanitizer.ts`
- 修改：`src/core/pipeline.ts`、`src/core/errors.ts`
- 测试：`tests/adapters/fetch.test.ts`、`tests/adapters/xhr.test.ts`、`tests/adapters/response.test.ts`

- [ ] **步骤 1：编写失败测试**

覆盖 Fetch download progress、XHR upload progress、abort/timeout 映射、`maxBodySize`、空响应、raw Response 不进入缓存、adapter capability detection，以及浏览器构建路径不解析 Node 内置模块。

- [ ] **步骤 2：运行 adapter 测试确认失败**

运行：`node --test --experimental-strip-types tests/adapters/*.test.ts`

预期：新 adapter 导出和响应 metadata 尚不存在而失败。

- [ ] **步骤 3：实现 Fetch/XHR adapter**

Fetch adapter 使用 `Response.body` 包装下载流；XHR adapter 显式设置 `responseType`、监听 `upload.onprogress` 和 `onprogress`，并把 `status/statusText/headers` 转为标准响应。两者都尊重外部 `AbortSignal` 和 timeout。

- [ ] **步骤 4：实现请求体和响应工具**

把现有 JSON/FormData/Blob/ArrayBuffer/URLSearchParams 编码移到 `utils/body.ts`，把 json/text/blob/arrayBuffer/response 解析、空体判断和响应大小限制移到 `utils/response.ts`。超过 `maxBodySize` 先停止读取再抛 `ERR_MAX_BODY_SIZE`。

- [ ] **步骤 5：运行 adapter 测试与构建**

运行：`node --test --experimental-strip-types tests/adapters/*.test.ts; npm run build`

预期：adapter、解析和错误映射测试通过。

- [ ] **步骤 6：Commit**

```bash
git add src/adapters src/utils/body.ts src/utils/response.ts src/security/header-sanitizer.ts src/core tests/adapters
git commit -m "feat: add fetch xhr adapters and transfer metadata"
```

### 任务 5：接入完整响应 API、协议与计时 metadata

**文件：**
- 修改：`src/core/client.ts`、`src/core/pipeline.ts`、`src/core/types.ts`、`src/cache/get-cache.ts`
- 测试：`tests/core/response-api.test.ts`、`tests/core/timings.test.ts`

- [ ] **步骤 1：编写失败测试**

验证 `requestResponse/getResponse/postResponse/putResponse/patchResponse/deleteResponse` 返回 `data/status/statusText/AxiosHeaders/config/raw/protocol/timings`，默认便捷方法仍只返回 data，`responseType: 'response'` 与完整响应一致且不缓存。

- [ ] **步骤 2：实现 response facade**

让 pipeline 返回完整 `HttpResponse<T>`，client 便捷方法调用同一内部请求并分别投影 data 或完整响应；记录 `queuedAt/startedAt/headersAt/completedAt/duration/uploadDuration/downloadDuration`，adapter 未提供协议时使用 `unknown`。

- [ ] **步骤 3：运行 core response 测试**

运行：`node --test --experimental-strip-types tests/core/response-api.test.ts tests/core/timings.test.ts`

预期：完整响应和 metadata 测试通过。

- [ ] **步骤 4：运行全量测试与构建**

运行：`npm test; git diff --check`

预期：旧测试与新增测试全部通过，差异无空白错误。

- [ ] **步骤 5：Commit**

```bash
git add src/core src/cache/get-cache.ts tests/core
git commit -m "feat: expose full responses and timings"
```

### 任务 6：实现可选 Node HTTP/2 adapter 和 HTTP/3 transport 契约

**文件：**
- 创建：`src/adapters/node-http2.ts`、`src/adapters/node-http3.ts`、`tests/adapters/node-http2.test.ts`、`tests/adapters/node-http3.test.ts`
- 修改：`package.json`、`src/index.ts`、`src/adapters/types.ts`

- [ ] **步骤 1：编写失败测试**

验证 HTTP/2 adapter 能力检测、authority/path/header 映射、stream abort、GOAWAY/连接错误转换和协议标记；验证没有注入 QUIC transport 时 HTTP/3 明确抛 `ERR_UNSUPPORTED_ADAPTER`。

- [ ] **步骤 2：实现 Node HTTP/2 adapter**

通过动态加载 Node `http2` 模块避免默认入口静态依赖；按 origin 复用 client session，创建 request stream，处理 `response`、`data`、`end`、`error`、`aborted`，把取消映射为 `RST_STREAM`，响应 protocol 标记为 `h2`，并在 session 关闭时清理池。

- [ ] **步骤 3：实现 HTTP/3 注入式 adapter**

定义 `QuicTransport` 的 `request`、`cancel`、`close` 能力和 `createHttp3Adapter(transport)` 工厂；工厂不探测或导入实验性全局对象，transport 缺失时同步抛稳定错误。

- [ ] **步骤 4：增加条件导出并运行 adapter 测试**

在 `package.json` 增加 `./node-http2` 和 `./node-http3`，默认 `.` 只导出浏览器/Fetch 安全入口。运行：`node --test --experimental-strip-types tests/adapters/node-http2.test.ts tests/adapters/node-http3.test.ts; npm run build`

预期：HTTP/2 在 Node 环境通过 mock/server 测试；HTTP/3 在无 transport 环境只验证明确失败，不伪造 h3 成功。

- [ ] **步骤 5：Commit**

```bash
git add src/adapters/node-http2.ts src/adapters/node-http3.ts src/adapters/types.ts src/index.ts package.json tests/adapters/node-http*.test.ts
git commit -m "feat: add optional http2 and http3 adapters"
```

### 任务 7：迁移缓存与安全模块并更新 README

**文件：**
- 创建：`src/cache/get-cache.ts`、`src/security/csrf.ts`、`src/utils/query.ts`
- 修改：`src/cache.ts`、`src/csrf.ts`、`src/query.ts`、`src/index.ts`、`README.md`
- 测试：`tests/cache/*.test.ts`、`tests/security/csrf.test.ts`、`tests/query/query.test.ts`

- [ ] **步骤 1：迁移并保留根路径 re-export**

把现有缓存、CSRF、query 实现移动到职责目录，根文件只 re-export；缓存 key 使用最终 `AxiosHeaders`，保留 generation/inflight race 修复。

- [ ] **步骤 2：补充 README 示例**

加入 `AxiosHeaders`、method defaults、`onUploadProgress`/`onDownloadProgress`、`rateLimit`、完整响应、XHR 显式选择、HTTP/2/HTTP/3 条件导入和环境限制；明确包不包含 AVMCBBS 业务 API。

- [ ] **步骤 3：运行完整验收**

运行：`npm test; npm run build; git diff --check; npm pack --dry-run`

预期：所有测试通过，构建产物只包含 dist/README/LICENSE/package 元数据，默认导出不引入 Node adapter。

- [ ] **步骤 4：Commit**

```bash
git add src/cache src/security src/utils/query.ts src/cache.ts src/csrf.ts src/query.ts src/index.ts README.md
git commit -m "docs: document modular transport capabilities"
```

### 任务 8：最终检查点

**文件：** 全部已变更文件。

- [ ] **步骤 1：运行全套命令**

```bash
npm test
npm run build
git diff --check
npm pack --dry-run
git status --short --branch
```

- [ ] **步骤 2：核对公共导出和包内容**

确认 `dist/index.d.ts` 含 headers、progress、rateLimit、response API；确认 `./node-http2`、`./node-http3` 只在对应入口加载；确认工作区没有未提交的实现文件。

- [ ] **步骤 3：Commit（仅当最终检查产生必要修正）**

```bash
git add src tests README.md package.json package-lock.json
git commit -m "chore: verify axnexus transport package"
```
