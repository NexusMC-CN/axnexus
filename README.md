# axnexus

基于原生 Fetch/XHR 的 TypeScript HTTP 客户端。提供实例、拦截器、`AxiosHeaders`、重试、缓存和流式响应；可选的 axnexus Selection JSON 协议用于按需选择字段，共用 HTTP 传输，无需 GraphQL 服务。

**Node.js >=20 · ESM only · 内置 TypeScript 类型 · 核心零运行时依赖**

支持现代浏览器和提供标准 Web API 的 Bun。根入口不加载 Node 传输或可选集成依赖。完整用法见[使用指南](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md)，升级记录见 [CHANGELOG](./CHANGELOG.md)。

## 安装

```bash
npm install @nexusmc-cn/axnexus
# 或 pnpm add @nexusmc-cn/axnexus
```

包仅发布 ESM，没有 `require` 导出条件。CommonJS 项目通过动态 `import()` 加载：

```javascript
// app.cjs
async function main() {
  const { createHttpClient } = await import('@nexusmc-cn/axnexus');
  const http = createHttpClient({ baseURL: 'https://api.example.com' });
  console.log(await http.get('/health'));
}
main().catch(console.error);
```

Fastify、OpenTelemetry 和 TanStack Query 为**可选 peer**，仅在使用相应入口时安装，版本范围见[公共入口](#公共入口)与 `package.json`；oRPC 示例需要应用自行安装 `@orpc/client`。

发布包保留 `src`，供 JavaScript 和类型声明的 source map 定位源码。应用应从公共入口导入。

## HTTP 快速开始

```typescript
import { createHttpClient } from '@nexusmc-cn/axnexus';

const http = createHttpClient({
  baseURL: 'https://api.example.com/v1',
  timeout: 10_000,
  retry: 2,
});

const user = await http.get<{ id: string; name: string }>('/users/me');
const post = await http.post<{ id: string }, { title: string }>('/posts', {
  title: 'Hello',
});
```

便捷方法直接返回解析后的数据；需要状态、headers 和 timings 时使用 [`getResponse` 等完整响应方法](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#完整响应)。配置 Standard Schema 后可[自动推导返回类型](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#schema-与类型推导)。

默认凭据策略为 `same-origin`；跨源 Cookie 鉴权显式设置 `credentials: 'include'`，公开 API 可设置 `credentials: 'omit'`。默认不生成 `X-Request-Id`，可通过 `requestId: true` 开启。身份相关缓存应使用[会话分区](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#get-缓存)，SSR 应创建请求级客户端。

## 公共入口

下表列出可导入入口及对应指南。Node 传输仅在显式导入后启用；可选集成的运行环境还须满足所用框架的要求。

| 入口 | 用途与文档 |
| --- | --- |
| `@nexusmc-cn/axnexus` | [HTTP 客户端与配置](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#请求配置)、[headers](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#headers)、[错误处理](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#错误处理)、缓存、上传及日志 |
| `@nexusmc-cn/axnexus/stream` | [SSE/NDJSON 增量读取与 SSE 重连](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#sse-和-ndjson) |
| `@nexusmc-cn/axnexus/fetch` | [Fetch 桥接与 oRPC](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#fetch-桥接与-orpc) |
| `@nexusmc-cn/axnexus/contracts` | [端点契约与业务错误](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#端点契约) |
| `@nexusmc-cn/axnexus/selection` | [共享字段契约与选择客户端](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#selection-选择协议) |
| `@nexusmc-cn/axnexus/selection/server` | [Selection 服务端、授权与预算](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#服务端执行) |
| `@nexusmc-cn/axnexus/fastify` | [Fastify Selection 路由与 Web 桥接](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#fastify-服务端集成)；可选 peer `fastify >=5.12.8 <6` |
| `@nexusmc-cn/axnexus/plugins` | [Context、插件与生命周期事件](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#context-和插件) |
| `@nexusmc-cn/axnexus/observability` | [请求观测与自动日志](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#请求观测) |
| `@nexusmc-cn/axnexus/opentelemetry` | [OpenTelemetry 插件](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#opentelemetry)；可选 peer `@opentelemetry/api >=1.9.0 <2` |
| `@nexusmc-cn/axnexus/tanstack-query` | [TanStack Query options](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#tanstack-query)；可选 peer `@tanstack/query-core ^5.104.5` |
| `@nexusmc-cn/axnexus/node-http2` | [Node HTTP/2 adapter](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#http2-和-http3) |
| `@nexusmc-cn/axnexus/node-http3` | [注入 QUIC transport 的 HTTP/3 adapter](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#http2-和-http3) |
| `@nexusmc-cn/axnexus/package.json` | 包版本、运行环境和依赖元数据 |

## 深入使用

- HTTP：[重试](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#重试)、[取消和超时](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#取消和超时)、[拦截器](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#拦截器)、[进度和限速](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#进度和限速)、[分块上传](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#分块上传)、[CSRF](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#csrf)。
- Selection：[协议与安全边界](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#协议与安全边界)、[有界分页](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#有界分页)、[请求内批量加载](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#请求内批量加载)、[已注册选择方案](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#已注册的选择方案)、[开发工具与观测](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#开发工具与观测)。
- 框架与运行环境：[Nuxt 4/Nitro](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#nuxt-4-与-nitro)、[SSR JSON helpers](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#ssr-和一次性-json-请求)、[Bun](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#bun-运行时)、[运行环境差异](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#运行环境差异)。

## 许可证

[MIT](./LICENSE)

维护者发布步骤见[发布指南](https://github.com/NexusMC-CN/axnexus/blob/main/docs/releasing.md)。
