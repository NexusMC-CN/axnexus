# 变更记录

## Unreleased

### 新增

- 依赖管理、构建、测试和 CI 统一使用 pnpm 11.25.0，以 `pnpm-lock.yaml` 固定依赖。
- Standard Schema 输入/输出类型及推导工具；配置 schema 的客户端、完整响应方法和 JSON helpers 自动推导输出并保留空响应的 `null`，响应转换后的结果保守推导为 `unknown`。
- `SchemaValidationError` 和类型守卫，提供结构化 issues 及其 message/path；响应校验失败保留可用的 HTTP 状态及响应上下文，无效 validator 结果明确失败。
- `./stream`：增量 SSE/NDJSON 消费、逐消息 schema 校验、默认 1 MiB 消息限制、空闲超时和取消清理；SSE 可显式启用有次数上限的 GET 重连并携带 Last-Event-ID。
- `./fetch`：专用 Fetch 桥接，接受 transport 配置白名单，保留原始请求/响应与 HTTP 状态，支持 oRPC 等可注入 Fetch 的 SDK，并提供 `close()`。
- `./contracts`：端点 path/query/body/output 契约、按状态和 schema 匹配的业务错误、`bind`、`call` 和按 `kind` 判别的 `safeCall`；输入校验先于网络 I/O，调用预算及取消覆盖校验与网络全程。
- 类型化本地 context、`plugins` / `use()` 插件生命周期、每客户端插件工厂，以及隔离观测异常的请求、attempt、transport、缓存和流结束事件。
- `attachRequestLogger` / `createRequestLoggerPlugin` 自动日志接入，沿用既有脱敏规则，汇总缓存复用、attempt 数量以及排队、重试等待和原始流消费耗时。
- 可选 `./opentelemetry` 插件，使用应用提供的 tracer，不安装 SDK 或默认注入 trace headers；可选 `./tanstack-query` 提供 schema 驱动的 query/infinite/mutation options、显式非敏感分区及取消集成，关闭底层重复缓存和重试。
- Query 新增 `createQueryIntegration(client)` 绑定工厂，在显式指定 mutation 变量类型时保留客户端 context 类型；Query signal 与 `config.signal` 合并，敏感 key 检测复用日志默认名单并识别 URL 编码字段名。

### 修复

- 同一全局运行环境内同版本重复模块实例的 `HttpError` / `SchemaValidationError` 识别，避免丢失错误分类、响应、取消和超时信息，防止非重试错误被归一化为网络错误。

## 0.2.0 · 2026-10-17

### 升级注意

- 默认 `credentials` 从 `include` 改为 `same-origin`。跨源 Cookie 鉴权需要显式设置 `credentials: 'include'`。
- 默认不再生成 `X-Request-Id`。客户端或单次请求设置 `requestId: true` 可开启，同一请求的重试复用同一 ID。
- 使用自动 Cookie 的请求需要设置 `cache.partition`，才能启用客户端缓存和并发去重。登录、退出或切换用户时应改变分区并清理旧缓存；公开请求可使用 `credentials: 'omit'`。
- 显式传入非法 `maxBodySize`、超时或重试配置时抛出 `ERR_INVALID_CONFIG`。`maxBodySize: undefined` 表示不限制，`0` 表示只允许空响应体。
- 自动注入 CSRF token 的请求禁止自动跟随重定向。XHR 无法执行该策略时返回 `ERR_UNSUPPORTED_ADAPTER`，此类请求应使用 Fetch。

### 新增与调整

- `fetchJson` 和 `fetchJsonResult` 新增 `throwHttpErrors` 选项；开启后非 2xx 抛出带状态和响应的 `HttpError`。默认情况下，非 2xx 的 `fetchJson` 返回 `null`，`fetchJsonResult` 返回结果对象且 `data` 为 `null`。
- 请求日志默认脱敏敏感 query 参数，同时处理错误消息和错误配置中的 URL。可通过 `redactQueryParams` 和 `redactError` 扩展脱敏规则。
- CSRF 拦截器新增 `allowedOrigins`，按浏览器同源、客户端 `baseURL` 和显式允许的 origin 控制自动 token 的发送范围。
- 内置 Fetch/XHR 在发送 TRACE、CONNECT 前返回 `ERR_UNSUPPORTED_METHOD`；支持这些方法的自定义 adapter 不受影响。

### 修复

- 缓存按最终 URL、headers 和响应选项隔离，只共享响应字节；解析、schema、转换、响应拦截器、超时与取消分别按调用方执行。
- `totalTimeout` 覆盖首次请求拦截器和请求转换；长超时、退避、限速与分块重试使用分段计时，相对等待不受系统时间回拨影响。
- 拒绝 URL 中的控制字符，防止规范化后绕过绝对地址限制。
- CSRF 重试不再保留已清空的自动 token，不再发送内部标记；后续拦截器替换配置或恢复错误时仍保留来源边界检查。
- 响应大小限制按 adapter 暴露的字节执行，避免压缩长度误拒已解压的小响应；解压后超限仍会终止读取。
- 取消或超时后释放迟到响应，包括缓存共享请求及注入式 HTTP/3 transport 返回的响应流。
- 按每次实际发送的方法失效 GET 缓存；非 2xx、`Cache-Control: no-store` 和 `Vary: *` 响应不保留 TTL 缓存。
- 完善字符串、Blob、二进制及集合的缓存大小估算，二进制视图计入完整底层 buffer；回收响应缓存的失效元数据。
