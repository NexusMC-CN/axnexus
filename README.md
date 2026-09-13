# axnexus

一个基于原生 Fetch/XHR 的 TypeScript HTTP 客户端，提供 Axios 风格的实例 API、大小写不敏感 headers、进度捕捉、限速调度、超时取消、重试和 GET 缓存。

## 特性

- 零运行时依赖，支持现代浏览器和 Node.js 18+。
- 提供 `get`、`head`、`options`、`trace`、`connect`、`post`、`put`、`patch`、`delete` 和通用 `request` 方法。
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

`include` 会让浏览器跨源请求主动携带凭据，服务端必须正确配置 CORS 和 `Access-Control-Allow-Credentials`；需要原生 Fetch 的 `same-origin` 行为时请显式传入 `credentials`。

## Headers

```typescript
import { AxiosHeaders } from 'axnexus';

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

客户端缓存使用 `cache: { ttl }` 或 `cache: false`；如果需要把原生 Fetch 的缓存模式传给 adapter，请使用 `fetchCache`（或等价的 `requestCache`），例如 `fetchCache: 'no-store'`。Node Fetch 的 `dispatcher`/`agent`、标准 `priority`、`window` 和 `duplex` 也会按运行环境透传。

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

`timeout` 限制单次 adapter 尝试（也覆盖该次响应体读取），`totalTimeout` 从进入限速队列前开始计时，覆盖排队、响应体读取、重试等待和所有尝试。单次 `timeout` 与外部取消同时发生时，以先触发者为准；外部 `AbortSignal` 在总超时触发前取消时返回 `ERR_CANCELED`，总超时计时器已经触发时统一返回 `ETIMEDOUT`。带 `signal`、`timeout` 或 `totalTimeout` 的请求不会进入客户端 data cache，因此每个调用方的取消和截止时间都独立生效。

响应处理规则是固定的：`204`、`Content-Length: 0`、空字节以及只有空白字符的文本都返回 `null`；`responseType: 'text'` 保留非空文本原样，`blob` 和 `arrayBuffer` 返回对应二进制值。JSON（包括自定义 `parseJson`）解析失败会抛出 `ERR_BAD_PAYLOAD`，`transformResponse` 失败会抛出 `ERR_TRANSFORM_RESPONSE`，不会伪装成网络错误。错误状态的 payload 使用文本读取后尝试 JSON 解析，超过 `maxBodySize` 时 payload 置为 `null`，HTTP 错误本身仍保留状态码。

`maxBodySize` 会先检查响应的 `Content-Length`；可读流按块累计，超过上限会立即停止读取并取消 reader；没有可读流的响应只能在运行时完成缓冲后检查大小。`transformRequest` 和 `stringifyJson` 可用于接入自定义序列化协议，任一请求转换或序列化钩子失败都会抛出 `ERR_TRANSFORM_REQUEST`。

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

`RateLimiter` 也可以单独使用。限速等待可被 `AbortSignal` 取消；队列超时会抛出 `ERR_RATE_LIMIT_QUEUE_TIMEOUT`。默认 Fetch adapter 不伪造上传进度，因为标准 Fetch 没有跨环境一致的请求体进度事件；XHR 的原生进度事件可用于上传/下载进度，但浏览器 XHR 不提供可靠的字节级发送节流，因此 `bytesPerSecond` 只在 Fetch、Node HTTP/2 和由 transport 实现的 HTTP/3 路径上作用于传输过程。

## 完整响应

便捷方法默认只返回 `data`，需要状态码、headers、协议和 timings 时使用 response 方法：

```typescript
const response = await http.getResponse<{ id: string }>('/users/me');
console.log(response.data, response.status, response.protocol, response.timings.duration);
```

可用方法为 `requestResponse`、`getResponse`、`headResponse`、`optionsResponse`、`traceResponse`、`connectResponse`、`postResponse`、`putResponse`、`patchResponse` 和 `deleteResponse`。完整响应不会进入 GET data cache；`responseType: 'response'` 在普通方法中仍返回原始 `Response`。

### API 签名速查

| API | 签名 |
| --- | --- |
| 创建实例 | `createHttpClient(config?: HttpClientConfig): HttpClient` |
| 通用请求 | `request<T>(config)` 或 `request<T>(url, config?): Promise<T>` |
| 完整响应 | `requestResponse<T>(config: RequestConfig): Promise<HttpResponse<T>>` |
| 便捷方法 | `get/head/options/trace/connect<T>(url, config?)`、`delete<T>(url, config?)` |
| 带请求体方法 | `post<T, B>(url, data?, config?)`、`put<T, B>(...)`、`patch<T, B>(...)` |
| 完整响应便捷方法 | `getResponse`、`headResponse`、`optionsResponse`、`traceResponse`、`connectResponse`、`postResponse`、`putResponse`、`patchResponse`、`deleteResponse` |

完整字段类型以包导出的 `RequestConfig`、`HttpClientConfig`、`HttpResponse` 和 `HttpError` 为准；`dist/*.d.ts` 会随构建产物发布。

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
| `ERR_TRANSFORM_REQUEST` | 请求转换钩子抛出异常 |
| `ERR_TRANSFORM_RESPONSE` | 响应转换钩子抛出异常 |
| `ERR_INVALID_HEADER` | header 名称或值包含非法字符 |
| `ERR_MAX_BODY_SIZE` | 响应体超过 `maxBodySize` |
| `ERR_RATE_LIMIT_QUEUE_TIMEOUT` | 请求在限速队列中超时 |
| `ERR_UNSUPPORTED_ADAPTER` | 当前环境不支持所选 adapter |
| `ERR_PROTOCOL_NEGOTIATION` | transport 无法协商请求的协议 |

## 行为契约

本节把几个容易被不同 adapter 或调用方式混淆的边界写成固定规则。它与导出的类型和测试一起构成公共 API 契约；业务项目不应依赖未列出的 adapter 私有细节。

### 取消、超时与重试

- `signal` 由调用方创建并传入请求配置。外部取消会返回 `ERR_CANCELED`，单次 `timeout` 会返回 `ETIMEDOUT`；同一请求中外部取消先发生时，取消优先于单次超时。
- `timeout` 约束一次 adapter 尝试，包括响应体读取和响应拦截器等待；`totalTimeout` 还覆盖限速排队、重试判断、退避等待以及后续尝试。
- 取消会尽早停止拦截器、`parseJson`/转换器、排队和 adapter 工作。adapter 已经把数据交给底层传输后，能否立刻停止仍取决于该 adapter 是否遵守 signal。
- 重试策略使用本轮实际发送的 method/body 配置；错误对象里的 `error.config` 只用于诊断，不能作为是否可重试的依据。不可重放的 `ReadableStream` body 始终不自动重试。

### `fetchJson` 的状态与解析

运行时 schema 校验不绑定具体库；需要时可在 `transformResponse` 中接入 Zod、Valibot 或 Standard Schema。

`fetchJson` 遵循 Fetch 的状态语义，不会因为非 2xx 自动抛错：非 2xx、`204`、`Content-Length: 0`、空字节或只有空白字符的响应都返回 `null`。需要同时取得状态码和原始 `Response` 时使用 `fetchJsonResult`；它会返回 `{ data, status, response }`。

成功状态的非空响应会交给 `parseJson`（默认 `JSON.parse`）。解析器抛错会转换为 `HttpError`，错误码为 `ERR_BAD_PAYLOAD`；`fetchJson` 的超时或外部 signal 取消仍按原生 `AbortError` 传播，不会转换成客户端请求使用的 `ETIMEDOUT` 或 `ERR_CANCELED`。`timeout` 和兼容 AVMCBBS 的 `timeoutMs` 都可用，二者同时提供时以 `timeoutMs` 为准。

```typescript
const result = await fetchJsonResult('/health', { timeout: 5_000 });
if (result.status >= 400) {
  // 非 2xx 不会自动抛错，状态码和原始 Response 仍在 result 中
  console.warn('upstream status:', result.status);
}
```

### 两层缓存与 clone

客户端上的 `cache: { ttl }` 只提供 GET TTL 和进行中请求去重；独立的 `ResponseCache` 才提供 `staleWhileRevalidate`、`staleIfError` 和容量控制。两者不会共享条目，也不会把客户端的 signal、超时或进度事件吞进另一个调用方。

```typescript
const cache = new ResponseCache<{ items: string[] }>({ maxEntries: 128 });

const value = await cache.getOrLoad('catalog', loadCatalog, {
  ttl: 30_000,
  staleWhileRevalidate: 120_000,
  staleIfError: true,
});
```

`ResponseCache` 当前的容量选项名是 `maxEntries`，表示最多保留的条目数，不是按字节计算的 `maxSize`；当前也没有公开的 `clone` 开关。写入和读取都会优先使用 `structuredClone`，再回退到 JSON clone；JSON fallback 可能丢失 `Date`、`Map` 等类型信息，两者都不支持的值会按原引用返回，因此缓存值仍应视为不可变数据。`maxEntries` 默认是 `256`。

客户端 GET cache 的 key 使用最终 URL、method、响应类型、Fetch 行为选项和全部规范化请求头；只有客户端自动生成的 `X-Request-Id` 会被排除，调用方显式提供的同名 header 会参与区分。带 `signal`、`timeout`、`totalTimeout`、进度、限速或自定义解析/转换策略的请求会跳过这层 cache，所以它们不会加入另一个调用方的 in-flight 请求；直接使用 `GetRequestCache` 时，调用方的 `options.signal` 只取消自己的等待，不会取消共享 loader。`responseType: 'response'` 和完整响应方法也不进入 data cache。

### `maxBodySize`

`maxBodySize` 默认值是 `undefined`，表示不限制响应体大小；负数、`NaN` 和 `Infinity` 也按“不限制”处理。若响应声明了有效的 `Content-Length`，会在读取前先检查；可读流会逐块累计，超过上限立即停止读取、取消 reader 并抛出 `ERR_MAX_BODY_SIZE`；没有可读流的响应只能在完成缓冲后检查。错误响应的 payload 读取超过上限时会置为 `null`，不会覆盖原始 HTTP 状态错误。

### `uploadChunks` 的 signal、重试与进度

`uploadChunks` 的 `options.signal` 是编排器级 signal，同一个 signal 会放到每个 `ChunkUploadPart.signal` 上。上传回调必须主动把它交给底层请求，编排器才能取消已经在途的网络操作：

```typescript
const controller = new AbortController();

const pending = uploadChunks(bytes, {
  chunkSize: 5 * 1024 * 1024,
  concurrency: 3,
  signal: controller.signal,
  retry: 2,
  upload: ({ index, body, signal }) => putPart(index, body, { signal }),
});

// 在用户取消动作中调用：停止尚未开始的分片、重试等待和遵守 signal 的在途上传
controller.abort();
const parts = await pending;
```

取消会阻止新分片和下一次重试，并让编排 Promise 尽快 reject；即使上传回调不响应 signal，编排器也不会继续等待它，但底层网络操作仍只能由回调自行取消。上传回调已经 resolve 后若 signal 已取消，该分片不会再写入结果或触发成功进度。`onProgress` 只统计成功分片，空 source 不产生进度事件；已成功的分片不会自动回滚，服务端清理和合并由上传协议负责。`retry` 只针对当前失败分片，重试会复用同一个 `body`，上传回调不应修改它；`part.end` 是 end-exclusive。`chunkSize` 和 `concurrency` 会向下取整为正整数，非有限或非正值回退为 `1`；`retryDelay` 的非有限或负值会回退为 `0`；需要严格参数校验时应在调用前自行完成。`onPartError`、`retryDelay` 或 `onProgress` 抛出的异常会使整体 Promise reject，但已经开始的其他上传不会被自动回滚。

### 请求日志 record

`createRequestLogger` 的 `RequestLogInput` 字段如下，未列出的字段不会由 logger 自动推断；`logger.record(input)` 是统一入口，会规范化 method、headers 并脱敏 error：

| 字段 | 说明 |
| --- | --- |
| `phase` | `start`、`complete` 或 `error` |
| `method` / `url` | 请求身份；`start` 会把 method 规范化为大写 |
| `headers` | 规范化后的 header；默认脱敏 `authorization`、`cookie`、`set-cookie` |
| `status` | 完成或错误时可选的 HTTP 状态码 |
| `duration` | 生命周期句柄自动计算的毫秒数，也可在完成时显式提供 |
| `responseBytes` | 可选的响应字节数 |
| `error` | 错误摘要；`HttpError.config.headers` 和普通错误的任意附加字段都会被安全裁剪 |

`start()` 返回的一次性句柄只结束它自己对应的生命周期；顶层 `logger.complete()` 和 `logger.error()` 是 `record()` 的 phase 快捷方式，不会结束任何 `start()` 句柄，三者的 `headers` 都接受 `HeaderInput`。`redactHeaders` 是在内置敏感字段之上追加的 header 名称。

### HTTP/2 session 与 stream

Node HTTP/2 adapter 按 origin 复用 session，但每个请求仍有独立 stream。单个 stream 的错误、abort、请求取消或超时只关闭该 stream；正常情况下不会因为一个请求失败而主动关闭共享 session。session 自身发生 `error` 或 `close` 时会广播网络错误结束该 session 上的活动 stream，并从复用表移除，后续请求会建立新 session；调用方仍应分别处理每个请求的错误。

Node HTTP/2 的 `ReadableStream` 请求体在读取期间会响应取消；这类不可重放请求不会自动重试。HTTP/3 不共享这套 session，实现细节由注入的 QUIC transport 负责。

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

外部取消会抛出 `ERR_CANCELED`，并会尽早结束仍在等待的请求拦截器、请求转换器、限速排队、adapter、响应体读取和响应拦截器；超时会抛出 `ETIMEDOUT`。取消请求不会自动重试。

## 重试

默认重试状态码是 `408`、`429`、`500`、`502`、`503` 和 `504`。GET、HEAD、OPTIONS、TRACE 等幂等方法可以按状态自动重试；POST、PUT、PATCH、DELETE 默认不按状态重试。

```typescript
const created = await http.post('/jobs', payload, {
  retry: 2,
  retryDelay: (attempt) => attempt * 500,
  retryUnsafeMethods: true,
});
```

网络错误和单次超时会遵循同一套重试次数配置，取消不会重试。请求级 `retry` 对象会继承客户端级对象，只有显式提供的字段会覆盖默认值；请求级数字只覆盖 `limit`，不会丢弃客户端的状态码、方法和退避设置。退避优先级为请求级 `retryDelay`、客户端级 `retryDelay`、`retry.delay`，数字延迟按第几个重试尝试线性累加，函数参数 `attempt` 从 `1` 开始；`shouldRetry` 和 `beforeRetry` 收到的 `RetryContext.delay` 是应用 `Retry-After`、`maxDelay` 和抖动后的最终值。`validateStatus` 优先于 `throwHttpErrors`；被 `validateStatus` 接受或被 `throwHttpErrors: false` 接受的状态不会生成 `ERR_BAD_RESPONSE`，也不会触发状态重试。

状态码策略的优先级是请求级 `retryOn`、请求级 `retry.statusCodes`、客户端级 `retryOn`、客户端级 `retry.statusCodes`，最后才是内置默认值；建议同一层只使用一种写法。默认 `respectRetryAfter: true`：有效的 `Retry-After` 会覆盖本地退避，之后 `maxDelay` 仍是最终上限，抖动也不会突破它；设为 `false` 才会忽略服务端退避。`retry.errorCodes` 是非 HTTP 错误的显式白名单，会覆盖该错误默认的 `retryable: false`，但取消和不可重放的 `ReadableStream` 始终不会重试。

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

默认仍只对幂等方法按状态码重试；`methods` 可以显式放开方法范围，`shouldRetry` 可以接管应用错误的判断，但外部取消和不可重放的 `ReadableStream` 请求体始终不会重试。

不可重放流的限制优先于自定义 `shouldRetry`，即使回调返回 `true` 也不会强行重试一次性 `ReadableStream`。

## 拦截器

```typescript
import { AxiosHeaders } from 'axnexus';

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

缓存只作用于 GET。请求 key 包含 method、最终 URL、规范化请求头（自动生成的 `X-Request-Id` 除外）、`responseType` 以及 `credentials`、`mode`、`redirect`、`referrer`、`referrerPolicy`、`integrity` 和 `keepalive` 等 Fetch 行为选项；因此不同响应类型不会互相污染。相同 key 的进行中请求会共享一次 adapter 调用，但带 `signal`、`timeout`、`totalTimeout`、`maxBodySize`、`onDownloadProgress`、`rateLimit`、自定义 `parseJson`、`transformResponse`、`validateStatus` 或 `throwHttpErrors` 的请求会主动跳过客户端 data cache，以保证调用方的截止时间、响应边界、进度事件和状态策略不被共享请求吞掉；注册了请求或响应拦截器的实例也会跳过该缓存，因为拦截器可能在重试时改变 URL、请求头或请求体。成功的非 GET 请求会清空当前实例缓存。缓存保存在内存中，不跨实例或持久化。

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

`fetchJson` 是不带客户端实例状态的轻量 JSON helper，适合 SSR、middleware 和一次性请求，会转发显式 `cookie`、处理空响应并允许注入 `fetch` 和 JSON parser；它的 `headers` 接受与主客户端相同的 `HeaderInput`（包括 `AxiosHeaders`），`maxBodySize` 默认不限制响应体；`timeout` 与 AVMCBBS 原实现的 `timeoutMs` 都可用：

`fetchJson` 不创建客户端实例，因此不会继承 `createHttpClient` 的 `credentials: 'include'` 默认值；需要跨源凭据时请显式传入 `credentials: 'include'` 或 `cookie`。

```typescript
import { fetchJson } from 'axnexus';

const data = await fetchJson<{ ok: boolean }>('https://api.example.test/health', {
  cookie: request.headers.get('cookie') ?? undefined,
  timeout: 5_000,
});
```

客户端内置的 `GetRequestCache` 只负责 GET TTL 和进行中请求去重；独立的 `ResponseCache` 才提供 `staleWhileRevalidate`、`staleIfError`、容量上限和 clone 策略。两者不是同一层实现，不能通过 `client.cache` 直接启用 stale 行为；需要 stale 策略时请显式使用 `ResponseCache`。

## 分块上传

`uploadChunks` 只负责编排分块、并发和聚合进度，实际上传由调用方提供，因此可以复用 AVMCBBS 现有的 multipart、对象存储或分片协议：

```typescript
import { uploadChunks } from 'axnexus';

const parts = await uploadChunks(bytes, {
  chunkSize: 5 * 1024 * 1024,
  concurrency: 3,
  retry: 2, // 每个分片额外尝试 2 次
  retryDelay: (attempt) => attempt * 200,
  onPartError: ({ part, attempt, error }) => reportPartFailure(part.index, attempt, error),
  onProgress: (loaded, total) => console.log(loaded / total),
  upload: ({ index, body }) => putPart(index, body),
});
```

`retry` 只作用于失败的分片，不会重新上传已经成功的分片；`onPartError` 会收到每次失败（包括最终失败）以及同一个编排 `signal`。某个分片最终失败时整体 Promise reject，并停止调度新的分片；已在途的上传只有在 `upload` 回调把 `part.signal` 传给底层请求并遵守它时才会停止。成功分片不会自动回滚，清理、断点续传和服务端合并由上传协议负责；上传回调应按分片 ID 保证幂等。

## 请求观测

`createRequestLogger` 将请求开始、完成和错误统一成可注入的记录格式，并默认脱敏 `authorization`、`cookie` 和 `set-cookie`。`record`、`start`、`complete` 和 `error` 都遵守同一套输入与脱敏规则；`start` 返回一次性生命周期句柄，句柄会用 `options.now`（默认 `Date.now`）计算耗时：

```typescript
import { createRequestLogger } from 'axnexus';

const logger = createRequestLogger((record) => telemetry.emit(record));
const span = logger.start({ method: 'GET', url, headers });
try {
  const response = await http.getResponse(url);
  span.complete({ status: response.status, responseBytes: Number(response.headers.get('content-length')) || undefined });
} catch (error) {
  span.error({ error });
}
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

const nodeHttp = createHttpClient({
  baseURL: 'https://api.example.com',
  adapter: nodeHttp2Adapter,
});
const response = await nodeHttp.getResponse('/health');
console.log(response.protocol); // h2
```

HTTP/3 不绑定具体 QUIC 实现，调用方提供 `QuicTransport` 后从 `axnexus/node-http3` 创建 adapter：

```typescript
import { createHttp3Adapter } from 'axnexus/node-http3';

const http3 = createHttpClient({ adapter: createHttp3Adapter(myQuicTransport) });
```

没有注入 transport 时会抛出 `ERR_UNSUPPORTED_ADAPTER`。默认入口不会加载 Node 内置模块，也不会把 HTTP/1.1 Fetch 请求误标为 HTTP/2 或 HTTP/3。Node HTTP/2 的 `ReadableStream` 请求体会在读取期间响应取消；不可重放的流请求不会自动重试。

## 运行环境差异

| 能力 | 浏览器 Fetch | 浏览器 XHR | Node.js 18+ Fetch | Node.js HTTP/2 | 注入式 HTTP/3 |
| --- | --- | --- | --- | --- | --- |
| JSON、文本、Blob、ArrayBuffer | 支持 | 支持 | 支持 | 支持 | 由 transport 决定 |
| AbortSignal 和超时 | 支持 | 支持 | 支持 | 支持 | 由 transport 决定 |
| 下载进度 | response body 可读时支持 | 支持 | response body 可读时支持 | 支持 | 由 transport 决定 |
| 上传进度 | 标准 Fetch 不保证 | 支持 `xhr.upload` | 标准 Fetch 不保证 | 由 adapter 实现 | 由 transport 决定 |
| HTTP/2 | 浏览器自行协商，客户端不强制 | 浏览器自行协商 | 默认 Fetch 不强制 | `axnexus/node-http2` | 不适用 |
| HTTP/3 | 浏览器自行协商 | 浏览器自行协商 | 默认不启用 | 不适用 | `axnexus/node-http3` + QUIC transport |

Node.js HTTP/2 和 HTTP/3 入口不会被默认入口加载。

## 与 Axios 的边界

| 能力 | axnexus | Axios |
| --- | --- | --- |
| 默认传输 | 原生 Fetch，浏览器可切换 XHR | 浏览器 XHR、Node.js adapter |
| 超时 | `timeout`（单次）+ `totalTimeout`（排队、重试和读取总计） | 主要是单请求 timeout |
| 重试 | 结构化策略、状态码、错误码、退避、抖动和 `Retry-After` | 需额外配置或插件 |
| 进度与限速 | Fetch/XHR 进度、资源组并发和字节 token bucket | 进度支持，限速通常由调用方实现 |
| 缓存 | 可选 GET TTL、inflight 去重，另有 `ResponseCache` | 默认不提供同层 GET 缓存 |
| HTTP/2 / HTTP/3 | 独立入口和可注入 transport | 依赖 Node adapter 或外部实现 |
| Headers | `AxiosHeaders` 与原生 `Headers` 明确转换 | `AxiosHeaders` 由 Axios 自身管理 |

这张表只比较本包已经实现并有测试覆盖的行为，不承诺替代 Axios 的业务生态或所有 adapter。

## 模块结构

```text
src/
  core/
    client.ts       实例工厂和公共方法适配
    pipeline.ts     请求生命周期、调度、重试和最终错误归一化
    attempt.ts      单次 adapter 调用、响应读取和响应拦截器
    config.ts       配置合并、URL、请求体和转换器
    control.ts      AbortSignal 组合、可取消竞态和延迟
    retry.ts        重试判定、退避、抖动和 Retry-After
    cache-policy.ts 缓存 key 和缓存资格判断
    errors.ts       HttpError 和共享错误归一化
    interceptors.ts 拦截器管理器与执行链
    types.ts        客户端配置、响应和 adapter 类型
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
