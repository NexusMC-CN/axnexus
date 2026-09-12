# axnexus 传输增强与模块化设计规格

## 背景与目标

`axnexus` 已经提供了 Axios 风格的实例请求、拦截器、重试、取消、超时、GET 缓存和 CSRF 辅助能力。本规格把后续能力按功能边界拆分，并定义第一阶段的实现契约：

- 提供兼容 AxiosHeaders 思路、但不依赖 Axios 的大小写不敏感请求头对象。
- 提供上传和下载进度事件，上传在浏览器中使用 XHR adapter，下载在 Fetch ReadableStream 可用时逐块报告。
- 提供字节限速、请求速率、并发数、优先级和队列超时，调度器可按客户端、主机或资源组隔离。
- 保留现有 `get/post/...` 返回数据的默认行为，同时增加返回完整响应元数据的 API。
- 让协议、计时和传输 adapter 成为可扩展能力，为后续 Node HTTP/2 和实验性 HTTP/3 做清晰的边界。
- 将代码按 core、headers、transfer、adapters、cache、security、utils 分目录，核心模块不依赖 AVMCBBS。

本规格的第一阶段是可发布的实现范围；HTTP/2 和 HTTP/3 的 adapter 契约列为第二阶段，避免把 Node 专属或实验性模块带入浏览器默认包。

## 范围与非目标

第一阶段包含：

- AxiosHeaders 核心操作、规范化、序列化、合并、迭代和 method shortcut。
- Header method defaults（`common`、`get`、`post`、`put`、`patch`、`delete`、`head`、`options`）的合并规则。
- Fetch adapter、浏览器 XHR adapter、上传/下载进度和 multipart/FormData 辅助。
- 字节速率、请求速率、并发、优先级和队列超时调度。
- 完整 `HttpResponse` API、响应大小限制、协议标识和阶段计时元数据。
- 对应的单元测试、adapter 能力检测、README 和导出入口。

第二阶段包含：

- 基于 Node `node:http2` 的可选 adapter，负责 session 复用、stream 生命周期、取消、超时和 HTTP/2 metadata。
- 注入式 HTTP/3/QUIC adapter 契约；只有调用方提供 QUIC transport 时启用，不在核心包内捆绑实验性运行时。
- HTTP/1.1、HTTP/2、HTTP/3 的协商、回退和协议 metadata 集成测试。

以下内容不在本次范围：

- 不迁移 AVMCBBS 的业务 API、认证 UI、页面跳转、Astro/React 代码或站点配置。
- 不在核心包内实现分片上传协议、断点续传、对象存储签名或服务端专用上传 API。
- 不修改全局 `fetch`、XHR、Agent、HTTP/2 session 或 DNS 配置。
- 不承诺 HTTP/3 在所有 Node 版本可用；调用方必须显式安装/注入对应 transport。

## 公共 API

### AxiosHeaders

`AxiosHeaders` 是大小写不敏感、保留最后一次规范化名称的 header 容器。header 名称统一按 ASCII 小写进行查找，但 `normalize('format')` 和序列化可以输出常见的 Title-Case 名称。

```ts
type HeaderValue = string | string[] | null | false | undefined
type RawHeaders = Record<string, HeaderValue>
type HeaderRewrite = boolean | ((value: HeaderValue, name: string) => boolean)

class AxiosHeaders implements Iterable<[string, HeaderValue]> {
  constructor(headers?: RawHeaders | Headers | AxiosHeaders | string)
  set(name: string, value: HeaderValue, rewrite?: HeaderRewrite): this
  set(headers: RawHeaders | Headers | AxiosHeaders, rewrite?: HeaderRewrite): this
  get(name: string, parser?: RegExp | ((value: string) => unknown)): unknown
  has(name: string, matcher?: RegExp | ((value: string) => boolean)): boolean
  delete(name: string | string[], matcher?: RegExp | ((value: string) => boolean)): boolean
  clear(matcher?: RegExp | ((value: string) => boolean)): boolean
  normalize(format?: boolean): this
  concat(...targets: Array<RawHeaders | Headers | AxiosHeaders>): AxiosHeaders
  toJSON(asStrings?: boolean): Record<string, string | string[]>
  toString(): string
  [Symbol.iterator](): IterableIterator<[string, HeaderValue]>
}
```

实例还提供 `setAccept/getAccept/hasAccept`、`setContentType/getContentType/hasContentType`、`setAuthorization/getAuthorization/hasAuthorization` 等 method shortcut。shortcut 名称来自标准 header 名称，查找和删除仍然大小写不敏感。

控制字符、CR、LF 和非法 header 名称必须在写入或发送前拒绝/清理，禁止通过 header 值形成注入。`undefined` 表示跳过写入，`null` 和 `false` 表示删除或不发送该 header；最终 adapter 只接收可发送的字符串值。

### Method defaults

请求配置的 `headers` 支持以下形状：

```ts
type HeaderDefaults = RawHeaders & {
  common?: RawHeaders
  get?: RawHeaders
  post?: RawHeaders
  put?: RawHeaders
  patch?: RawHeaders
  delete?: RawHeaders
  head?: RawHeaders
  options?: RawHeaders
}
```

合并顺序为客户端默认值、`common`、当前 method 默认值、请求级 header；后者覆盖前者但不会因大小写不同而产生重复键。请求发出前删除 method map 自身，只向 adapter 传递扁平化的 `AxiosHeaders`。

### 进度事件

上传和下载均使用同一个事件形状：

```ts
type TransferPhase = 'upload' | 'download'

interface TransferProgress {
  phase: TransferPhase
  loaded: number
  total?: number
  percent?: number
  rate?: number
  estimated?: number
  startedAt: number
  elapsed: number
}

type ProgressListener = (progress: TransferProgress) => void
```

`RequestConfig` 增加 `onUploadProgress`、`onDownloadProgress` 和 `progressInterval`。事件按字节变化和最小时间间隔节流，结束时发送一次 `loaded === total`（若 total 已知）的最终事件。未知长度不得伪造 `percent` 或 `estimated`。

上传进度只在 XHR adapter 或能观察请求体流的自定义 adapter 中提供；默认 Fetch adapter 在无法读取请求体进度时不报告上传事件。下载进度使用响应体流，若运行环境没有 `ReadableStream` 则退化为一次完成事件。

### 限速和调度

```ts
interface RateLimitOptions {
  bytesPerSecond?: number
  requestsPerInterval?: number
  interval?: number
  maxConcurrent?: number
  priority?: number
  queueTimeout?: number
  resourceGroup?: string
}
```

配置可出现在客户端默认值和请求级 `rateLimit`。调度器先按 `priority` 降序、入队顺序升序选择任务，再应用并发、请求频率和字节令牌桶限制。每个客户端有独立调度状态；设置 `resourceGroup` 时，同一客户端内同组请求共享 bucket 和并发上限，不同 host 默认不共享。

限速等待必须通过可清理的 timer 实现，不使用忙等。外部取消会从队列移除请求并返回 `ERR_CANCELED`；`queueTimeout` 超时返回 `ERR_RATE_LIMIT_QUEUE_TIMEOUT`。上传/下载 byte limit 应在可观测流上执行，调度器不得缓存整个响应或请求体来实现限速。

### 完整响应 API

保留现有便捷方法返回解析后的 data，并新增：

```ts
requestResponse<T = unknown>(config: RequestConfig): Promise<HttpResponse<T>>
getResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>
postResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>
putResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>
patchResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>
deleteResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>
```

`HttpResponse<T>` 增加：

```ts
interface ResponseTimings {
  queuedAt?: number
  startedAt?: number
  headersAt?: number
  completedAt?: number
  duration?: number
  uploadDuration?: number
  downloadDuration?: number
}

type HttpProtocol = 'h1' | 'h2' | 'h3' | 'unknown'

interface HttpResponse<T> {
  data: T
  status: number
  statusText: string
  headers: AxiosHeaders
  config: RequestConfig
  request?: unknown
  protocol: HttpProtocol
  timings: ResponseTimings
}
```

`responseType: 'response'` 与 `requestResponse` 等价。GET 缓存只缓存已解析的 data 结果；完整 `Response` 对象、流和一次性 body 不进入缓存。

## Adapter 契约

现有 `HttpAdapter` 保留 `execute(config): Promise<Response | HttpResponse>` 入口，并允许 adapter 返回协议和计时元数据。第一阶段 adapter：

- `fetch`：默认 adapter，零运行时依赖，支持标准 Fetch、下载流进度和请求取消。
- `xhr`：浏览器显式选择的 adapter，使用 `XMLHttpRequest.upload.onprogress` 提供可靠上传进度，并映射 timeout、abort 和 response headers。

第二阶段 adapter：

- `node-http2`：独立导出路径，使用 Node 稳定的 `node:http2` API；需要处理 session 池、authority、stream reset、GOAWAY、连接错误和优雅关闭。
- `node-http3`：只定义注入式 `QuicTransport` 接口和 capability detection，不直接导入未稳定的 Node QUIC API。没有 transport 时抛出 `ERR_UNSUPPORTED_ADAPTER`。

Node Fetch 仍视为 HTTP/1.1 能力，不把 Fetch 的成功请求误标为 HTTP/2 或 HTTP/3。协议字段只有 adapter 能证明时才标记为 `h2`/`h3`。

## 目录结构

```text
src/
  core/
    client.ts          实例 API、请求生命周期和重试
    pipeline.ts        拦截器、调度器和 adapter 编排
    errors.ts          HttpError 与稳定错误 code
    interceptors.ts    拦截器管理器
    types.ts           配置、响应、adapter 和公共类型
  headers/
    headers.ts         AxiosHeaders 容器
    methods.ts         method shortcut 和 defaults 合并
    presets.ts         可复用安全 header preset
  transfer/
    progress.ts        TransferProgress 计算和节流
    rate-limiter.ts    token bucket、队列和并发调度
    multipart.ts       FormData/multipart 辅助
    chunked.ts         有界并发分块上传编排
  adapters/
    fetch.ts           默认 Fetch adapter
    xhr.ts             浏览器 XHR adapter
    node-http2.ts      第二阶段 Node HTTP/2 adapter
    node-http3.ts      第二阶段注入式 HTTP/3 adapter
    types.ts           adapter 能力和 transport 类型
  cache/
    get-cache.ts       GET TTL 缓存和 inflight 去重
    response-cache.ts  stale-while-revalidate 响应缓存
  server/
    json.ts            SSR/middleware JSON helper
  observability/
    request-logger.ts  请求生命周期记录和 header 脱敏
  security/
    csrf.ts            可选 CSRF interceptor
    header-sanitizer.ts header 名称和值校验
  utils/
    query.ts           params 序列化
    body.ts            请求体编码
    response.ts        响应解析和大小限制
    signal.ts          AbortSignal 组合和清理
  index.ts             稳定公共导出
tests/
  core/
  headers/
  transfer/
  adapters/
  cache/
```

当前包尚未发布，目录迁移不再保留旧根模块的兼容 re-export；稳定公共入口统一由 `index.ts` 提供。内部模块不能反向导入 `index.ts`，避免循环依赖；Node adapter 不能被默认入口静态导入，以保证浏览器 bundler 不解析 Node 内置模块。

## 错误和安全边界

新增稳定错误 code：`ERR_UNSUPPORTED_ADAPTER`、`ERR_RATE_LIMIT_QUEUE_TIMEOUT`、`ERR_MAX_BODY_SIZE`、`ERR_INVALID_HEADER` 和 `ERR_PROTOCOL_NEGOTIATION`。所有错误继续保留现有 `HttpError` 字段、取消语义和 `onRequestError` 观察钩子。

响应大小限制在解析前执行，超过 `maxBodySize` 时停止读取并抛出 `ERR_MAX_BODY_SIZE`。header sanitizer 在 AxiosHeaders 写入、method defaults 合并和 adapter 发送前各保证一次，不能仅依赖浏览器或 Node 的底层校验。

## 测试验收

第一阶段测试至少覆盖：

1. 大小写不敏感查找、rewrite 规则、normalize、concat、toJSON/toString、迭代和 method shortcut。
2. common/method/request header 合并、重复键消除和 CR/LF 注入拒绝。
3. XHR 上传进度、Fetch 下载进度、未知长度、节流和最终事件。
4. token bucket、请求频率、并发、优先级、资源组、队列超时和取消。
5. 完整响应 API、protocol/timings metadata、响应大小限制和 raw Response 不缓存。
6. Fetch/XHR adapter 能力检测与错误映射，默认入口不加载 Node 内置模块。
7. 现有基础请求、重试、缓存、拦截器、CSRF 测试全部保持通过。

第二阶段增加真实 Node HTTP/2 session/stream 测试，以及注入式 HTTP/3 transport 的 capability、回退和错误测试；没有 QUIC transport 的环境只验证明确失败，不伪造协议成功。

验收命令：`npm test`、`npm run build`、`git diff --check`、`npm pack --dry-run`。README 必须包含每个新功能的最小示例、运行环境限制和第二阶段 adapter 的显式启用方式。

## 技术依据

- AxiosHeaders 的操作与 method shortcut 语义参考 [Axios Headers](https://axios.rest/pages/advanced/headers.html) 和 [Header Methods](https://axios.rest/pages/advanced/header-methods.html)。
- Node 的 HTTP/2 adapter 以稳定的 [Node HTTP/2 API](https://nodejs.org/api/http2.html) 为边界。
- Node Fetch 基于 Undici 且默认不提供 HTTP/2/3 协议选择，参考 [Node Globals Fetch](https://nodejs.org/api/globals.html#fetch)；HTTP/3/QUIC 仍属于实验性能力，参考 [Node CLI --experimental-quic](https://nodejs.org/api/cli.html#--experimental-quic)。
