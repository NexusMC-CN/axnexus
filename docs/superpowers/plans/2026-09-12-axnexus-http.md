# axnexus HTTP 客户端实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 创建一个可独立安装、构建和测试的 Axios 风格 TypeScript HTTP 客户端包 `axnexus`，提炼 AVMCBBS 前端请求层的通用能力。

**架构：** `createHttpClient` 持有实例默认配置、拦截器和 GET 缓存；请求经过 URL/query 规范化、body 编码、请求拦截器、超时/取消和重试后交给可注入的 `HttpAdapter`。默认 adapter 使用原生 `fetch`，响应先转换为 `HttpResponse`，经过响应拦截器后由客户端返回 `data`，错误统一为 `HttpError`。

**技术栈：** TypeScript 5.x、ESM、原生 Fetch API、Node 内置 `node:test`、TypeScript declaration emit；零运行时依赖。

---

## 文件总览

- 创建：`package.json`，包元数据、exports、build/test 脚本。
- 创建：`tsconfig.json`，严格 TypeScript 与 declaration 输出配置。
- 创建：`.gitignore`，忽略 `node_modules`、`dist`、日志和本地环境文件。
- 创建：`src/types.ts`，公共配置、请求、响应、adapter、缓存和拦截器类型。
- 创建：`src/errors.ts`，`HttpError` 与稳定错误码。
- 创建：`src/interceptors.ts`，实例级请求/响应拦截器管理器。
- 创建：`src/query.ts`，params 序列化、baseURL 合并和 URL 规范化。
- 创建：`src/cache.ts`，GET TTL 缓存、深拷贝、inflight 去重和实例缓存清理。
- 创建：`src/csrf.ts`，可选、无全局副作用的 CSRF 请求拦截器。
- 创建：`src/client.ts`，客户端实例、默认 fetch adapter、body/response 处理、超时、取消、重试和缓存编排。
- 创建：`src/index.ts`，稳定公共导出。
- 创建：`tests/query.test.ts`，URL 和 query 行为。
- 创建：`tests/interceptors.test.ts`，拦截器顺序、异步和隔离。
- 创建：`tests/cache.test.ts`，缓存和并发去重行为。
- 创建：`tests/client.test.ts`，请求生命周期、错误、取消、重试和响应解析。
- 创建：`tests/csrf.test.ts`，CSRF 辅助函数。
- 创建：`README.md`，安装、API、错误、缓存、拦截器、取消/超时和 FormData 示例。

### 任务 1：初始化可构建的包骨架

**文件：**
- 创建：`package.json`
- 创建：`tsconfig.json`
- 创建：`.gitignore`
- 创建：`src/index.ts`
- 测试：`tests/client.test.ts`

- [ ] **步骤 1：写包构建冒烟测试**

在 `tests/client.test.ts` 中先写一个只验证公共工厂存在的测试：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/index.ts';

test('exports createHttpClient', () => {
  assert.equal(typeof createHttpClient, 'function');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行 `npm test`，预期因 `package.json`、脚手架和 `createHttpClient` 尚不存在而失败。

- [ ] **步骤 3：编写最小包配置和导出**

`package.json` 使用名称 `axnexus`、版本 `0.1.0`、`type: module`，入口为 `dist/index.js`，类型为 `dist/index.d.ts`，exports 同时声明 `types` 和 `import`；脚本为 `build: tsc -p tsconfig.json`、`test: npm run build && node --test --experimental-strip-types tests/*.test.ts`。

`tsconfig.json` 开启 `strict`、`declaration`、`declarationMap`、`outDir: dist`、`rootDir: .`，目标 ES2022，模块 NodeNext，并包含 `DOM` Fetch 类型库。`src/index.ts` 先导出一个可调用的最小 `createHttpClient` 实现，任务 4 再替换为完整客户端。

- [ ] **步骤 4：运行冒烟测试和构建**

运行 `npm test`，预期测试通过并生成 `dist/index.js`、`dist/index.d.ts`。

- [ ] **步骤 5：提交骨架**

```text
git add package.json tsconfig.json .gitignore src/index.ts tests/client.test.ts
git commit -m "chore: initialize axnexus package"
```

### 任务 2：定义类型、错误和拦截器

**文件：**
- 创建：`src/types.ts`
- 创建：`src/errors.ts`
- 创建：`src/interceptors.ts`
- 修改：`src/index.ts`
- 创建：`tests/interceptors.test.ts`

- [ ] **步骤 1：写拦截器失败测试**

覆盖请求拦截器按注册顺序执行、响应拦截器按逆序执行、异步返回值、`eject` 和实例隔离。测试通过 `createInterceptorManager` 直接验证链条：注册 `a`、`b`，执行后断言顺序 `a,b`；移除 `a` 后只执行 `b`；第二个 manager 不受影响。

- [ ] **步骤 2：运行测试确认失败**

运行 `node --test --experimental-strip-types tests/interceptors.test.ts`，预期因模块不存在而失败。

- [ ] **步骤 3：实现公共类型和错误对象**

在 `src/types.ts` 定义 `ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response'`、`QueryParams`、`RequestConfig`、`ResolvedRequestConfig`、`HttpResponse<T>`、`HttpAdapter`、`CacheOptions`、`RetryDelay`、`InterceptorFulfilled`、`InterceptorRejected` 和 `HttpClient`。`RequestConfig` 扩展 `RequestInit`，增加 `baseURL`、`params`、`data`、`timeout`、`retry`、`retryDelay`、`retryOn`、`retryUnsafeMethods`、`cache`、`bypassCache`、`responseType` 和 `allowAbsoluteURL`。

在 `src/errors.ts` 实现 `HttpError extends Error`，稳定 code 包含 `ERR_BAD_RESPONSE`、`ERR_NETWORK`、`ETIMEDOUT`、`ERR_CANCELED` 和 `ERR_BAD_PAYLOAD`；构造函数保留 `status`、`config`、`response`、`isAbort`、`isTimeout`、`retryable` 和原始 `cause`。

- [ ] **步骤 4：实现拦截器管理器**

`InterceptorManager<T>` 保存带 ID 的 `{ fulfilled?, rejected? }`，`use` 返回递增 ID，`eject` 标记为空槽，`forEach` 跳过空槽。导出 `createInterceptorManager` 和 `applyInterceptorChain`，链条函数支持同步/异步处理与 rejected handler。

- [ ] **步骤 5：运行拦截器测试**

运行 `node --test --experimental-strip-types tests/interceptors.test.ts`，预期全部通过。

- [ ] **步骤 6：提交类型和拦截器**

```text
git add src/types.ts src/errors.ts src/interceptors.ts src/index.ts tests/interceptors.test.ts
git commit -m "feat: add http types errors and interceptors"
```

### 任务 3：实现 URL、query 和 GET 缓存基础设施

**文件：**
- 创建：`src/query.ts`
- 创建：`src/cache.ts`
- 创建：`tests/query.test.ts`
- 创建：`tests/cache.test.ts`

- [ ] **步骤 1：写 query 和缓存失败测试**

`tests/query.test.ts` 覆盖 `/api/` 与 `/users` 合并为 `/api/users`、`params: { page: 1, tag: ['a', 'b'], empty: null }` 序列化为 `page=1&tag=a&tag=b`、绝对 URL 在 `allowAbsoluteURL: false` 时抛错。

`tests/cache.test.ts` 覆盖同 key 并发调用只执行一次 loader、TTL 到期后再次执行、返回值修改不污染缓存、`bypassCache` 不读写缓存和 `clear` 清空实例缓存。

- [ ] **步骤 2：运行测试确认失败**

运行 `node --test --experimental-strip-types tests/query.test.ts tests/cache.test.ts`，预期因模块不存在而失败。

- [ ] **步骤 3：实现 query 工具**

`serializeParams` 使用 `URLSearchParams`，递归处理 `string | number | boolean` 和数组，跳过 `null`/`undefined`，对象值使用 JSON 字符串。`resolveURL` 规范化 `baseURL` 和 path 斜杠，绝对 URL 受 `allowAbsoluteURL` 控制。

- [ ] **步骤 4：实现实例缓存**

实现 `GetRequestCache`，内部持有 `Map<string, CacheEntry>` 和 `Map<string, Promise<unknown>>`；`getOrLoad` 在 TTL 内返回深拷贝结果，同 key 复用 inflight Promise；深拷贝优先 `structuredClone`，失败时返回原值；提供 `clear` 和过期条目清理。缓存 key 接收最终 URL、排序后的请求头和实例唯一 ID。

- [ ] **步骤 5：运行 query 和缓存测试**

运行同一测试命令，预期全部通过。

- [ ] **步骤 6：提交基础设施**

```text
git add src/query.ts src/cache.ts tests/query.test.ts tests/cache.test.ts
git commit -m "feat: add query serialization and get cache"
```

### 任务 4：实现客户端请求生命周期

**文件：**
- 创建：`src/client.ts`
- 修改：`src/index.ts`
- 修改：`tests/client.test.ts`

- [ ] **步骤 1：写客户端失败测试**

使用可控 `HttpAdapter` 记录配置并返回 `Response`，覆盖：

- `get` 生成 baseURL、params、`X-Request-Id` 和 `Accept: application/json`。
- 普通对象 `data` JSON 序列化，FormData 原样传递且不覆盖 `Content-Type`。
- JSON、text、blob、arrayBuffer、response、204 和空 body 解析。
- 401/500 转换为 `HttpError` 并保留 status/response。
- 外部 AbortSignal 得到 `ERR_CANCELED` 且 adapter 只调用一次。
- timeout 得到 `ETIMEDOUT`。
- 网络错误和 503 按配置重试，非幂等请求默认不重试，`retryUnsafeMethods` 开启后才重试；重试复用 request ID。
- GET TTL、并发去重、mutation 成功后清理缓存。

- [ ] **步骤 2：运行客户端测试确认失败**

运行 `node --test --experimental-strip-types tests/client.test.ts`，预期因完整客户端尚未实现而失败。

- [ ] **步骤 3：实现默认配置和请求规范化**

`createHttpClient` 创建唯一实例 ID、默认 headers、`InterceptorManager<RequestConfig>`、`InterceptorManager<HttpResponse<unknown>>` 和 `GetRequestCache`。`request` 合并实例/请求配置，规范化 method、URL、headers、credentials 和 body；普通 JSON 值自动 stringify，FormData/Blob/ArrayBuffer/URLSearchParams/string 原样传递。

- [ ] **步骤 4：实现 fetch adapter 和响应解析**

默认 adapter 调用 `fetch(url, init)`。`parseResponse` 按 responseType 处理数据：`response` 返回原始 Response，`json` 检查空 body 后调用 `response.json()`，其他类型调用对应 Response 方法；JSON 解析失败抛 `ERR_BAD_PAYLOAD`。非 2xx 先读取 JSON `{ message, error, code }` 或文本，再构造 `HttpError`。

- [ ] **步骤 5：实现超时、取消和重试**

每次尝试创建内部 AbortController，将外部 signal 转发到内部 controller；timeout timer 触发时设置 `ETIMEDOUT` 标志并 abort。捕获 AbortError 时按标志区分取消/超时/网络错误；重试只在未取消、未超过次数且错误符合状态/网络规则时执行，`retryDelay` 支持固定毫秒或函数。

- [ ] **步骤 6：串联拦截器和缓存**

请求拦截器在每次尝试前执行，响应拦截器在解析后逆序执行。GET 在非 `bypassCache` 时通过 `GetRequestCache.getOrLoad` 包裹完整请求；非 GET 成功后调用实例 `clearCache`。请求 ID 在规范化阶段生成一次并在重试中复用。

- [ ] **步骤 7：运行客户端测试**

运行 `node --test --experimental-strip-types tests/client.test.ts`，预期全部通过；随后运行 `npm run build`，预期生成完整声明文件。

- [ ] **步骤 8：提交客户端**

```text
git add src/client.ts src/index.ts tests/client.test.ts
git commit -m "feat: implement axios-style http client"
```

### 任务 5：实现可选 CSRF 拦截器

**文件：**
- 创建：`src/csrf.ts`
- 创建：`tests/csrf.test.ts`
- 修改：`src/index.ts`

- [ ] **步骤 1：写 CSRF 失败测试**

测试注入 `readToken: () => 'token'` 后，POST 添加配置的 header，GET 不添加；调用方显式设置同名 header 时保持显式值；默认方法集合为 `POST, PUT, PATCH, DELETE`；token 为空时不添加。

- [ ] **步骤 2：运行测试确认失败**

运行 `node --test --experimental-strip-types tests/csrf.test.ts`，预期因模块不存在而失败。

- [ ] **步骤 3：实现 CSRF 请求拦截器**

`createCsrfInterceptor({ readToken, cookieName?, headerName?, methods? })` 返回 `(config) => RequestConfig`，只复制 headers 后添加 token，不读取 `document.cookie`，不修改全局 fetch；支持同步 token reader 和显式 header 优先级。

- [ ] **步骤 4：运行测试并提交**

运行测试和 `npm run build`，预期通过；提交：

```text
git add src/csrf.ts src/index.ts tests/csrf.test.ts
git commit -m "feat: add opt-in csrf interceptor"
```

### 任务 6：编写 README 和完成验证

**文件：**
- 创建：`README.md`

- [ ] **步骤 1：写 README**

README 使用中文说明包定位和非目标，包含可直接运行的安装/创建实例、`get/post`、params、FormData、错误判断、拦截器、取消/超时、重试、GET 缓存和 CSRF 示例，并说明默认 fetch adapter、Node 18+ 和浏览器支持范围。

- [ ] **步骤 2：运行全量验证**

依次运行：

```text
npm test
npm run build
git diff --check
git status --short --branch
```

预期测试全部通过、构建无诊断、diff 无空白错误，工作区只包含本次包文件且提交历史包含所有任务提交。

- [ ] **步骤 3：提交文档和验证结果**

```text
git add README.md
git commit -m "docs: document axnexus http client"
```

## 计划自检

- 规格中的基础请求、响应类型、HTTP 错误、超时、取消、重试、GET 缓存、拦截器、CSRF、FormData、构建和文档分别由任务 2 至任务 6 覆盖。
- 规格中的 AVMCBBS 业务排除项通过核心模块无业务导入和 README 非目标说明覆盖。
- 计划中的公共类型均有定义；`RequestConfig`、`HttpResponse`、`HttpError`、`HttpAdapter` 和拦截器签名在任务 2 先定义，后续任务复用同一命名。
- 每个任务都有失败测试、最小实现、通过验证和提交步骤；未要求 AVMCBBS 改造，也不修改源项目。
