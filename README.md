# axnexus

一个基于原生 Fetch/XHR 的 TypeScript HTTP 客户端，提供 Axios 风格的实例 API、大小写不敏感 headers、进度捕捉、限速调度、超时取消、重试和 GET 缓存。

## 特性

- 零运行时依赖，支持现代浏览器和 Node.js 18+。
- 提供 `get`、`post`、`put`、`patch`、`delete` 和通用 `request` 方法。
- 自动处理 JSON、文本、`Blob`、`ArrayBuffer`、`FormData` 和 `Response`。
- 支持请求/响应拦截器、请求 ID、超时、`AbortSignal` 和可配置重试。
- 支持结构化重试策略、`Retry-After`、退避抖动、总超时、状态校验和 JSON 转换钩子。
- 支持 GET 响应 TTL 缓存和并发请求去重。
- 提供可独立使用的 stale-while-revalidate 响应缓存和 SSR/middleware `fetchJson`。
- `AxiosHeaders` 支持大小写不敏感读写、规范化、合并、迭代和 method shortcut。
- Fetch 下载进度、XHR 上传进度、响应大小限制和完整 response metadata。
- 提供有界并发分块上传编排器，不绑定 AVMCBBS 的上传端点协议。
- 按客户端/资源组调度的并发、优先级、请求频率和队列超时限制。
- 提供脱敏后的请求生命周期日志适配器，不输出 Cookie 和 Authorization 原文。
- 可选 Node HTTP/2 adapter，以及只通过注入 transport 启用的 HTTP/3 adapter。
- CSRF 通过显式拦截器接入，不修改全局 `fetch`，不读取页面 Cookie。

这个包只负责通用 HTTP 传输，不包含 AVMCBBS 的业务 API、认证弹窗、站点配置或上传端点协议。

## 安装

```bash
npm install axnexus
```

## 快速开始

```typescript
import { createHttpClient } from 'axnexus';

const http = createHttpClient({
  baseURL: 'https://api.example.com/v1',
  timeout: 10_000,
  retry: 2,
  retryDelay: 300,
});

const user = await http.get<{ id: string; name: string }>('/users/me');

const post = await http.post<{ id: string }, { title: string }>('/posts', {
  title: 'Hello',
});
```

默认凭据策略是 `include`，默认自动添加 `Accept: application/json` 和 `X-Request-Id`。调用方显式传入同名请求头时会保留调用方的值。

## Headers

```typescript
import { AxiosHeaders } from 'axnexus';

const headers = new AxiosHeaders({ Authorization: 'Bearer token' });
headers.setAccept('application/json');
headers.set('X-Trace-Id', 'trace-1');
console.log(headers.get('authorization'));
```

请求配置的 `headers` 可以包含 `common` 和按 method 分组的默认值；合并顺序是客户端默认值、`common`、当前 method、请求级值，后者优先且不会产生大小写重复键。

## 请求配置

```typescript
const result = await http.get('/items', {
  params: {
    page: 1,
    tag: ['release', 'typescript'],
  },
  headers: {
    Authorization: 'Bearer token',
  },
  responseType: 'json',
  timeout: 5_000,
});
```

`params` 使用 `URLSearchParams` 编码，数组会生成重复的 query key，`null` 和 `undefined` 会被跳过。相对路径会与 `baseURL` 合并；如果不允许绝对 URL，可以设置 `allowAbsoluteURL: false`。

普通对象、数组、数字、布尔值和 `null` 会自动 JSON 序列化。字符串、`FormData`、`Blob`、`ArrayBuffer`、`URLSearchParams` 和其他 `BodyInit` 会原样传递。

### 状态、超时和转换

```typescript
const result = await http.get('/jobs/123', {
  // 仅把 500 以上视为错误，404 会正常返回
  validateStatus: (status) => status < 500,
  totalTimeout: 30_000,
  parseJson: (text) => JSON.parse(text, reviveDates),
  transformResponse: (data) => ({ ...data as object, receivedAt: Date.now() }),
});
```

`timeout` 限制单次 adapter 尝试，`totalTimeout` 覆盖限速排队、重试等待和所有尝试。`throwHttpErrors: false` 可以关闭默认的非 2xx 异常；`transformRequest` 和 `stringifyJson` 可用于接入自定义序列化协议。

## FormData

```typescript
const form = new FormData();
form.set('file', file);
form.set('purpose', 'content');

const uploaded = await http.post<{ url: string }>('/upload', form);
```

客户端不会为 `FormData` 手动设置 `Content-Type`，浏览器会自动补充 multipart boundary。

## 进度和限速

下载进度在 Fetch response body 可读时逐块报告；上传进度需要显式选择 XHR adapter：

```typescript
import { createHttpClient, xhrAdapter } from 'axnexus';

const browserHttp = createHttpClient({ adapter: xhrAdapter });
await browserHttp.post('/upload', form, {
  onUploadProgress: ({ loaded, total, percent }) => {
    console.log('upload', loaded, total, percent);
  },
});

await http.get('/large-file', {
  onDownloadProgress: ({ loaded, total, rate }) => {
    console.log('download', loaded, total, rate);
  },
  rateLimit: {
    maxConcurrent: 2,
    bytesPerSecond: 2_000_000,
    priority: 10,
    queueTimeout: 5_000,
    resourceGroup: 'downloads',
  },
});
```

`RateLimiter` 也可以单独使用。限速等待可被 `AbortSignal` 取消；队列超时会抛出 `ERR_RATE_LIMIT_QUEUE_TIMEOUT`。默认 Fetch adapter 不伪造上传进度，因为标准 Fetch 没有跨环境一致的请求体进度事件。

## 完整响应

便捷方法默认只返回 `data`，需要状态码、headers、协议和 timings 时使用 response 方法：

```typescript
const response = await http.getResponse<{ id: string }>('/users/me');
console.log(response.data, response.status, response.protocol, response.timings.duration);
```

可用方法为 `requestResponse`、`getResponse`、`postResponse`、`putResponse`、`patchResponse` 和 `deleteResponse`。完整响应不会进入 GET data cache；`responseType: 'response'` 在普通方法中仍返回原始 `Response`。

## 错误处理

```typescript
import { HttpError, isHttpError } from 'axnexus';

try {
  await http.get('/private');
} catch (error) {
  if (isHttpError(error)) {
    console.error(error.code, error.status, error.message);
    console.error(error.response?.data);
  }
}
```

`HttpError.code` 可能是：

| Code | 含义 |
| --- | --- |
| `ERR_BAD_RESPONSE` | 服务端返回非 2xx 状态 |
| `ERR_NETWORK` | 网络层失败 |
| `ETIMEDOUT` | 请求超过超时时间 |
| `ERR_CANCELED` | 外部 `AbortSignal` 取消 |
| `ERR_BAD_PAYLOAD` | 成功响应无法解析为 JSON |
| `ERR_INVALID_HEADER` | header 名称或值包含非法字符 |
| `ERR_MAX_BODY_SIZE` | 响应体超过 `maxBodySize` |
| `ERR_RATE_LIMIT_QUEUE_TIMEOUT` | 请求在限速队列中超时 |
| `ERR_UNSUPPORTED_ADAPTER` | 当前环境不支持所选 adapter |

## 取消和超时

```typescript
const controller = new AbortController();
const pending = http.get('/large-report', {
  signal: controller.signal,
  timeout: 30_000,
});

controller.abort();
await pending;
```

外部取消会抛出 `ERR_CANCELED`，超时会抛出 `ETIMEDOUT`。取消请求不会自动重试。

## 重试

默认重试状态码是 `408`、`429`、`500`、`502`、`503` 和 `504`。GET、HEAD、OPTIONS、TRACE 等幂等方法可以按状态自动重试；POST、PUT、PATCH、DELETE 默认不按状态重试。

```typescript
const created = await http.post('/jobs', payload, {
  retry: 2,
  retryDelay: (attempt) => attempt * 500,
  retryUnsafeMethods: true,
});
```

网络错误和超时会遵循同一套重试次数配置。重试期间会复用同一个 `X-Request-Id`。

需要更细粒度控制时可以传入对象：

```typescript
const response = await http.getResponse('/upstream', {
  retry: {
    limit: 3,
    methods: ['GET'],
    statusCodes: [429, 502, 503],
    delay: (attempt) => 200 * 2 ** (attempt - 1),
    maxDelay: 5_000,
    jitter: true,
    respectRetryAfter: true,
    beforeRetry: ({ retryCount, error }) => logger.warn({ retryCount, error }),
  },
});
```

默认仍只对幂等方法按状态码重试；`methods` 可以显式放开方法范围，`shouldRetry` 可以完全接管判断。

## 拦截器

```typescript
http.interceptors.request.use((config) => {
  const headers = new Headers(config.headers);
  headers.set('Authorization', 'Bearer token');
  return { ...config, headers };
});

http.interceptors.response.use((response) => {
  return {
    ...response,
    data: response.data,
  };
});
```

请求拦截器按注册顺序执行，响应拦截器按注册逆序执行。`use` 返回数字 ID，可以传给对应管理器的 `eject` 移除。拦截器只属于当前客户端实例，不会修改全局状态。

## GET 缓存

```typescript
const cachedHttp = createHttpClient({
  baseURL: 'https://api.example.com',
  cache: { ttl: 30_000 },
});

await cachedHttp.get('/catalog');
await cachedHttp.get('/catalog'); // TTL 内复用缓存
await cachedHttp.get('/catalog', { bypassCache: true });

cachedHttp.clearCache();
```

缓存只作用于 GET，请求 key 包含最终 URL 和请求头（自动生成的请求 ID 除外）。相同 key 的进行中请求会共享一次 adapter 调用；成功的非 GET 请求会清空当前实例缓存。缓存保存在内存中，不跨实例或持久化。

需要 stale-while-revalidate 或 stale-if-error 时直接使用 `ResponseCache`：

```typescript
import { ResponseCache } from 'axnexus';

const cache = new ResponseCache<{ items: string[] }>();
const data = await cache.getOrLoad('catalog', loadCatalog, {
  ttl: 30_000,
  staleWhileRevalidate: 120_000,
  staleIfError: true,
});
```

`fetchJson` 是不带客户端实例状态的轻量 JSON helper，适合 SSR、middleware 和一次性请求，会转发显式 `cookie`、处理空响应并允许注入 `fetch` 和 JSON parser；`timeout` 与 AVMCBBS 原实现的 `timeoutMs` 都可用：

```typescript
import { fetchJson } from 'axnexus';

const data = await fetchJson<{ ok: boolean }>('https://api.example.test/health', {
  cookie: request.headers.get('cookie') ?? undefined,
  timeout: 5_000,
});
```

## 分块上传

`uploadChunks` 只负责编排分块、并发和聚合进度，实际上传由调用方提供，因此可以复用 AVMCBBS 现有的 multipart、对象存储或分片协议：

```typescript
import { uploadChunks } from 'axnexus';

const parts = await uploadChunks(bytes, {
  chunkSize: 5 * 1024 * 1024,
  concurrency: 3,
  onProgress: (loaded, total) => console.log(loaded / total),
  upload: ({ index, body }) => putPart(index, body),
});
```

## 请求观测

`createRequestLogger` 将请求开始、完成和错误统一成可注入的记录格式，并默认脱敏 `authorization`、`cookie` 和 `set-cookie`：

```typescript
import { createRequestLogger } from 'axnexus';

const logger = createRequestLogger((record) => telemetry.emit(record));
logger.start({ method: 'GET', url, headers });
```

## CSRF

CSRF 不会默认启用。使用 `createCsrfInterceptor` 注入 token reader：

```typescript
import { createCsrfInterceptor } from 'axnexus';

const csrf = createCsrfInterceptor({
  readToken: () => getCsrfTokenFromYourStore(),
});

http.interceptors.request.use(csrf);
```

默认只处理 `POST`、`PUT`、`PATCH` 和 `DELETE`，显式设置的 header 优先于 reader 返回的 token。

## HTTP/2 和 HTTP/3

HTTP/2 只在 Node 环境通过独立入口启用，adapter 会按 origin 复用 session，并在完整响应中标记 `protocol: 'h2'`：

```typescript
import { createHttpClient } from 'axnexus';
import { nodeHttp2Adapter } from 'axnexus/node-http2';

const nodeHttp = createHttpClient({ adapter: nodeHttp2Adapter });
const response = await nodeHttp.getResponse('/health');
console.log(response.protocol); // h2
```

HTTP/3 不绑定具体 QUIC 实现，调用方提供 `QuicTransport` 后从 `axnexus/node-http3` 创建 adapter：

```typescript
import { createHttp3Adapter } from 'axnexus/node-http3';

const http3 = createHttpClient({ adapter: createHttp3Adapter(myQuicTransport) });
```

没有注入 transport 时会抛出 `ERR_UNSUPPORTED_ADAPTER`。默认入口不会加载 Node 内置模块，也不会把 HTTP/1.1 Fetch 请求误标为 HTTP/2 或 HTTP/3。

## 模块结构

```text
src/
  core/       client、错误、拦截器和类型
  headers/    AxiosHeaders、method defaults 和 presets
  transfer/   progress、限速、multipart 和 chunked 上传编排
  adapters/   fetch、xhr、node-http2、node-http3
  cache/      GET TTL、inflight 去重和 stale 响应缓存
  server/     SSR/middleware JSON helper
  observability/ 请求生命周期日志与脱敏
  security/   CSRF 与 header sanitizer
  utils/      body、response、query、AbortSignal 工具
```

该包只负责通用 HTTP 传输，不包含 AVMCBBS 的业务 API、认证弹窗、站点配置或上传端点协议。

## 开发

```bash
npm install
npm test
npm run build
```

构建产物位于 `dist/`，包不需要 AVMCBBS 或其他业务项目才能构建和测试。

## 许可证

MIT
