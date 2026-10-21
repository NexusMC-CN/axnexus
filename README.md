# axnexus

一个基于原生 Fetch/XHR 的 TypeScript HTTP 客户端，提供 Axios 风格的实例 API、大小写不敏感 headers、进度捕捉、限速调度、超时取消、重试和 GET 缓存。

## 特性

- 核心零运行时依赖，面向现代浏览器、Node.js 18+ 和提供标准 Web API 的 Bun 运行环境。
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
- Standard Schema 输入/输出类型推导、结构化校验错误，以及 SSE/NDJSON、Fetch 桥接和轻量端点契约。
- 类型化本地 context、客户端插件、自动日志，以及可选 OpenTelemetry 和 TanStack Query 集成。

## 安装

```bash
pnpm add @nexusmc-cn/axnexus
```

包以 ESM 发布，使用 `import` 引入，并内置 TypeScript 类型声明。API 采用实例、拦截器和 `AxiosHeaders` 风格，便捷请求方法默认直接返回解析后的数据。

### 入口导航

| 入口 | 用途 |
| --- | --- |
| `@nexusmc-cn/axnexus` | HTTP 客户端、headers、schema、缓存、上传和日志 |
| `@nexusmc-cn/axnexus/stream` | [SSE/NDJSON 消费与 SSE 重连](#sse-和-ndjson) |
| `@nexusmc-cn/axnexus/fetch` | [为 oRPC 等 SDK 提供 Fetch](#fetch-桥接与-orpc) |
| `@nexusmc-cn/axnexus/contracts` | [端点契约与业务错误](#端点契约) |
| `@nexusmc-cn/axnexus/plugins` | [插件和生命周期事件类型](#context-和插件) |
| `@nexusmc-cn/axnexus/observability` | [请求日志及自动接入](#请求观测) |
| `@nexusmc-cn/axnexus/opentelemetry` | [可选 OpenTelemetry 插件](#opentelemetry) |
| `@nexusmc-cn/axnexus/tanstack-query` | [可选 TanStack Query options](#tanstack-query) |
| `@nexusmc-cn/axnexus/node-http2`、`@nexusmc-cn/axnexus/node-http3` | [Node 传输](#http2-和-http3) |

根入口不加载 Node 传输或可选集成依赖。只在使用 OpenTelemetry、TanStack Query 或 oRPC 时安装相应依赖，见各节说明。

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

默认凭据策略是 `same-origin`，自动添加 `Accept: application/json`，默认不生成 `X-Request-Id`。调用方显式传入同名请求头时会保留调用方的值。客户端或单次请求设置 `requestId: true` 可开启 ID，也可传入工厂函数；同一逻辑请求的重试复用同一 ID。

跨源鉴权需要显式设置 `credentials: 'include'`，服务端须正确配置 CORS 和 `Access-Control-Allow-Credentials`。公开 API 可设置 `credentials: 'omit'`。升级到 `0.2.0` 时，依赖跨源 Cookie 或自动请求 ID 的调用方需要显式开启相应选项；其他兼容性变化见[变更记录](./CHANGELOG.md)。

`trace` 和 `connect` 便捷方法保留给支持相应方法的自定义 adapter。内置 Fetch（包括 Node Fetch）和 XHR 会在发送前抛出 `ERR_UNSUPPORTED_METHOD`，不会把它们当作网络故障重试。

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

`params` 使用 `URLSearchParams` 编码，数组会生成重复的 query key，`null` 和 `undefined` 会被跳过。相对路径会与 `baseURL` 合并；如果不允许绝对 URL，可以设置 `allowAbsoluteURL: false`。URL 和 `baseURL` 中的控制字符会被拒绝，避免 TAB、换行等字符经浏览器规范化后绕过地址策略。

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

### Schema 与类型推导

配置 `schema` 后移除手填的响应 `<T>`，由 schema 的输出推导类型；`get`、`request`、完整响应方法、`fetchJson` 和 `fetchJsonResult` 遵守同一规则。无响应体仍可能得到 `null`，因此推导包含 `null`。未配置 schema 的调用保留原有显式泛型 API。

可以直接使用兼容 Standard Schema v1 的库，也可以手写校验器。`StandardSchema<Output, Input>` 保留输出泛型在前的顺序，`version`、`vendor` 和 `types` 对旧式手写校验器可省略；成功结果必须包含 `value`，失败结果包含 `issues`。

```typescript
import { createHttpClient, fetchJson, type StandardSchema } from '@nexusmc-cn/axnexus';

type User = { id: number; name: string };
const userSchema: StandardSchema<User, User> = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(value) {
      if (typeof value === 'object' && value !== null
        && 'id' in value && typeof value.id === 'number'
        && 'name' in value && typeof value.name === 'string') {
        return { value: { id: value.id, name: value.name } };
      }
      return { issues: [{ message: '需要用户对象' }] };
    },
  },
};

const validatedHttp = createHttpClient({ baseURL: 'https://api.example.com', schema: userSchema });
const user = await validatedHttp.get('/users/me'); // User | null
const response = await validatedHttp.getResponse('/users/me'); // response.data: User | null
const oneOff = await fetchJson('https://api.example.com/users/me', { schema: userSchema }); // User | null
const transformed = await validatedHttp.get('/users/me', {
  transformResponse: (data) => ({ user: data }),
}); // unknown
```

schema 先校验，再执行响应转换。客户端默认或单次请求配置了 `transformResponse` 时，最终结果保守推导为 `unknown`；需要使用转换结果时再缩窄类型。`InferSchemaInput` 和 `InferSchemaOutput` 可用于提取 schema 两端的类型。下文沿用此处的 `userSchema`。

JSON（包括自定义 `parseJson`）解析失败抛出 `ERR_BAD_PAYLOAD`，`transformResponse` 失败抛出 `ERR_TRANSFORM_RESPONSE`。错误状态的 payload 会按文本读取后尝试 JSON 解析，超过 `maxBodySize` 时置为 `null`，原始 HTTP 状态错误仍保留。被丢弃或未读完的响应体会主动取消，以释放连接。

`validateStatus` 或 `throwHttpErrors` 回调自身抛错时返回 `ERR_INVALID_STATUS_POLICY`，并且不会当作可重试的网络错误重发请求。

`maxBodySize` 以字节为单位，仅省略或 `undefined` 表示不限制；显式值必须是非负安全整数，`0` 只允许空体，负数、小数、`NaN`、`Infinity`、`null` 和非数字值抛出 `ERR_INVALID_CONFIG`。可读流按块累计，超限后立即取消底层响应体；没有可读流时只能在运行时缓冲后检查。Fetch 已解压的响应按解压后的实际字节限制，不用压缩 `Content-Length` 误判；原始传输按其暴露的字节限制。HEAD 与 `204`/`205`/`304` 不按声明长度计算。`responseType: 'response'` 保留 `url`、`redirected` 和 `type` 等 metadata。

`timeout`、`totalTimeout` 和重试次数也会校验显式配置；超时必须是非负安全整数，`0` 表示关闭，重试次数必须是非负安全整数。延迟、最大延迟及延迟回调结果必须是有限非负数，且不超过 `Number.MAX_SAFE_INTEGER`。非法配置抛出 `ERR_INVALID_CONFIG`，不按网络错误重试；超过单个 timer 上限的合法等待会分段调度。

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

下表展示未配置 schema 的显式泛型调用；配置 schema 后使用[自动类型推导](#schema-与类型推导)。

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
| `ERR_INVALID_CONFIG` | 显式传入的配置值或 URL 无效 |
| `ERR_INVALID_STATUS_POLICY` | 状态策略回调抛出异常 |
| `ERR_MAX_BODY_SIZE` | 响应体超过 `maxBodySize` |
| `ERR_RATE_LIMIT_QUEUE_TIMEOUT` | 请求在限速队列中超时 |
| `ERR_UNSUPPORTED_ADAPTER` | 当前环境不支持所选 adapter |
| `ERR_UNSUPPORTED_METHOD` | 所选 adapter 不支持该 HTTP 方法 |
| `ERR_PROTOCOL_NEGOTIATION` | transport 无法协商请求的协议 |

响应 schema 校验失败的 `HttpError` 保留可用的 `status` 和 `response`，其 `cause` 为 `SchemaValidationError`，通过只读 `issues` 读取每项的 `message` 和可选 `path`：

```typescript
import { isHttpError, isSchemaValidationError } from '@nexusmc-cn/axnexus';

try {
  await http.get('/users/me', { schema: userSchema });
} catch (error) {
  if (isHttpError(error) && isSchemaValidationError(error.cause)) {
    console.error(error.status, error.cause.issues);
  }
}
```

`isHttpError` / `instanceof HttpError` 和 `isSchemaValidationError` / `instanceof SchemaValidationError` 能识别同一全局运行环境中同版本的重复模块实例，保留错误分类、响应、取消和超时信息；不保证跨版本、跨进程或跨 realm 的识别。普通同名或同形对象不会被当作 axnexus 错误。

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

`timeout` 约束单次 adapter 尝试，包括响应体读取和响应拦截器等待；`totalTimeout` 从进入公开请求方法时开始计时，覆盖首次异步请求拦截器、`transformRequest`、排队、重试判断、退避等待以及所有尝试。总预算由调用时的请求配置或客户端默认值确定，拦截器不会重新启动这份预算。二者超时都会抛出 `ETIMEDOUT`。超时或取消后才返回的 adapter 响应会被主动释放。

超时、退避、限速等待和分块重试使用分段计时，超过运行时 32 位计时器范围的等待不会溢出为立即执行；相对等待使用单调时钟，不受系统时间回拨影响。

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
  credentials: 'omit',
  cache: { ttl: 30_000 },
});

await cachedHttp.get('/catalog');
await cachedHttp.get('/catalog'); // TTL 内复用缓存
await cachedHttp.get('/catalog', { bypassCache: true });

cachedHttp.clearCache();
```

缓存只作用于 GET。请求拦截器执行后按最终 URL、headers、响应类型、凭据及 Fetch 行为选项生成 key，自动生成的请求 ID 除外。缓存保存响应字节快照，每个调用方分别执行解析、schema、转换和响应拦截器；命中缓存也不会跳过这些处理。相同 key 的网络请求可以去重，各调用方的取消、单次超时和总时限独立；全部等待者退出后取消共享传输。

携带潜在自动 Cookie 的请求（包括默认的 `same-origin`）必须指定会话分区，才能进入结果缓存或共享网络请求；公开数据建议使用 `credentials: 'omit'`：

```typescript
await http.get('/me', {
  cache: { ttl: 5_000, partition: `session:${sessionVersion}` },
});
```

分区应在登录、退出或切换用户时改变，并调用 `clearCache()` 释放旧条目；SSR 应创建请求级客户端。显式 Authorization/Cookie 也参与 key。仅设置 `credentials` 字符串不能区分 HttpOnly Cookie 的会话。

`signal`、超时和拦截器本身不会禁用缓存。完整响应接口、raw Response、请求体，以及请求级 `maxBodySize`、上传/下载进度、限速、`dispatcher` 或 `agent` 仍会保守跳过共享。非 2xx、`Cache-Control: no-store` 和 `Vary: *` 响应不保留 TTL 条目；客户端缓存不是完整的浏览器 HTTP cache。

实际发出的非 GET 请求会清空当前实例缓存，包括重试时从 GET 改成 POST 的情况；这些请求即使在响应解析或校验阶段失败，也会清空缓存。缓存保存在内存中，不跨实例或持久化；`GetRequestCache` 默认最多保留 512 条，单条超过约 1 MB 不保留，并提供 `prune()` 主动回收过期条目。字符串、Blob 和二进制值按字节估算，二进制视图按完整底层 buffer 计量；Map/Set 递归估算，无法估算的对象不驻留。失效元数据也会回收。

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

直接使用 `GetRequestCache` 时，`options.signal` 只取消当前调用方的等待；全部等待者退出后，共享 loader 收到的 signal 会取消。`ResponseCache` 本身不提供调用方取消选项，loader 的取消策略由调用方管理。

## SSR 和一次性 JSON 请求

`fetchJson` 是不带客户端实例状态的轻量 JSON helper，适合 SSR、middleware 和一次性请求。它支持显式传入 `cookie`、注入 `fetch` 和 JSON parser；`headers` 接受与主客户端相同的 `HeaderInput`（包括 `AxiosHeaders`），`maxBodySize` 默认不限制响应体。`timeout` 和 `timeoutMs` 都可用，同时提供时以 `timeoutMs` 为准。

它采用原生 Fetch 的凭据策略；浏览器需要跨源凭据时显式传入 `credentials: 'include'`，服务端转发 Cookie 时使用 `cookie`。

```typescript
import { fetchJson } from '@nexusmc-cn/axnexus';

const data = await fetchJson<{ ok: boolean }>('https://api.example.test/health', {
  cookie: request.headers.get('cookie') ?? undefined,
  timeout: 5_000,
});
```

默认非 2xx 返回 `null`，保持原有行为；设置 `throwHttpErrors: true` 后抛出带 status/response 的 `HttpError`。成功的 JSON `null`、`204`、`205`、`HEAD`、`Content-Length: 0`、空字节或只有空白字符的响应仍返回 `null`；304 默认返回 `null`，开启抛错时作为非 2xx 处理。需要状态码和响应元数据时使用 `fetchJsonResult`：

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

## SSE 和 NDJSON

`./stream` 基于未消费的原始 `Response` 增量解码，返回 `AsyncIterable`。`parseSSE` 默认保留字符串 data 和 `event`、`id`、`retry`；`parseNDJSON` 默认逐行解析 JSON，类型为 `unknown`。提供 `schema` 后逐条校验并推导输出；SSE 的 JSON data 还需显式配置 `parseJson: JSON.parse`。

```typescript
import { parseSSE, parseNDJSON, connectSSE } from '@nexusmc-cn/axnexus/stream';

const events = await http.get<Response>('/events', { responseType: 'response' });
for await (const event of parseSSE(events, { idleTimeout: 30_000 })) {
  console.log(event.id, event.data); // data: string
}

const records = await http.get<Response>('/users.ndjson', { responseType: 'response' });
for await (const user of parseNDJSON(records, { schema: userSchema })) {
  console.log(user.name);
}

for await (const event of connectSSE(http, '/user-events', {
  parseJson: JSON.parse,
  schema: userSchema,
  idleTimeout: 30_000,
  reconnect: { maxAttempts: 3, maxDelay: 5_000, retryOnEOF: true },
})) {
  console.log(event.data.name);
}
```

`maxMessageSize` 默认是 `1 MiB`，按 UTF-8 字节限制每条 NDJSON 记录或整个 SSE 帧，包含 SSE 字段及注释，不含换行符；它与整份响应的 `maxBodySize` 独立。`idleTimeout` 限制等待下一个响应块的时间，`0` 或省略表示关闭，不计消费者处理消息的时间。解析、校验失败、`break`、迭代器 `.return()` 或外部 `signal` 取消都会释放 reader；`.return()` 也会中断正在等待的读取或校验。

`connectSSE` 默认只连接一次。重连必须显式开启且仅支持 GET，`maxAttempts` 包含首次连接，延迟受 `maxDelay` 限制；默认不因正常 EOF 重连。重连携带最后有效的 `Last-Event-ID`，空 id 会重置它；HTTP 204 或 `isComplete(event)` 返回 `true` 时结束，完成事件不再输出。服务端仍需处理重放和去重，这不保证恰好一次投递。普通请求重试在连接时关闭；使用该入口的客户端响应拦截器应保留未消费的原始响应。XHR 不适合实时 SSE。

## Fetch 桥接与 oRPC

`./fetch` 的 `createFetchHandler` 创建可注入 SDK 的 Fetch 函数，使用专用客户端，只接受 transport、headers、超时、大小限制、限速和进度配置。它关闭 axnexus 重试和缓存，把 HTTP 状态及原始响应体交给 SDK；不接受 schema、响应转换、客户端插件或拦截器配置。

使用 oRPC 时由应用安装 `@orpc/client`：

```bash
pnpm add @orpc/client
```

```typescript
import { RPCLink } from '@orpc/client/fetch';
import { createFetchHandler } from '@nexusmc-cn/axnexus/fetch';

const transport = createFetchHandler({ timeout: 10_000 });
const link = new RPCLink({ url: 'https://api.example.com/rpc', fetch: transport });
try {
  const result = await link.call(['health'], undefined, { context: {} });
  console.log(result);
} finally {
  await transport.close();
}
```

桥接保留 Request/init 的方法、headers、signal、原始 body 和 `redirect: 'manual'`，不会重复 JSON 编码或预读响应。传输失败仍使用 axnexus 的 `HttpError` 分类。应用结束使用该 transport 后调用 `close()` 释放持久连接等资源。

## 端点契约

`./contracts` 的 `defineEndpoint` 描述 method、相对 path、query/body/output schema 和业务 `errors` map。`{name}` 路径参数按独立片段编码；query/body 接受 schema 的输入类型，网络发送使用校验后的输出。路径或输入校验失败时不产生网络 I/O。

```typescript
import { defineEndpoint } from '@nexusmc-cn/axnexus/contracts';

const updateUser = defineEndpoint({
  method: 'PUT',
  path: '/users/{id}',
  body: userSchema,
  output: userSchema,
  errors: { CONFLICT: { status: 409, schema: userSchema } },
});
const users = updateUser.bind(http);
const input = { params: { id: 1 }, body: { id: 1, name: 'Anna' } };
const saved = await users.call(input, { totalTimeout: 10_000 }); // User
const result = await users.safeCall(input);
if (result.kind === 'success') {
  console.log(result.data.name);
} else if (result.kind === 'domain' && result.error.code === 'CONFLICT') {
  console.log('已存在的用户：', result.error.data.name);
}
```

也可直接调用 `updateUser.call(http, input)` / `safeCall(http, input)`。`call` 失败时抛错；`safeCall` 用 `kind` 区分 `success`、`domain`、`http`、`transport` 和 `unexpected`。仅当状态码与已声明错误 schema 同时匹配时生成带业务 code/data 的 `DomainError`；未声明或错误体不匹配时保留 HTTP 错误。业务 code 与 `HttpErrorCode` 相互独立。

契约自己校验输出，并覆盖客户端默认 schema 和响应转换。调用级或客户端默认 `timeout` / `totalTimeout` 形成覆盖输入校验、网络、输出及业务错误校验的整次调用预算，外部 signal 也覆盖这些阶段。schema 回调应自行停止其内部异步工作；取消会结束调用方等待。绑定前后均保留客户端的 context 类型。

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

### Context 和插件

`createHttpClient<TContext>()` 为配置、拦截器、插件和可选集成保留本地 context 类型。context 不会自动发到服务端、写入日志或进入缓存键；影响响应的租户、语言或身份仍需显式映射到请求和缓存分区。

```typescript
import { createHttpClient, type HttpPlugin } from '@nexusmc-cn/axnexus';

type Context = { tenant: string };
const observer: HttpPlugin<Context> = {
  create() {
    let completed = 0;
    return {
      setup: () => () => { completed = 0; },
      onEvent(event) {
        if (event.phase === 'request:end') completed += 1;
      },
    };
  },
};
const scopedHttp = createHttpClient<Context>({ plugins: [observer] });
await scopedHttp.get('/items', { context: { tenant: 'public' } });
const detach = scopedHttp.use(observer);
await detach();
await scopedHttp.close();
```

`plugins` 按配置顺序注册，`use()` 返回可重复调用的异步卸载函数。`setup(client)` 同步执行一次，可注册拦截器并返回清理函数；`close()` 卸载插件并释放 adapter 资源。复用有状态插件定义时用 `create()` 创建每客户端独立状态。

`onEvent` 用于记录事件，返回值不会替换请求结果；同步异常和异步拒绝与请求结果隔离，请求不会等待观测任务完成。事件中的 config/context 保留引用，修改请求应使用 `setup` 注册拦截器。事件区分逻辑请求、attempt、transport、缓存命中/去重，以及 `queue`、`retry`、`body` 的开始和结束。结束事件的 `duration` 单位为毫秒；retry 包含 `beforeRetry` 和等待时间，其 `attempt` 是即将执行的重试序号，从 1 开始。原始流的最终请求事件在 EOF、读取失败或取消时产生。

### 自动日志

已有 logger 可自动绑定到客户端生命周期：

```typescript
import { createRequestLogger, attachRequestLogger, createRequestLoggerPlugin } from '@nexusmc-cn/axnexus';

const autoLogger = createRequestLogger((record) => console.info(record));
const detachLogger = attachRequestLogger(http, autoLogger);
// 或在创建时配置 plugins: [createRequestLoggerPlugin(autoLogger)]
await http.get('/health');
await detachLogger();
```

自动日志为每个逻辑请求记录一次开始与结束，沿用下述脱敏规则；结束记录汇总排队、重试等待和原始流消费耗时，以及尝试次数和缓存复用方式。原始流在消费结束后才结束日志。单独使用 logger 仍可手动记录：

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
| `timings` | 自动日志累计的 `queue`、`retry` 毫秒数；原始响应体结束时包含 `body`，从响应交还给消费者起计时 |
| `attempts` / `cache` | 自动日志的 attempt 数量，以及发生缓存复用时的 `hit` 或 `dedupe`；attempt 不等同于实际网络请求次数 |
| `responseBytes` | 可选的响应字节数 |
| `error` | 错误摘要，裁剪任意附加字段并脱敏 `HttpError.config.headers` |

`start()` 返回的句柄只结束自己的生命周期，且只记录一次；顶层 `logger.complete()` 和 `logger.error()` 是 `record()` 的快捷方式，不会结束已有句柄。`redactHeaders` 可追加敏感 header；URL、错误消息和 `HttpError.config.url` 默认过滤 token、access_token、key、api_key、secret、password、signature 等敏感 query，支持编码和重复参数，普通参数保留。使用 `redactQueryParams: ['ticket']` 追加字段，或通过 `redactError: (sanitizedError) => ...` 处理业务错误中的其他敏感内容。

### OpenTelemetry

只有使用 `./opentelemetry` 时才需安装 `@opentelemetry/api`；应用负责配置 SDK/provider/exporter，并传入自己的 tracer。插件不会安装全局 provider，也不默认注入 trace headers。

```bash
pnpm add @opentelemetry/api
```

```typescript
import { trace } from '@opentelemetry/api';
import { createOpenTelemetryPlugin } from '@nexusmc-cn/axnexus/opentelemetry';

const detachTelemetry = http.use(createOpenTelemetryPlugin({
  tracer: trace.getTracer('my-app'),
}));
await http.get('/health');
await detachTelemetry();
```

插件按逻辑请求和 attempt 建立 span，记录缓存、transport、排队、重试等待和流消费事件，结束事件用 `axnexus.duration_ms` 记录毫秒耗时；默认只记录方法、状态、耗时及错误分类，不写入请求 URL、headers、payload 或 context。

## TanStack Query

`./tanstack-query` 提供 `createQueryOptions`、`createInfiniteQueryOptions` 和 `createMutationOptions`，保留 schema 输出及客户端 context 类型。也可用 `createQueryIntegration(client)` 绑定客户端，调用 `.query(input)`、`.mutation<S, Variables>(input)` 和 `.infiniteQuery<Page, S>(input)`。使用时由应用安装 Query v5 的 `@tanstack/query-core`，也可把返回的 options 交给对应框架的 Query 适配层。

```bash
pnpm add @tanstack/query-core
```

```typescript
import { QueryClient } from '@tanstack/query-core';
import { createQueryOptions, createQueryIntegration } from '@nexusmc-cn/axnexus/tanstack-query';

const queryClient = new QueryClient();
const queries = createQueryIntegration(http);
const options = createQueryOptions(http, {
  url: '/users/me',
  partition: ['session', 42, 'zh-CN'],
  schema: userSchema,
});
const user = await queryClient.fetchQuery({ ...options, retry: 2 }); // User | null
const mutation = queries.mutation<typeof userSchema, { name: string }>({
  url: '/users',
  schema: userSchema,
});
const created = await mutation.mutationFn({ name: 'Anna' }); // User | null
```

Query 管理缓存、重试和失效；这些 options 默认 `retry: false`，需要重试时在 Query 层显式配置。底层 axnexus 请求始终关闭重试和 GET 缓存，且由该次配置的 schema 负责输出校验。query/infinite 合并 Query 的取消 signal 与 `config.signal`，任一取消都会传递到底层；mutation 也保留 `config.signal`。

mutation 的变量类型可用第二个泛型指定，响应由 schema 推导；自动重试仍需应用保证幂等。客户端带类型化 context 且需要显式指定 Variables 时，使用上述绑定工厂，避免 TypeScript 无法只推导剩余泛型而丢失客户端 context 类型；独立工厂仍适合完整推导的调用。

query/infinite 的 `partition` 必填，使用非敏感的会话版本、租户和语言标识，身份变化时切换分区。默认 key 包含 URL 与普通 query 参数；普通 query 和 infinite query 使用不同命名空间。含凭据的 URL/params 需要显式提供非敏感 `key`，不要把 token、Cookie、Authorization 或密码放入 key。敏感字段检测沿用 logger 的默认名单，URL 中编码后的字段名也会识别；自定义敏感字段仍需调用方主动避开。显式 key 会替代 URL/params 部分，调用方须完整包含影响响应的筛选、排序、分页大小及其他分区条件。

`createInfiniteQueryOptions` 另需 `initialPageParam`、`params(pageParam)` 和 `getNextPageParam`；其 key 不会自动展开参数函数，调用方须用显式 `key` 区分固定筛选和分页策略。每页结果同样按 schema 推导并包含可能的 `null`。

## CSRF

CSRF 不会默认启用。使用 `createCsrfInterceptor` 注入 token reader：

```typescript
import { createCsrfInterceptor } from '@nexusmc-cn/axnexus';

const csrf = createCsrfInterceptor({
  readToken: () => getCsrfTokenFromYourStore(),
});

http.interceptors.request.use(csrf);
```

默认只处理 `POST`、`PUT`、`PATCH` 和 `DELETE`，信任浏览器同源及客户端 `baseURL` 的 origin；合法跨源 API 使用 `allowedOrigins: ['https://api.example.com']` 显式允许。最终发送前会再次检查目标地址，后续拦截器改写外站 URL 时会移除自动注入的 token；`credentials: 'omit'` 不控制显式 header，因此不能代替 origin 校验。

自动 token 的来源保存在私有元数据中，不发送内部标记；reader 清空后重试会移除旧 token。显式设置的 header 优先，调用方负责其发送范围。自动 token 请求禁止自动跟随重定向（`redirect: 'error'`，显式 `manual` 保留）；XHR 无法控制重定向，因此拒绝这种请求并返回 `ERR_UNSUPPORTED_ADAPTER`，应使用 Fetch。自定义 adapter 应遵守 `redirect` 配置。

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

## 许可证

MIT
