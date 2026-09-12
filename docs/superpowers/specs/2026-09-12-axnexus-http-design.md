# axnexus HTTP 客户端设计规格

## 目标

`axnexus` 是一个独立、零运行时依赖、基于原生 `fetch` 的 TypeScript HTTP 客户端包。它提炼 AVMCBBS 前端当前请求层中稳定且通用的能力，以 Axios 风格的实例 API 对外提供，不携带 AVMCBBS 的业务接口、认证 UI 或站点配置。

首版目标是让浏览器、Node.js 和 SSR 调用方都能通过同一套类型化客户端完成常见 HTTP 请求，同时保留足够的配置入口，供调用方自行接入认证、CSRF、日志和自定义传输适配器。

## 非目标

- 不迁移 AVMCBBS 的 `api`、`admin` 或 feature API 模块。
- 不内置 AVMCBBS 的登录过期处理、弹窗、中文业务错误文案或页面跳转。
- 不内置站点资源 URL、Socket URL、Unicode 风险策略或前端日志上报。
- 不绑定 AVMCBBS 的 `/upload/session` 分片协议；首版上传只保证通用 `FormData` 请求能力。
- 不实现 Node 专属 HTTP 栈；默认使用运行环境提供的 `fetch`，调用方可注入 adapter。

## 技术和包约束

- TypeScript、ESM、原生 `fetch`，运行时依赖为零。
- 输出 `dist/index.js` 和 `dist/index.d.ts`，发布内容只包含 `dist`、`README.md` 和必要的许可证文件。
- 支持现代浏览器和 Node 18+ 的标准 Fetch API；类型层可引用标准 Fetch 类型，运行时不依赖 DOM API。
- 使用严格 TypeScript 配置，测试使用 Node 内置测试运行器或仓库内可用的轻量测试方案。

## 公共 API

### 创建客户端

提供 `createHttpClient(config?)`，返回一个独立状态的客户端实例。配置包括：

- `baseURL?: string`：相对路径请求的基础地址。
- `headers?: HeadersInit`：默认请求头。
- `credentials?: RequestCredentials`：默认凭据策略，默认值为 `include`。
- `timeout?: number`：默认超时时间，零或未设置表示不启用。
- `retry?: number`：默认最大重试次数，默认值为 `0`。
- `retryDelay?: number | ((attempt: number, error: HttpError) => number)`：重试等待策略。
- `retryOn?: number[]`：可重试的 HTTP 状态码，默认包含 `408, 429, 500, 502, 503, 504`。
- `adapter?: HttpAdapter`：可选自定义传输适配器，默认使用 fetch adapter。
- `cache?: CacheOptions`：GET 缓存与并发去重的默认配置。
- `requestId?: boolean | (() => string)`：是否自动生成 `X-Request-Id`，默认开启。
- `onRequestError?: (error: HttpError) => void`：非侵入式错误观察钩子。

客户端实例提供：

```ts
request<T = unknown>(config: RequestConfig): Promise<T>
get<T = unknown>(url: string, config?: RequestConfig): Promise<T>
post<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>
put<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>
patch<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>
delete<T = unknown>(url: string, config?: RequestConfig): Promise<T>
clearCache(): void
```

`RequestConfig` 扩展 `RequestInit`，增加 `baseURL`、`params`、`data`、`timeout`、`signal`、`retry`、`retryDelay`、`retryOn`、`retryUnsafeMethods`、`cache`、`bypassCache` 和 `responseType`。`params` 使用结构化 query 序列化，跳过 `undefined` 和 `null`，数组按重复键编码。

请求体处理规则：普通对象、数组和基本值自动 JSON 序列化；`FormData`、`Blob`、`ArrayBuffer`、`URLSearchParams`、字符串和现有 `BodyInit` 原样传递。只有自动 JSON 序列化时才补充 `Content-Type: application/json`，不会覆盖调用方显式设置的值。

## 拦截器

客户端暴露 `interceptors.request` 和 `interceptors.response`，各自支持 `use(onFulfilled, onRejected): number` 与 `eject(id): void`。请求拦截器按注册顺序执行，响应拦截器按注册逆序执行；拦截器可以同步或异步返回配置/响应，也可以抛出错误终止链路。

拦截器属于实例级状态，不影响其他实例，也不修改全局 `fetch`。CSRF、语言头、Cookie 转发和业务日志都通过拦截器或配置钩子接入。

## 传输和响应

默认 fetch adapter 接收解析后的 `RequestConfig`，返回原始 `Response`。客户端根据 `responseType` 解析为 `json`（默认）、`text`、`blob`、`arrayBuffer` 或 `response`。`204`、空响应体和 `Content-Length: 0` 返回 `null`；JSON 响应解析失败抛出格式错误。

客户端只把 2xx 响应视为成功；其他状态统一转换为 `HttpError`。错误对象至少包含：`message`、`name`、`code`、`status`、`config`、`response`、`isAbort`、`isTimeout` 和 `retryable`。网络错误、超时和 HTTP 错误必须可区分，外部 `AbortSignal` 取消不得自动重试。

## 超时、取消和重试

每次尝试创建内部 `AbortController`，将外部 signal 与超时 signal 合并，并在尝试结束后清理监听器和计时器。超时错误使用稳定的 `ETIMEDOUT` code；外部取消使用 `ERR_CANCELED`。

重试只针对网络错误、超时和 `retryOn` 命中的 HTTP 状态，采用 `retryDelay` 计算等待时间。每次重试重新执行 adapter，但复用同一个请求 ID。GET、HEAD、OPTIONS 等幂等方法默认允许按状态重试；POST、PUT、PATCH、DELETE 等非幂等方法默认不自动重试，只有请求级 `retryUnsafeMethods: true` 才启用。网络错误是否重试由同一 retry 配置控制。

## GET 缓存和并发去重

仅对 GET 生效。缓存 key 由最终 URL、相关请求头和客户端实例组成，避免不同认证上下文共享响应。命中有效 TTL 时返回深拷贝结果；同一 key 的进行中请求共享 Promise。非 GET 成功完成后清空该实例的 GET 缓存；请求级 `bypassCache` 可跳过读取和写入。缓存不跨实例、不写入持久化存储。

## URL 和安全默认值

URL 解析使用 `URL` 和 `URLSearchParams`，不使用字符串拼接来编码 query。`baseURL` 尾部斜杠和请求路径首部斜杠只保留一个。客户端不接受危险协议作为相对资源 URL；绝对 URL 是否允许由 `allowAbsoluteURL` 配置控制，默认允许以便兼容通用 HTTP 使用场景。

请求头合并保持调用方优先级。默认生成 `X-Request-Id`，但显式提供时必须保留。CSRF 不在核心中读取 Cookie；提供 `createCsrfInterceptor({ cookieName, headerName, methods })` 辅助函数，从调用方注入的 cookie reader 获取 token，并只对配置的方法添加 header。

## 目录边界

```text
src/
  client.ts       客户端实例、请求流程和便捷方法
  types.ts        配置、adapter、响应和拦截器类型
  errors.ts       HttpError 与错误 code
  interceptors.ts 拦截器管理器
  cache.ts        GET TTL 缓存和 inflight 去重
  query.ts        params 序列化和 URL 规范化
  csrf.ts         可选 CSRF 拦截器
  index.ts        公共导出
tests/
```

核心模块不得导入浏览器 UI、Astro、React/Vue、AVMCBBS 路径或 Node 专属模块。

## 测试验收

测试通过可控的 mock adapter 或 mock fetch 验证：

1. 基础方法、baseURL、query、默认头和 JSON/FormData body。
2. 各种 responseType、204/空响应和 JSON 格式错误。
3. `HttpError` 的状态、响应、错误 code 和 retryable 属性。
4. 外部取消、超时、计时器清理和取消不重试。
5. HTTP 状态重试、网络错误重试、退避次数和请求 ID 复用。
6. GET TTL、并发去重、深拷贝、bypassCache 和 mutation 后失效。
7. 请求/响应拦截器顺序、异步行为、eject 和实例隔离。
8. CSRF 辅助函数只处理配置的方法且不覆盖显式 header。
9. `npm run build`、测试命令和 `git diff --check` 全部通过。

## 交付标准

交付一个可独立 `npm install`、`npm run build`、运行测试并查看 README 示例的包项目。README 必须说明安装、创建实例、请求配置、错误处理、拦截器、缓存、取消/超时和 FormData 用法，并明确该包不包含 AVMCBBS 业务 API。
