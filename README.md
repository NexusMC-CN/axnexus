# axnexus

一个基于原生 Fetch/XHR 的 TypeScript HTTP 客户端，提供 Axios 风格的实例 API、大小写不敏感 headers、进度捕捉、限速调度、超时取消、重试和 GET 缓存。

## 特性

- 零运行时依赖，面向现代浏览器、Node.js 18+ 和提供标准 Web API 的 Bun 运行环境。
- 提供 `get`、`head`、`options`、`trace`、`connect`、`post`、`put`、`patch`、`delete` 和通用 `request` 方法。
- 自动处理 JSON、文本、`Blob`、`ArrayBuffer`、`FormData` 和 `Response`。
- 支持请求/响应拦截器、请求 ID、超时、`AbortSignal` 和可配置重试。
- 支持结构化重试策略、`Retry-After`、退避抖动、总超时、状态校验和 JSON 转换钩子。
- 支持 GET 响应 TTL 缓存和并发请求去重。
- 提供可独立使用的 stale-while-revalidate 响应缓存和 SSR/middleware `fetchJson`。
- `AxiosHeaders` 支持大小写不敏感读写、规范化、合并、迭代和 method shortcut。
- Fetch 下载进度、XHR 上传进度、响应大小限制和完整 response metadata。
- 提供有界并发分块上传编排器，可接入自定义上传协议。
- 按客户端/资源组调度的并发、优先级、请求频率和队列超时限制。
- 提供请求生命周期日志适配器，默认脱敏 Cookie 和 Authorization 等敏感请求头。
- 可选 Node HTTP/2 adapter，以及只通过注入 transport 启用的 HTTP/3 adapter。
- CSRF 通过显式拦截器接入，不修改全局 `fetch`，不读取页面 Cookie。

## 安装

```bash
npm install @nexusmc-cn/axnexus
```

包以 ESM 发布，使用 `import` 引入，并内置 TypeScript 类型声明。API 采用实例、拦截器和 `AxiosHeaders` 风格，便捷请求方法默认直接返回解析后的数据。

## 快速开始

```typescript
import { createHttpClient } from '@nexusmc-cn/axnexus';

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

`include` 允许浏览器跨源请求携带凭据，服务端必须正确配置 CORS 和 `Access-Control-Allow-Credentials`；需要原生 Fetch 的 `same-origin` 行为时请显式传入 `credentials`。

## Headers

```typescript
import { AxiosHeaders } from '@nexusmc-cn/axnexus';

const headers = new AxiosHeaders({ Authorization: 'Bearer token' });
headers.setAccept('application/json');
headers.set('X-Trace-Id', 'trace-1');
console.log(headers.get('authorization'));
```

`AxiosHeaders.from(value)` 会复用已有的 `AxiosHeaders`，或把原生 `Headers`、`Map`/其他可迭代键值对、普通对象转换成统一实例；需要交给 Fetch/XHR 时调用 `headers.toHeaders()`。`false` 是显式禁用该 header 的哨兵值（例如 `Content-Type: false`），`null`/`undefined` 则表示不发送。这样可以明确区分业务层的可变 headers 和 adapter 使用的原生 `Headers`。

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

客户端缓存使用 `cache: { ttl }` 或 `cache: false`；如果需要把原生 Fetch 的缓存模式传给 adapter，请使用 `fetchCache`（或等价的 `requestCache`），例如 `fetchCache: 'no-store'`。`dispatcher` 和 `agent` 只在 Node 运行时透传；`duplex`、`priority` 和 `window` 按运行环境支持情况使用。`ReadableStream` 请求体会自动设置 `duplex: 'half'`，Bun 的专有 Fetch 选项不会自动混入通用配置。

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

除 `responseType: 'response'` 外，`204`、`205`、`304`、`HEAD` 和空响应体返回 `null`；JSON 或文本模式下，只有空白字符的响应也返回 `null`。`responseType: 'text'` 保留非空文本原样，`blob` 返回带响应 `Content-Type` 的 Blob，`arrayBuffer` 返回对应二进制值。HEAD 的 `Content-Length` 描述对应 GET 资源的大小，不作为实际下载字节或响应体大小处理。

客户端和 `fetchJson` 都接受可选的 Standard Schema 校验器：解析后执行 `schema['~standard'].validate()`，校验失败抛出 `ERR_SCHEMA_VALIDATION`。客户端在校验通过后才运行 `transformResponse`；无需绑定 Zod、Valibot 等具体库。空响应跳过校验，JSON `null` 则仍然校验；校验器返回带 `issues` 的结果（包括空数组）都视为失败。

JSON（包括自定义 `parseJson`）解析失败抛出 `ERR_BAD_PAYLOAD`，`transformResponse` 失败抛出 `ERR_TRANSFORM_RESPONSE`。错误状态的 payload 会按文本读取后尝试 JSON 解析，超过 `maxBodySize` 时置为 `null`，原始 HTTP 状态错误仍保留。被丢弃或未读完的响应体会主动取消，以释放连接。

`validateStatus` 或 `throwHttpErrors` 回调自身抛错时返回 `ERR_INVALID_STATUS_POLICY`，并且不会当作可重试的网络错误重发请求。

`maxBodySize` 以字节为单位，默认不限制；负数、`NaN`、`Infinity` 及非数字值也按不限制处理。它会先检查响应的 `Content-Length`（HEAD 与 `204`/`205`/`304` 除外）；可读流按块累计，超过上限会立即停止读取并取消底层响应体；没有可读流的响应只能在运行时完成缓冲后检查大小。`responseType: 'response'` 返回的响应仍保留 `url`、`redirected` 和 `type` 等 metadata。

`transformRequest` 和 `stringifyJson` 可用于接入自定义序列化协议，任一请求转换或序列化钩子失败都会抛出 `ERR_TRANSFORM_REQUEST`。

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
import { createHttpClient, xhrAdapter } from '@nexusmc-cn/axnexus';

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

`RateLimiter` 也可以单独使用。限速等待可被 `AbortSignal` 取消；队列超时会抛出 `ERR_RATE_LIMIT_QUEUE_TIMEOUT`。默认 Fetch adapter 不伪造上传进度，因为标准 Fetch 没有跨环境一致的请求体进度事件；XHR 的原生进度事件可用于上传/下载进度，但浏览器 XHR 不提供可靠的字节级发送节流，因此 `bytesPerSecond` 只在 Fetch、Node HTTP/2 和由 transport 实现的 HTTP/3 路径上作用于传输过程。

## 完整响应

便捷方法默认只返回 `data`，需要状态码、headers、协议和 timings 时使用 response 方法：

```typescript
const response = await http.getResponse<{ id: string }>('/users/me');
console.log(response.data, response.status, response.protocol, response.timings.duration);
```

可用方法为 `requestResponse`、`getResponse`、`headResponse`、`optionsResponse`、`traceResponse`、`connectResponse`、`postResponse`、`putResponse`、`patchResponse` 和 `deleteResponse`。完整响应不会进入 GET data cache；`responseType: 'response'` 在普通方法中仍返回原始 `Response`。

返回原始 `Response` 时，调用方应读完或取消响应体，以释放连接；请求的取消、超时和传输资源清理会延续到响应体读取结束、失败或被取消。

### API 签名速查

| API | 签名 |
| --- | --- |
| 创建实例 | `createHttpClient(config?: HttpClientConfig): HttpClient` |
| 通用请求 | `request<T>(config)` 或 `request<T>(url, config?): Promise<T>` |
| 完整响应 | `requestResponse<T>(config)` 或 `requestResponse<T>(url, config?): Promise<HttpResponse<T>>` |
| 便捷方法 | `get/head/options/trace/connect<T>(url, config?)`、`delete<T>(url, config?)` |
| 带请求体方法 | `post<T, B>(url, data?, config?)`、`put<T, B>(...)`、`patch<T, B>(...)` |
| 完整响应便捷方法 | `getResponse`、`headResponse`、`optionsResponse`、`traceResponse`、`connectResponse`、`postResponse`、`putResponse`、`patchResponse`、`deleteResponse` |

完整字段类型以包导出的 `RequestConfig`、`HttpClientConfig`、`HttpResponse` 和 `HttpError` 为准。

## 错误处理

```typescript
import { isHttpError } from '@nexusmc-cn/axnexus';

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
| `ERR_BAD_RESPONSE` | HTTP 状态不满足状态策略，默认是非 2xx 状态 |
| `ERR_NETWORK` | 网络层失败 |
| `ETIMEDOUT` | 请求超过超时时间 |
| `ERR_CANCELED` | 外部 `AbortSignal` 取消 |
| `ERR_BAD_PAYLOAD` | 成功响应无法解析为 JSON |
| `ERR_TRANSFORM_REQUEST` | 请求转换钩子抛出异常 |
| `ERR_TRANSFORM_RESPONSE` | 响应转换钩子抛出异常 |
| `ERR_SCHEMA_VALIDATION` | 响应未通过 Standard Schema 校验 |
| `ERR_INVALID_HEADER` | header 名称或值包含非法字符 |
| `ERR_INVALID_STATUS_POLICY` | 状态策略回调抛出异常 |
| `ERR_MAX_BODY_SIZE` | 响应体超过 `maxBodySize` |
| `ERR_RATE_LIMIT_QUEUE_TIMEOUT` | 请求在限速队列中超时 |
| `ERR_UNSUPPORTED_ADAPTER` | 当前环境不支持所选 adapter |
| `ERR_PROTOCOL_NEGOTIATION` | transport 无法协商请求的协议 |

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

`timeout` 约束单次 adapter 尝试，包括响应体读取和响应拦截器等待；`totalTimeout` 从进入限速队列前开始计时，还覆盖排队、重试判断、退避等待以及所有尝试。二者超时都会抛出 `ETIMEDOUT`。

外部取消会抛出 `ERR_CANCELED`，并会尽早结束仍在等待的请求拦截器、请求转换器、限速排队、adapter、响应体读取和响应拦截器。单次超时与外部取消竞争时，以先触发者为准；总超时计时器已经触发时返回 `ETIMEDOUT`。取消请求不会自动重试。自定义 adapter 和异步回调仍需主动响应 signal，才能停止已经开始的底层操作。

## 重试

默认不重试；设置 `retry` 后，默认重试状态码是 `408`、`429`、`500`、`502`、`503` 和 `504`，允许的方法是 GET、HEAD、OPTIONS 和 TRACE。POST、PUT、PATCH、DELETE 默认不自动重试。

```typescript
const created = await http.post('/jobs', payload, {
  retry: 2,
  retryDelay: (attempt) => attempt * 500,
  retryUnsafeMethods: true,
});
```

网络错误和单次超时会遵循同一套重试次数配置，取消不会重试。请求级 `retry` 对象会继承客户端级对象，只有显式提供的字段会覆盖默认值；请求级数字只覆盖 `limit`，不会丢弃客户端的状态码、方法和退避设置。退避优先级为请求级 `retryDelay`、客户端级 `retryDelay`、`retry.delay`，数字延迟按第几个重试尝试线性累加，函数参数 `attempt` 从 `1` 开始；`shouldRetry` 和 `beforeRetry` 收到的 `RetryContext.delay` 是应用 `Retry-After`、`maxDelay` 和抖动后的最终值。`validateStatus` 优先于 `throwHttpErrors`；被 `validateStatus` 接受或被 `throwHttpErrors: false` 接受的状态不会生成 `ERR_BAD_RESPONSE`，也不会触发状态重试。

状态码策略的优先级是请求级 `retryOn`、请求级 `retry.statusCodes`、客户端级 `retryOn`、客户端级 `retry.statusCodes`，最后才是内置默认值；建议同一层只使用一种写法。默认 `respectRetryAfter: true`：有效的 `Retry-After` 会覆盖本地退避，之后 `maxDelay` 仍是最终上限，抖动也不会突破它；设为 `false` 才会忽略服务端退避。

`retry.errorCodes` 非空时是一份白名单，只有其中的错误码会按方法和次数策略重试，`ERR_NETWORK` 和超时也不会例外；未提供或为空时按默认错误策略处理。白名单可以覆盖错误默认的 `retryable: false`。默认策略不会重试本地状态回调抛出的 `ERR_INVALID_STATUS_POLICY`。

每次尝试（包括重试）都会重新经过限速排队，因此自动重试不会绕过 `requestsPerInterval`；重试钩子（`beforeRetry`）和响应拦截器在等待期间不占用 `maxConcurrent` 名额，可以在其中安全地通过同一客户端发起令牌刷新等请求。

重试期间会复用同一个 `X-Request-Id`。`totalTimeout` 到期后不会进入下一次重试，即使还剩重试次数也会直接返回 `ETIMEDOUT`。

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

`methods` 可以显式调整方法范围，`shouldRetry` 可以接管默认的方法、状态和错误判断。重试使用本轮实际发送的 method/body；诊断用的 `error.config` 不决定重试资格。外部取消和不可重放的 `ReadableStream` 请求体始终不会重试，即使 `shouldRetry` 返回 `true`。

## 拦截器

```typescript
import { AxiosHeaders } from '@nexusmc-cn/axnexus';

http.interceptors.request.use((config) => {
  const headers = AxiosHeaders.from(config.headers);
  headers.setAuthorization('Bearer token');
  return { ...config, headers };
});

http.interceptors.response.use((response) => {
  return {
    ...response,
    data: response.data,
  };
});

http.interceptors.response.use(undefined, (error) => {
  // 可在这里记录或恢复错误；继续抛出则保留重试策略。
  console.warn(error);
  throw error;
});
```

请求拦截器按注册顺序执行，响应拦截器按注册逆序执行。请求拦截器回调收到的是可直接调用 `.set()`、`.delete()` 的 `AxiosHeaders`；它是本次请求的最终头集合，因此删除客户端默认头不会在后续合并时恢复。`use` 返回数字 ID，可以传给对应管理器的 `eject` 移除。拦截器只属于当前客户端实例，不会修改全局状态。

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

缓存只作用于 GET。请求 key 包含 method、最终 URL、规范化请求头（自动生成的 `X-Request-Id` 除外）、`responseType` 以及 `credentials`、`mode`、`redirect`、`referrer`、`referrerPolicy`、`integrity` 和 `keepalive` 等 Fetch 行为选项。相同 key 的进行中请求会共享一次 adapter 调用。

以下请求会跳过客户端缓存与进行中请求去重，以保留各调用方的控制策略：

- 带 `signal`，或启用了 `timeout` / `totalTimeout`。
- 设置了 `maxBodySize`、`onDownloadProgress`、`rateLimit`、`schema`、`parseJson`、`transformResponse`、`validateStatus`、`throwHttpErrors`、`dispatcher` 或 `agent`，或包含请求体。
- 请求级 `retry`、`retryOn` 或 `retryDelay` 与客户端默认值不一致。
- 所属实例注册了请求或响应拦截器。

非 GET 请求只要被发出过就会清空当前实例缓存——即使响应解析或校验随后失败，因为服务端可能已经应用了这次写入。缓存保存在内存中，不跨实例或持久化；`GetRequestCache` 默认最多保留 512 条、单条超过约 1 MB 的结果不入缓存，并提供 `prune()` 主动回收过期条目。

### stale-while-revalidate 响应缓存

需要 stale-while-revalidate 或 stale-if-error 时直接使用 `ResponseCache`。它与客户端 GET 缓存独立，不共享条目：

```typescript
import { ResponseCache } from '@nexusmc-cn/axnexus';

const cache = new ResponseCache<{ items: string[] }>({ maxEntries: 128 });
const data = await cache.getOrLoad('catalog', loadCatalog, {
  ttl: 30_000,
  staleWhileRevalidate: 120_000,
  staleIfError: true,
});
```

`maxEntries` 限制条目数量，默认是 `256`。写入和读取都会优先使用 `structuredClone`，再回退到 JSON clone；后者可能丢失 `Date`、`Map` 等类型信息。两种方式都不支持的值会按原引用返回，因此缓存值应视为不可变数据。没有公开的 clone 开关。

直接使用 `GetRequestCache` 时，`options.signal` 只取消当前调用方的等待，不取消共享 loader。`ResponseCache` 本身不提供调用方取消选项，loader 的取消策略由调用方管理。

## SSR 和一次性 JSON 请求

`fetchJson` 是不带客户端实例状态的轻量 JSON helper，适合 SSR、middleware 和一次性请求。它支持显式传入 `cookie`、注入 `fetch` 和 JSON parser；`headers` 接受与主客户端相同的 `HeaderInput`（包括 `AxiosHeaders`），`maxBodySize` 默认不限制响应体。`timeout` 和 `timeoutMs` 都可用，同时提供时以 `timeoutMs` 为准。

它不会继承 `createHttpClient` 的 `credentials: 'include'` 默认值；浏览器需要跨源凭据时显式传入 `credentials: 'include'`，服务端转发 Cookie 时使用 `cookie`。

```typescript
import { fetchJson } from '@nexusmc-cn/axnexus';

const data = await fetchJson<{ ok: boolean }>('https://api.example.test/health', {
  cookie: request.headers.get('cookie') ?? undefined,
  timeout: 5_000,
});
```

非 2xx 状态不会自动抛错，而是返回 `null`；`204`、`205`、`304`、`HEAD`、`Content-Length: 0`、空字节或只有空白字符的响应同样返回 `null`。需要状态码和原始响应时使用 `fetchJsonResult`：

```typescript
import { fetchJsonResult } from '@nexusmc-cn/axnexus';

const result = await fetchJsonResult<{ ok: boolean }>('https://api.example.com/health', {
  timeout: 5_000,
});
if (result.status >= 400) {
  console.warn('upstream status:', result.status);
}
```

成功状态的非空响应交给 `parseJson`（默认 `JSON.parse`）；解析失败抛出 `ERR_BAD_PAYLOAD`。超时或外部 signal 取消按原生 `AbortError` 传播，与客户端的 `ETIMEDOUT` / `ERR_CANCELED` 错误码不同。`fetchJsonResult` 的 `response` 已被 helper 消费或取消；需要原始响应体时使用客户端的 `responseType: 'response'`。

## 分块上传

`uploadChunks` 接受 `Uint8Array`，负责编排分块、并发和聚合进度，实际上传由调用方提供，可接入 multipart、对象存储或自定义分片协议：

```typescript
import { uploadChunks } from '@nexusmc-cn/axnexus';

const controller = new AbortController();
const parts = await uploadChunks(bytes, {
  chunkSize: 5 * 1024 * 1024,
  concurrency: 3,
  signal: controller.signal,
  retry: 2, // 每个分片额外尝试 2 次
  retryDelay: (attempt) => attempt * 200,
  onPartError: ({ part, attempt, error }) => reportPartFailure(part.index, attempt, error),
  onProgress: (loaded, total) => console.log(loaded / total),
  upload: ({ index, body, signal }) => putPart(index, body, { signal }),
});
```

`retry` 只作用于失败的分片，不会重新上传已经成功的分片；`onPartError` 会收到每次失败（包括最终失败）以及同一个编排 `signal`。重试复用相同的 `body`，上传回调不应修改它；`part.end` 是不包含在分片内的结束偏移。

用户取消时调用 `controller.abort()`。编排器会停止新分片、重试等待和对异步回调的等待，并抛出原生 `AbortError`；回调必须把 `part.signal` 传给底层请求，才能取消在途网络操作。取消后的迟到结果不会写入聚合结果或触发成功进度。

某个分片最终失败，或 `onPartError`、`retryDelay`、`onProgress` 抛错时，整体 Promise reject 并停止调度新分片；已经在途的上传不会自动取消或回滚。服务端清理、断点续传和合并由上传协议负责，上传回调应按分片 ID 保证幂等。`onProgress` 只累计成功分片的字节数，空 source 不产生进度事件。

`chunkSize` 和 `concurrency` 向下取整为正整数，非有限或非正值回退为 `1`；`retryDelay` 的非有限或负值回退为 `0`。需要严格参数校验时，应在调用前完成。

## 请求观测

`createRequestLogger` 将请求开始、完成和错误统一成可注入的记录格式，并默认脱敏 `authorization`、`cookie` 和 `set-cookie`。`record`、`start`、`complete` 和 `error` 都遵守同一套输入与脱敏规则；`start` 返回一次性生命周期句柄，句柄会用 `options.now`（默认 `Date.now`）计算耗时：

```typescript
import { createRequestLogger } from '@nexusmc-cn/axnexus';

const logger = createRequestLogger((record) => telemetry.emit(record));
const span = logger.start({ method: 'GET', url, headers });
try {
  const response = await http.getResponse(url);
  span.complete({ status: response.status, responseBytes: Number(response.headers.get('content-length')) || undefined });
} catch (error) {
  span.error({ error });
}
```

`record(input)` 可以直接写入完整记录；字段如下：

| 字段 | 说明 |
| --- | --- |
| `phase` | `start`、`complete` 或 `error` |
| `method` / `url` | 请求方法和 URL，method 会规范化为大写 |
| `headers` | 接受 `HeaderInput`，输出时规范化并脱敏敏感头 |
| `status` | 可选的 HTTP 状态码 |
| `duration` | 毫秒数；生命周期句柄可自动计算 |
| `responseBytes` | 可选的响应字节数 |
| `error` | 错误摘要，裁剪任意附加字段并脱敏 `HttpError.config.headers` |

`start()` 返回的句柄只结束自己的生命周期，且只记录一次；顶层 `logger.complete()` 和 `logger.error()` 是 `record()` 的快捷方式，不会结束已有句柄。通过 `redactHeaders` 可追加需要脱敏的 header 名称。URL 和错误消息会按原文保留，记录前应避免在其中放入凭据。

## CSRF

CSRF 不会默认启用。使用 `createCsrfInterceptor` 注入 token reader：

```typescript
import { createCsrfInterceptor } from '@nexusmc-cn/axnexus';

const csrf = createCsrfInterceptor({
  readToken: () => getCsrfTokenFromYourStore(),
});

http.interceptors.request.use(csrf);
```

默认只处理 `POST`、`PUT`、`PATCH` 和 `DELETE`，显式设置的 header 优先于 reader 返回的 token。

## HTTP/2 和 HTTP/3

HTTP/2 通过独立入口启用，adapter 会按 origin 复用 session，并在完整响应中标记 `protocol: 'h2'`。Node 使用原生 `node:http2`；Bun 中通过 Node 兼容层接入的 HTTP/2 按实验性能力使用：

```typescript
import { createHttpClient } from '@nexusmc-cn/axnexus';
import { nodeHttp2Adapter } from '@nexusmc-cn/axnexus/node-http2';

const nodeHttp = createHttpClient({
  baseURL: 'https://api.example.com',
  adapter: nodeHttp2Adapter,
});
const response = await nodeHttp.getResponse('/health');
console.log(response.protocol); // h2
```

每个请求有独立 stream，单个请求的错误、取消或超时只关闭该 stream。session 自身发生 `error` 或 `close` 时，会结束该 session 上的活动请求并移出复用池；收到 `GOAWAY` 后新请求会建立新连接。调用方仍需分别处理每个请求的错误。

空闲 session 会被 `unref()`。需要显式释放 adapter 持有的传输资源时调用：

```typescript
await nodeHttp.close();
```

Node HTTP/2 上传写入会等待 `drain`，下载在消费端跟不上时暂停底层流；`ReadableStream` 请求体支持读取期间取消，且不会自动重试。HTTP/3 的连接管理和背压由注入的 transport 负责。

HTTP/3 不绑定具体 QUIC 实现，调用方提供 `QuicTransport` 后从 `@nexusmc-cn/axnexus/node-http3` 创建 adapter：

```typescript
import { createHttp3Adapter } from '@nexusmc-cn/axnexus/node-http3';

const http3 = createHttpClient({ adapter: createHttp3Adapter(myQuicTransport) });
```

没有注入 transport 时会抛出 `ERR_UNSUPPORTED_ADAPTER`。默认入口不会加载 Node 内置模块；默认 Fetch adapter 不提供底层协议探测，完整响应中的 `protocol` 为 `'unknown'`。

### Bun 运行时

根入口依赖标准 Fetch、Headers、Response、ReadableStream、Blob 和 AbortSignal。Bun 的支持范围取决于这些 Web API 以及所选 adapter 的兼容性：

| 入口/功能 | Bun 状态 | 说明 |
| --- | --- | --- |
| `@nexusmc-cn/axnexus` | 标准 Web API | 使用 Bun 提供的 Fetch 及相关 Web API |
| `@nexusmc-cn/axnexus/node-http2` | 实验性 | 依赖 Bun 的 `node:http2` 兼容层，使用前应覆盖实际所需的 TLS、ALPN、session 复用和错误隔离场景 |
| `@nexusmc-cn/axnexus/node-http3` | 需注入 transport | 由调用方提供适用于当前运行时的 QUIC transport |
| XHR adapter | 浏览器专用 | Bun 没有浏览器 XHR 时会返回 `ERR_UNSUPPORTED_ADAPTER`，不会自动 polyfill |

跨运行时的 `RequestConfig` 不包含 Bun 专有 Fetch 选项；需要运行时扩展时，可通过 `createFetchAdapter` 注入自定义 fetch 实现。

## 运行环境差异

| 能力 | 浏览器 Fetch | 浏览器 XHR | Node.js 18+ Fetch | Node.js HTTP/2 | 注入式 HTTP/3 |
| --- | --- | --- | --- | --- | --- |
| JSON、文本、Blob、ArrayBuffer | 支持 | 支持 | 支持 | 支持 | 由 transport 决定 |
| AbortSignal 和超时 | 支持 | 支持 | 支持 | 支持 | 由 transport 决定 |
| 下载进度 | response body 可读时支持 | 支持 | response body 可读时支持 | 支持 | 由 transport 决定 |
| 上传进度 | 标准 Fetch 不保证 | 支持 `xhr.upload` | 标准 Fetch 不保证 | 由 adapter 实现 | 由 transport 决定 |
| HTTP/2 | 浏览器自行协商，客户端不强制 | 浏览器自行协商 | 默认 Fetch 不强制 | `@nexusmc-cn/axnexus/node-http2` | 不适用 |
| HTTP/3 | 浏览器自行协商 | 浏览器自行协商 | 默认不启用 | 不适用 | `@nexusmc-cn/axnexus/node-http3` + QUIC transport |

Node.js HTTP/2 和 HTTP/3 入口不会被默认入口加载。

## 开发

```bash
npm install
npm test
npm run build
npm run test:bun
```

贡献代码时，`npm test` 使用 Node.js 执行测试；`npm run test:bun` 需要本机已安装 Bun。两者都会先生成最新的 `dist/`。仓库 CI 使用 Node.js 22 和 Bun 1.4.2，运行测试需使用支持对应测试命令的运行时。

## 许可证

MIT
