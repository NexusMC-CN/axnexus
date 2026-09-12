# axnexus

一个基于原生 `fetch` 的轻量 TypeScript HTTP 客户端，提供 Axios 风格的实例 API、拦截器、超时取消、重试和 GET 缓存。

## 特性

- 零运行时依赖，支持现代浏览器和 Node.js 18+。
- 提供 `get`、`post`、`put`、`patch`、`delete` 和通用 `request` 方法。
- 自动处理 JSON、文本、`Blob`、`ArrayBuffer`、`FormData` 和 `Response`。
- 支持请求/响应拦截器、请求 ID、超时、`AbortSignal` 和可配置重试。
- 支持 GET 响应 TTL 缓存和并发请求去重。
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

## FormData

```typescript
const form = new FormData();
form.set('file', file);
form.set('purpose', 'content');

const uploaded = await http.post<{ url: string }>('/upload', form);
```

客户端不会为 `FormData` 手动设置 `Content-Type`，浏览器会自动补充 multipart boundary。

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

## 开发

```bash
npm install
npm test
npm run build
```

构建产物位于 `dist/`，包不需要 AVMCBBS 或其他业务项目才能构建和测试。

## 许可证

MIT
