# HTTP Client 深度拆分设计

## 目标

在不改变 `axnexus` 公开 API、错误码、请求顺序和 adapter 契约的前提下，将过度集中的 `src/core/client.ts` 拆分为职责明确的内部模块。重构后 `client.ts` 只负责实例工厂和公共方法适配，业务行为由可独立测试的配置、控制、尝试执行、重试、响应和缓存模块承担。

## 范围与非目标

本次范围只包含 HTTP 客户端内部结构重组、必要的内部类型和回归测试。保留 `src/index.ts` 的导出路径、`HttpClient`/`RequestConfig` 等公开类型、`HttpError` 错误码、缓存语义、限速语义、重试规则以及 Fetch/XHR/HTTP2/HTTP3 adapter 接口。

本次不新增 Web API 封装，不实现原生 QUIC/HTTP3 transport，不修改 AVMCBBS 的依赖接入，也不恢复旧路径兼容层。内部新文件不是公开入口，避免形成新的兼容承诺。

## 模块边界

### `src/core/client.ts`

负责创建默认配置、实例化请求/响应拦截器、缓存和限速器，并将公共方法（`request`、`get`、`post` 等）转换为统一的内部请求输入。它不再直接实现重试循环、响应读取或错误策略。

### `src/core/config.ts`

负责方法级 header 合并、默认值和请求值合并、请求 ID、URL/查询参数、请求转换器、请求体编码，以及重试/超时/限速配置的归一化。输出唯一的 `ResolvedRequestConfig`，避免执行层重复推导配置。

### `src/core/control.ts`

集中管理 `AbortSignal` 组合、可取消 Promise 竞态、延迟等待和超时原因。所有 setup、限速等待、重试等待、adapter 调用、响应读取及响应拦截器等待都使用同一套取消分类规则：外部取消为 `ERR_CANCELED`，单次/总超时为 `ETIMEDOUT`。

### `src/core/retry.ts`

只负责重试决策和延迟计算：幂等方法默认规则、状态码/错误码匹配、`Retry-After`、退避、最大延迟、抖动、`shouldRetry` 和 `beforeRetry`。该模块不调用 adapter，也不修改响应对象。

### `src/core/attempt.ts`

执行单次已解析请求：调用 adapter、校验状态、读取和解析响应体、应用响应转换器、执行响应拦截器，并将异常转换成带配置和响应信息的 `HttpError`。它不决定是否进行下一次重试。

### `src/core/pipeline.ts`

作为请求执行编排器，负责初始请求拦截器和配置解析、总超时生命周期、缓存/去重接入、限速调度、重复执行 request interceptor、调用 `attempt`、根据 `retry` 决定下一次尝试，以及触发一次性的 `onRequestError`。它接收 adapter、拦截器管理器、缓存和限速器等依赖，不创建全局状态。

### `src/core/cache-policy.ts`

负责生成规范化缓存 key，并判断请求是否满足客户端 data cache 的兼容条件。请求级 signal、超时、进度、限速、自定义解析/转换、状态策略和拦截器等排除规则集中在这里，执行管线只消费布尔结果和 key。

### `src/core/errors.ts`

除保留公开的 `HttpError` 类型外，集中提供请求错误归一化和响应拦截器错误包装，供单次尝试和执行管线共享，避免两个层级各自复制错误分类逻辑。

## 数据流

```text
public method
  -> client normalizes input
  -> pipeline resolves config and setup cancellation
  -> cache policy / in-flight dedupe
  -> rate limiter and total timeout
  -> attempt (adapter + response processing)
  -> retry policy and delay
  -> data or HttpResponse
```

每次重试重新运行请求拦截器和请求转换器，但沿用稳定的请求 ID。不可重放的 `ReadableStream` body、外部取消和总超时不会进入下一次尝试。

## 错误与取消契约

模块之间传递 `unknown` 原始异常和已归一化的 `HttpError`，最终由 pipeline 保证配置、状态、响应、`isAbort`、`isTimeout` 和 `retryable` 字段一致。响应拦截器在 fulfilled 阶段抛错时只走一次 rejected 链；取消竞态获胜时不得被包装成拦截器错误，也不得留下未处理的底层 Promise rejection。

请求拦截器或请求转换器永久 pending 时，调用方提供的 `AbortSignal` 仍须及时结束公共请求 Promise；底层用户钩子不能被强制停止，但其晚到的结果必须被安全丢弃。

## 兼容性与文件迁移

只移动内部函数和内部类型，保留 `src/index.ts` 的导出名称和子入口 `./node-http2`、`./node-http3`。不保留 `src/query.ts` 等旧路径别名。README 增补新的内部边界说明，但不改变用户配置写法。

## 验证计划

1. 先为拆分后的控制、配置、重试和缓存策略保留现有行为测试，并增加模块边界测试。
2. 运行 TypeScript build 和完整 `npm test`，覆盖 Fetch、XHR、HTTP2、HTTP3、缓存、限速、上传、拦截器和取消竞态。
3. 运行 `npm pack --dry-run --json`，确认包只包含 `dist`、README、LICENSE 和 package manifest，不包含测试、设计草稿或 `superpowers` 目录。
4. 从根入口和 HTTP2/HTTP3 子入口执行 ESM import smoke，并确认工作区无未提交的实现改动。

## 完成标准

- `client.ts` 只保留实例/公共 API 编排，不再包含重试策略、响应解析和缓存 key 实现。
- 公开导入路径、类型、错误码和已有测试行为保持兼容。
- 所有验证命令通过，且没有新增未说明的运行时依赖或路径兼容层。
