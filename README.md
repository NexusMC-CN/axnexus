# axnexus

[简体中文](./README.zh-CN.md)

A TypeScript HTTP client built on native Fetch/XHR, with instance APIs, interceptors, `AxiosHeaders`, retries, caching, and streaming responses. The optional axnexus Selection JSON protocol lets clients select the fields they need over the same HTTP transport, without a GraphQL server.

**Node.js >=20 · ESM only · Built-in TypeScript types · Zero runtime dependencies in core**

Supports modern browsers and Bun environments that provide standard Web APIs. The root entry does not load Node transports or optional integrations. See the [full guide](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md) and [changelog (Chinese)](./CHANGELOG.md).

## Installation

```bash
pnpm add @nexusmc-cn/axnexus
# Or: npm install @nexusmc-cn/axnexus
```

The package ships ESM only, with no `require` export condition. CommonJS applications can use dynamic `import()`:

```javascript
// app.cjs
async function main() {
  const { createHttpClient } = await import('@nexusmc-cn/axnexus');
  const http = createHttpClient({ baseURL: 'https://api.example.com' });
  console.log(await http.get('/health'));
}
main().catch(console.error);
```

Fastify, OpenTelemetry, and TanStack Query are **optional peers**. Install them only when using their integration entries; supported versions appear in the [entry table](#public-entries) and `package.json`. The oRPC examples also require the application to install `@orpc/client`.

Published packages include `src` so JavaScript and declaration source maps can locate their sources. Import from the public entries in application code.

## HTTP quick start

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

Convenience methods return parsed data directly. Use [complete response methods such as `getResponse`](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#complete-responses) for status, headers, and timings. Configure Standard Schema for [inferred response types](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#schema-and-type-inference).

The default credential policy is `same-origin`. Set `credentials: 'include'` explicitly for cross-origin cookies, or `credentials: 'omit'` for public APIs. `X-Request-Id` is disabled by default; enable it with `requestId: true`. Use [session partitions](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#get-cache) for identity-dependent caching, and create a client per request during SSR.

## Public entries

Node transports are enabled only when explicitly imported. Optional integrations must also meet their framework's runtime requirements.

| Entry | Purpose and documentation |
| --- | --- |
| `@nexusmc-cn/axnexus` | [HTTP client and configuration](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#request-configuration), [headers](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#headers), [errors](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#error-handling), caching, uploads, and logging |
| `@nexusmc-cn/axnexus/stream` | [Incremental SSE/NDJSON reading and SSE reconnection](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#sse-and-ndjson) |
| `@nexusmc-cn/axnexus/fetch` | [Fetch bridge and oRPC](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#fetch-bridge-and-orpc) |
| `@nexusmc-cn/axnexus/contracts` | [Endpoint contracts and business errors](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#endpoint-contracts) |
| `@nexusmc-cn/axnexus/selection` | [Shared field contracts and the selection client](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#selection-protocol) |
| `@nexusmc-cn/axnexus/selection/server` | [Selection server, authorization, and budgets](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#server-execution) |
| `@nexusmc-cn/axnexus/fastify` | [Fastify Selection routes and Web bridge](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#fastify-server-integration); optional peer `fastify >=5.12.8 <6` |
| `@nexusmc-cn/axnexus/plugins` | [Context, plugins, and lifecycle events](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#context-and-plugins) |
| `@nexusmc-cn/axnexus/observability` | [Request observability and automatic logging](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#request-observability) |
| `@nexusmc-cn/axnexus/opentelemetry` | [OpenTelemetry plugin](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#opentelemetry); optional peer `@opentelemetry/api >=1.9.0 <2` |
| `@nexusmc-cn/axnexus/tanstack-query` | [TanStack Query options](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#tanstack-query); optional peer `@tanstack/query-core ^5.104.5` |
| `@nexusmc-cn/axnexus/node-http2` | [Node HTTP/2 adapter](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#http2-and-http3) |
| `@nexusmc-cn/axnexus/node-http3` | [HTTP/3 adapter with an injected QUIC transport](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#http2-and-http3) |
| `@nexusmc-cn/axnexus/package.json` | Package version, runtime requirements, and dependency metadata |

## Further reading

- HTTP: [retry](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#retry), [cancellation and timeouts](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#cancellation-and-timeouts), [interceptors](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#interceptors), [progress and rate limiting](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#progress-and-rate-limiting), [chunked uploads](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#chunked-uploads), and [CSRF](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#csrf).
- Selection: [protocol and security boundaries](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#protocol-and-security-boundaries), [bounded pagination](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#bounded-pagination), [request-scoped batch loading](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#request-scoped-batch-loading), [registered selection plans](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#registered-selection-plans), and [developer tools and observability](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#developer-tools-and-observability).
- Frameworks and runtimes: [Nuxt 4/Nitro](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#nuxt-4-and-nitro), [SSR JSON helpers](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#ssr-and-one-off-json-requests), [Bun](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#bun-runtime), and [runtime differences](https://github.com/NexusMC-CN/axnexus/blob/main/docs/guide.md#runtime-differences).

## Development

Use the pnpm version pinned in `packageManager` for development:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run test:types
pnpm run test:consumer
pnpm pack
```

The development workflow and CI use pnpm. `prepack` uses `npm run build` so packing or publishing with npm also works without a global pnpm installation. Release setup and verification are covered in the [publishing guide](https://github.com/NexusMC-CN/axnexus/blob/main/docs/releasing.md).

## License

[MIT](./LICENSE)
