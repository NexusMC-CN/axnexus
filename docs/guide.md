# axnexus Guide

[Project home](../README.md) · [简体中文](./guide.zh-CN.md) · [Changelog](../CHANGELOG.md)

A TypeScript HTTP client built on native Fetch/XHR. Use the familiar instance API for everyday requests; choose the separate **axnexus Selection** JSON protocol when you need to request only specific fields. Both share HTTP transport, but Selection requires no GraphQL server, query language, or runtime dependencies.

## Start here

| What you want to do | Where to start |
| --- | --- |
| Send HTTP requests | [Installation](#installation), [HTTP quick start](#http-quick-start), [Request configuration](#request-configuration) |
| Select API fields on demand | [Selection protocol](#selection-protocol), [Bounded pagination](#bounded-pagination), [Request-scoped batch loading](#request-scoped-batch-loading), [Registered selection plans](#registered-selection-plans) |
| Handle production reliability and performance | [Error handling](#error-handling), [Retry](#retry), [GET cache](#get-cache), [Progress and rate limiting](#progress-and-rate-limiting) |
| Integrate existing services and ecosystems | [Fastify server integration](#fastify-server-integration), [Nuxt 4 and Nitro](#nuxt-4-and-nitro), [SSR and one-off JSON requests](#ssr-and-one-off-json-requests), [Endpoint contracts](#endpoint-contracts), [Fetch bridge and oRPC](#fetch-bridge-and-orpc) |
| Observe request behavior | [Selection developer tools and observability](#developer-tools-and-observability), [HTTP request observability](#request-observability), [OpenTelemetry](#opentelemetry) |

## Capability map

| Scope | Capabilities |
| --- | --- |
| HTTP core | Axios-style instances and `AxiosHeaders`; JSON, text, `Blob`, `ArrayBuffer`, `FormData`, and `Response`; timeouts, cancellation, interceptors, status hooks, and transformation hooks |
| Network control | Structured retries and `Retry-After`, GET TTL caching and request deduplication, download/upload progress, response size limits, concurrency/rate scheduling, and chunked uploads |
| Services and ecosystems | SSR `fetchJson`, SSE/NDJSON, endpoint contracts, Fetch bridge, Fastify server integration, Nuxt 4/Nitro integration, Node HTTP/2 and injected HTTP/3, and TanStack Query |
| Selection (optional) | Typed field contracts, per-field authorization, query budgets, and on-demand execution; see below for pagination, request-scoped batching, registered selection plans, and observability extensions |

The core has zero runtime dependencies and supports modern browsers, Node.js 20+, and Bun environments that provide standard Web APIs. Import optional integrations through their own entry points; the root entry point does not load Node transports or optional ecosystem dependencies.

## Installation

```bash
pnpm add @nexusmc-cn/axnexus
```

The package is ESM-only, requires Node.js >=20, uses `import`, and includes TypeScript declarations. CommonJS projects must use dynamic `import()`; the package has no `require` export condition. Published packages retain `src` so that JavaScript and declaration source maps can locate the source; applications should use the public entry points listed below. The API uses instances, interceptors, and `AxiosHeaders`-style headers, and convenience request methods return parsed data directly by default.

### Entry points

| Entry point | Purpose |
| --- | --- |
| `@nexusmc-cn/axnexus` | HTTP client, headers, schemas, caching, uploads, and logging |
| `@nexusmc-cn/axnexus/stream` | [SSE/NDJSON consumption and SSE reconnection](#sse-and-ndjson) |
| `@nexusmc-cn/axnexus/fetch` | [Provide Fetch for SDKs such as oRPC](#fetch-bridge-and-orpc) |
| `@nexusmc-cn/axnexus/contracts` | [Endpoint contracts and business errors](#endpoint-contracts) |
| `@nexusmc-cn/axnexus/selection` | [Shared field contracts and the selection client](#selection-protocol) |
| `@nexusmc-cn/axnexus/selection/server` | [Selection server handler](#selection-protocol) |
| `@nexusmc-cn/axnexus/fastify` | [Optional Fastify Selection routes and Web Request/Response bridge](#fastify-server-integration) |
| `@nexusmc-cn/axnexus/plugins` | [Plugins and lifecycle event types](#context-and-plugins) |
| `@nexusmc-cn/axnexus/observability` | [Request logging and automatic integration](#request-observability) |
| `@nexusmc-cn/axnexus/opentelemetry` | [Optional OpenTelemetry plugin](#opentelemetry) |
| `@nexusmc-cn/axnexus/tanstack-query` | [Optional TanStack Query options](#tanstack-query) |
| `@nexusmc-cn/axnexus/node-http2`, `@nexusmc-cn/axnexus/node-http3` | [Node transports](#http2-and-http3) |

Install the corresponding dependencies only when using the Fastify, OpenTelemetry, TanStack Query, or oRPC integrations. See their sections for details.

## HTTP quick start

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

The default credentials policy is `same-origin`. The client automatically adds `Accept: application/json` and does not generate `X-Request-Id` by default. Explicitly supplied headers with the same names retain the caller's values. Set `requestId: true` on the client or an individual request to enable IDs, or supply a factory function; retries of the same logical request reuse the same ID.

Cross-origin authentication requires an explicit `credentials: 'include'` setting, and the server must configure CORS and `Access-Control-Allow-Credentials` correctly. Public APIs can use `credentials: 'omit'`. When upgrading to `0.2.0`, callers that rely on cross-origin cookies or automatic request IDs must explicitly enable the relevant options; see the [changelog](../CHANGELOG.md) for other compatibility changes.

The `trace` and `connect` convenience methods are reserved for custom adapters that support those methods. Built-in Fetch (including Node Fetch) and XHR throw `ERR_UNSUPPORTED_METHOD` before sending the request and do not retry it as a network failure.

## Selection protocol

Selection is axnexus's own optional JSON protocol. The client declares the fields it needs, and the server authorizes and executes each field; it does not use the GraphQL query language. Shared contracts contain only public field shapes. Server resolvers and authorization functions are imported only from `/selection/server`. Deployment still requires same-origin/cross-origin access, authentication, and CSRF policies.

For endpoints with a fixed response shape, continue using ordinary HTTP requests or [endpoint contracts](#endpoint-contracts). Use Selection when multiple pages need different combinations of fields from the same resource; the server still determines business identity and permissions.

### Shared contract and client

First define the resource arguments and public fields, then call `select` from the client. Multiple selection shapes can reuse the same resource.

`users-contract.ts` contains only the resource definition that can be shared:

```typescript
import { defineSelectionResource, leaf } from '@nexusmc-cn/axnexus/selection';

const stringSchema = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected string' }] };
} } };
const argsSchema = { '~standard': { validate(value: unknown) {
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    ? { value: { id: value.id } } : { issues: [{ message: 'Expected id' }] };
} } };
export const users = defineSelectionResource({
  resource: 'users.byId.v1', args: argsSchema, nullable: true,
  fields: { id: leaf(stringSchema), name: leaf(stringSchema) },
});
```

The caller then creates a client:

```typescript
import { createHttpClient } from '@nexusmc-cn/axnexus';
import { createSelectionClient } from '@nexusmc-cn/axnexus/selection';
import { users } from './users-contract.js';

const http = createHttpClient({ baseURL: 'https://api.example.com' });
const selection = createSelectionClient(http, { endpoint: '/__axnexus/select' });
const user = await selection.select(users, {
  args: { id: '42' }, select: { id: true, name: true } as const,
});
// user: { id: string; name: string } | null
```

This selection produces the following JSON request:

```json
{
  "protocol": "axnexus.selection",
  "version": 1,
  "resource": "users.byId.v1",
  "args": { "id": "42" },
  "select": { "id": true, "name": true }
}
```

### Server execution

On the server, import the shared contract from a separate module, define the root loader, field resolvers, and authorization, then mount a POST route:

```typescript
import { createSelectionHandler, implementSelection } from '@nexusmc-cn/axnexus/selection/server';
import { users } from './users-contract.js';

declare function readUserName(id: string): Promise<string>;
const server = implementSelection(users, {
  authorizeResource: ({ context }) => Boolean(context),
  load: async ({ args }) => ({ id: args.id }), // Load only the minimal identity data needed for field authorization
  fields: {
    id: { resolve: ({ parent }) => parent.id },
    name: { resolve: async ({ parent }) => readUserName(parent.id) },
  },
});
const limits = {
  maxRequestBytes: 8192, maxDepth: 4, maxFields: 20, maxCost: 100, maxArrayLength: 50,
};
const handler = createSelectionHandler({ resources: [server], limits });
// Framework route POST /__axnexus/select: return handler(request, authenticatedContext);
```

### Protocol and security boundaries

The protocol uses POST. Successful responses have a `{ data }` body; failures have `{ error: { code, message } }`. Each request selects one resource, is read-only, and allows no partial success. The server returns `Cache-Control: no-store`. Static selections infer the returned fields precisely; dynamic selections receive a conservative type with optional fields. Resource and field permissions must be checked before their respective reads. The root loader does not receive the selection tree, preventing it from preloading unauthorized fields.

If a leaf schema transforms a resolver value into a different JSON shape, configure `leaf(schema, { wireSchema })` with a schema that validates the transformed value; the client uses it to validate the server's response. Fields that only validate without transforming can omit it.

| Server limit | What it controls |
| --- | --- |
| `maxRequestBytes` | JSON request body size; reading stops as soon as the request exceeds the limit |
| `maxDepth`, `maxFields` | Selection tree depth and field count |
| `maxCost` | Worst-case budget estimated from field costs and array limits |
| `maxArrayLength` | Maximum number of items an array can return; also used to estimate cost |

Request body and selection tree budgets are checked before reading the resource; actual array lengths are checked again when fields return. Business fields can explicitly configure their `cost` in the shared contract.

### Bounded pagination

List resources receive `first` and `after` through their resource arguments. The server uses `paginateSelection` to limit page size, convert opaque cursors, and load data; the client continues to select fields from the returned items and pagination metadata as needed. The server configures the maximum page size and does not trust the client's submitted `first`.

```typescript
import { paginateSelection } from '@nexusmc-cn/axnexus/selection/server';

declare function decodeUserCursor(value: string): string;
declare function encodeUserCursor(id: string): string;
declare const userStore: {
  listAfterId(input: { after: string | null; limit: number; signal?: AbortSignal }):
    Promise<readonly { id: string }[]>;
};

// Call from the resource's load; the business data source implements cursors and stable ordering.
const loadPage = (args: { first: number; after?: string }, signal: AbortSignal) =>
  paginateSelection(args, {
    maxPageSize: 50,
    decodeCursor: decodeUserCursor,
    encodeCursor: (row) => encodeUserCursor(row.id),
    load: ({ after, limit, signal }) => userStore.listAfterId({ after, limit, signal }),
    signal,
  });
// loadPage returns { items, pageInfo: { endCursor, hasNextPage } }.
```

The helper passes `limit = first + 1` to `load` and rejects results that exceed this limit; the extra item determines `hasNextPage`. Cursors must correspond to stable, unique sort keys, and the data source must query in the same order. Define `items` and `pageInfo` as public resource fields, and set `maxArrayLength` to at least the maximum permitted page size. The returned structure does not include a total count.

### Request-scoped batch loading

When multiple items in a list need related data, use `createSelectionBatchLoader` to combine reads within the same request. Create a loader for every request through the handler's `createLoaders`, then access it through `loaders` in resolvers. The factory must create new loaders on every call; do not return instances shared across requests.

```typescript
import { createSelectionBatchLoader, withSelectionLoaders } from '@nexusmc-cn/axnexus/selection/server';

// Pass this factory to createSelectionHandler({ ..., createLoaders }).
const createLoaders = ({ context, signal }: {
  context: { accounts: { namesByIds(ids: readonly string[]): Promise<readonly string[]> } };
  signal: AbortSignal;
}) => ({
  accounts: createSelectionBatchLoader<string, string>(
    (ids) => context.accounts.namesByIds(ids),
    { signal, maxBatchSize: 50 },
  ),
});

// Bind the factory to the implementer first so field resolvers infer their loaders' types:
const scoped = withSelectionLoaders(createLoaders);
// const server = scoped.implement(membersContract, { ...field implementations... });
// const handler = createSelectionHandler({ resources: [server], createLoaders: scoped.createLoaders, limits });

// Corresponding field resolver:
// accountName: { resolve: ({ parent, loaders }) => loaders.accounts.load(parent.accountId) }
```

The batch function must return the same number of results in input order. Results for the same key can be reused within a single request; each request gets its own loaders. The server first checks permissions for the same field across all items, then reads that field concurrently so that multiple keys can be collected.

### Registered selection plans

For fixed pages or clients, use `defineSelectionPlan` to name a selection tree, then request it by plan ID through the client's `execute` method. The server registers and validates these plans. This lets you retain dynamic selections for callers that need them while giving known pages a stable set of fields. Plan IDs must include a version so that field changes require an explicit upgrade.

Shared `users-plan.ts`:

```typescript
import { defineSelectionPlan } from '@nexusmc-cn/axnexus/selection';
import { users } from './users-contract.js';

export const userSummary = defineSelectionPlan('users.summary.v1', users, {
  id: true,
  name: true,
});
```

Client call:

```typescript
import { userSummary } from './users-plan.js';

const user = await selection.execute(userSummary, { args: { id: '42' } });
```

The `execute` request body sends only the plan ID and arguments; the server executes the registered selection tree. The client and server should import the same plan definition. Register plans on the server with `plans: [userSummary]`. With `allowDynamic: false`, the server accepts only registered plans: unregistered IDs return `UNKNOWN_PLAN`, and ordinary dynamic selection requests return `DYNAMIC_SELECTION_DISABLED`:

```typescript
import { userSummary } from './users-plan.js';

const planOnlyHandler = createSelectionHandler({
  resources: [server],
  plans: [userSummary],
  allowDynamic: false,
  limits,
});
```

### Developer tools and observability

`describeSelectionResource` describes a resource's public field structure; `inspectSelection` checks a selection's structure and budget before sending it. The handler's `observe` hook records request outcomes and execution statistics to help identify selections that are too deep or too expensive.

```typescript
import { describeSelectionResource, inspectSelection } from '@nexusmc-cn/axnexus/selection';

const description = describeSelectionResource(users);
const inspected = inspectSelection(users, { id: true, name: true }, {
  maxDepth: 4, maxFields: 20, maxCost: 100, maxArrayLength: 50,
});
console.log(description.resource, inspected.metrics);
```

`inspected.metrics` contains `fieldCount`, `depth`, `cost`, and field `paths`. Configure `observe: (event) => logger.info(event)` on the handler to record metadata such as the request mode (`dynamic`, `registered`, or `invalid`), status, duration, request bytes, and budgets. Callbacks should not log resource arguments, response values, or user identities; an observability callback failure does not change the protocol response.

### Fastify server integration

The ordinary axnexus HTTP client can call existing Fastify REST routes directly, with no plugin. To serve Selection, optionally install Fastify 5 (`>=5.12.8 <6`) and mount a Selection POST route through the separate entry point. The root entry point does not load `/fastify`.

```bash
pnpm add fastify@^5.12.8
```

Reuse the `server` resource implementation and `limits` above and register them on the server:

```typescript
import Fastify, { type FastifyRequest } from 'fastify';
import { createFastifySelectionPlugin } from '@nexusmc-cn/axnexus/fastify';

declare function authenticate(request: FastifyRequest): Promise<{ id: string }>;

const app = Fastify();
await app.register(createFastifySelectionPlugin({
  resources: [server],
  limits,
  getContext: async (request) => ({ principal: await authenticate(request) }),
}), { prefix: '/api' });

// POST /api/__axnexus/select
```

`getContext` builds context from a server-verified session or token for resource and field authorization. The plugin registers only this Selection route and preserves the application's handling of existing REST, upload, streaming, and other Fastify routes. It reads raw JSON bytes for Selection within its own encapsulation scope, leaving business-route parsers unaffected.

`endpoint` configures both the server handler's internal path and the Fastify route. For example, with `endpoint: '/select/v1'` on the plugin and `{ prefix: '/api' }` during registration, the client should use `createSelectionClient(http, { endpoint: '/api/select/v1' })`. When using `createSelectionHandler` directly, its `endpoint` should likewise match the actual mount path.

For existing Web `Request`/`Response` handlers in your application, use the general-purpose bridge on individual routes:

```typescript
import { sendWebResponse, toWebRequest } from '@nexusmc-cn/axnexus/fastify';

declare function webStatusHandler(request: Request): Promise<Response>;

app.get('/status', async (request, reply) => {
  const response = await webStatusHandler(toWebRequest(request, { reply }));
  return sendWebResponse(reply, response);
});
```

`toWebRequest` preserves the method, path, and request headers. When given the current `reply`, it aborts the Web `Request.signal` if the client disconnects before the response completes. Requests without `reply` do not track connection cancellation. `sendWebResponse` forwards the status, response headers, multiple `Set-Cookie` headers, and response stream. `toWebRequest` does not reserialize JSON or multipart objects already parsed by Fastify. When bridging routes with request bodies, configure a raw-byte parser or explicitly pass `toWebRequest(request, { reply, body: rawBytes })`. Explicit `body` values accept only text, bytes, or Web streams, not constructed `FormData`, `URLSearchParams`, or `Blob` objects. For multipart routes, pass the raw request bytes and a matching `Content-Type`. To override the origin or internal path, set `origin` or `path`, respectively.

### Nuxt 4 and Nitro

The ordinary axnexus HTTP client can call existing Nuxt/Nitro REST routes. The Selection server uses the framework-independent `createSelectionHandler`, with no need to install `@nexusmc-cn/axnexus/fastify` or a new Nuxt module. The examples below were verified with Nuxt 4.5.2 and 4.6.3, respectively. Projects must still satisfy their Nuxt version's Node requirements (`^22.19.0 || ^24.11.0 || >=26` for 4.5.2; `^22.22.3 || ^24.15.0 || >=26` for 4.6.3). Both approaches use the same `server` resource implementation and `limits`; `authenticate` is the application's own session or token verification function.

**Nuxt 4.6+:** Use the Web Request/Response interface from `nuxt/server` in `server/api/__axnexus/select.post.ts`:

```typescript
import { defineEventHandler } from 'nuxt/server';
import { createSelectionHandler } from '@nexusmc-cn/axnexus/selection/server';
import { server, limits } from '~~/server/utils/selection';
import { authenticate } from '~~/server/utils/auth';

const handler = createSelectionHandler({
  resources: [server], limits, endpoint: '/api/__axnexus/select',
});

export default defineEventHandler(async (event) =>
  handler(event.req, { principal: await authenticate(event.req) }));
```

**Nuxt 4.5:** Use H3 v1 to convert requests and responses in the same route. The example imports `h3` directly, so applications using pnpm should explicitly install `h3@1.15.11` (the version used in consumer tests). H3 v1 still marks `toWebRequest` as unstable, so pinning verified Nuxt/H3 versions is recommended:

```typescript
import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3';
import { createSelectionHandler } from '@nexusmc-cn/axnexus/selection/server';
import { server, limits } from '~~/server/utils/selection';
import { authenticate } from '~~/server/utils/auth';

const handler = createSelectionHandler({
  resources: [server], limits, endpoint: '/api/__axnexus/select',
});

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event);
  const response = await handler(request, { principal: await authenticate(request) });
  return sendWebResponse(event, response);
});
```

`server/api/...` automatically adds the `/api` prefix, so both server handlers and the client should use `/api/__axnexus/select`. If the file moves to `server/routes/__axnexus/select.post.ts`, the path becomes `/__axnexus/select`. Identity must come from verified server context; do not trust identity fields in the request body. The Nuxt application remains responsible for CORS, CSRF, session validation, and its own authentication hooks; the Selection handler is responsible only for the protocol, budgets, and resource and field authorization.

In Nuxt SSR, do not place an axnexus client containing cookies, tenant caches, or user caches in a process-wide singleton. Create a client for each request and use the current request event's `fetch` for internal routes. Convert incoming Fetch `Headers` to a plain object first for compatibility with H3 v1's header handling. The following can be placed in a page's `<script setup lang="ts">`; `users` is the shared resource contract defined above:

```typescript
import { createFetchAdapter, createHttpClient } from '@nexusmc-cn/axnexus';
import { createSelectionClient } from '@nexusmc-cn/axnexus/selection';
import { users } from '~~/shared/users-contract';

const event = import.meta.server ? useRequestEvent() : undefined;
const cookie = import.meta.server ? useRequestHeaders(['cookie']).cookie : undefined;
const internalFetch: typeof fetch | undefined = event
  ? (input, init) => {
      if (typeof input !== 'string') throw new TypeError('Nuxt internal fetch requires a local path');
      return event.fetch(input, {
        ...init,
        headers: Object.fromEntries(new Headers(init?.headers)),
      });
    }
  : undefined;

const { data } = await useAsyncData('user-42', async () => {
  const http = createHttpClient({
    adapter: createFetchAdapter(internalFetch),
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  try {
    return await createSelectionClient(http, { endpoint: '/api/__axnexus/select' }).select(users, {
      args: { id: '42' }, select: { id: true, name: true } as const,
    });
  } finally {
    await http.close();
  }
});
```

`useAsyncData` handles the SSR payload and client hydration. Data keys should correspond to the resource and arguments; invalidate the relevant keys after login, logout, or switching users. You can also use axnexus for ordinary REST requests; if you only need Nuxt's native data fetching, use `useFetch` directly. Bare `$fetch` does not automatically forward the current user's cookies during SSR and cannot replace request-scoped identity header handling.

## Headers

```typescript
import { AxiosHeaders } from '@nexusmc-cn/axnexus';

const headers = new AxiosHeaders({ Authorization: 'Bearer token' });
headers.setAccept('application/json');
headers.set('X-Trace-Id', 'trace-1');
console.log(headers.get('authorization'));
```

`AxiosHeaders.from(value)` reuses an existing `AxiosHeaders` instance or converts native `Headers`, a `Map` or other iterable of key-value pairs, or a plain object into a consistent instance. Call `headers.toHeaders()` when passing headers to Fetch/XHR. `false` is a sentinel that explicitly disables a header (for example, `Content-Type: false`); `null` and `undefined` mean the header is not sent. This keeps mutable application headers distinct from the native `Headers` used by adapters.

The request configuration's `headers` can contain `common` defaults and defaults grouped by method. They are merged in this order: client defaults, `common`, the current method, and request-level values. Later values take precedence without creating duplicate keys that differ only in case.

## Request configuration

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

`params` are encoded with `URLSearchParams`: arrays produce repeated query keys, while `null` and `undefined` are skipped. Relative paths are resolved against `baseURL`; set `allowAbsoluteURL: false` to disallow absolute URLs. Control characters in the URL or `baseURL` are rejected so that characters such as tabs and newlines cannot bypass address policies through browser normalization.

Use `cache: { ttl }` or `cache: false` for the client cache. To pass a native Fetch cache mode to the adapter, use `fetchCache` (or its equivalent, `requestCache`), for example, `fetchCache: 'no-store'`. `dispatcher` and `agent` are forwarded only in Node runtimes; `duplex`, `priority`, and `window` depend on runtime support. `ReadableStream` request bodies automatically set `duplex: 'half'`. Bun-specific Fetch options are not automatically mixed into the shared configuration.

Plain objects, arrays, numbers, booleans, and `null` are automatically serialized as JSON. Strings, `FormData`, `Blob`, `ArrayBuffer`, `URLSearchParams`, and other `BodyInit` values are passed through unchanged.

### Status, timeouts, and transforms

```typescript
const result = await http.get('/jobs/123', {
  // Treat only statuses of 500 or higher as errors; 404 returns normally.
  validateStatus: (status) => status < 500,
  totalTimeout: 30_000,
  parseJson: (text) => JSON.parse(text, reviveDates),
  transformResponse: (data) => ({ ...data as object, receivedAt: Date.now() }),
});
```

Except with `responseType: 'response'`, `204`, `205`, `304`, `HEAD`, and empty response bodies return `null`; whitespace-only responses also return `null` in JSON or text mode. `responseType: 'text'` preserves nonempty text unchanged, `blob` returns a Blob with the response's `Content-Type`, and `arrayBuffer` returns the corresponding binary value. A HEAD response's `Content-Length` describes the corresponding GET resource's size; it is not treated as actual downloaded bytes or response body size.

Both the client and `fetchJson` accept an optional Standard Schema validator: after parsing, they call `schema['~standard'].validate()` and throw `ERR_SCHEMA_VALIDATION` if validation fails. The client runs `transformResponse` only after validation succeeds, without depending on a specific library such as Zod or Valibot. Empty responses skip validation, but JSON `null` is still validated. Any validator result containing `issues`, including an empty array, is treated as a failure.

### Schema and type inference

When configuring `schema`, omit the explicit response `<T>` and let the schema's output determine the type. `get`, `request`, complete-response methods, `fetchJson`, and `fetchJsonResult` follow the same rule. A response without a body can still yield `null`, so the inferred type includes `null`. Calls without a schema retain the existing explicit generic API.

You can use a library compatible with Standard Schema v1 or write a validator yourself. `StandardSchema<Output, Input>` keeps the output generic first. Legacy handwritten validators may omit `version`, `vendor`, and `types`; a successful result must contain `value`, and a failed result contains `issues`.

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
      return { issues: [{ message: 'Expected a user object' }] };
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

Schema validation runs before response transformation. When `transformResponse` is configured in client defaults or for an individual request, the final result is conservatively inferred as `unknown`; narrow the type before using the transformed result. `InferSchemaInput` and `InferSchemaOutput` extract a schema's input and output types. Later examples reuse the `userSchema` defined here.

JSON parsing failures, including those from a custom `parseJson`, throw `ERR_BAD_PAYLOAD`; `transformResponse` failures throw `ERR_TRANSFORM_RESPONSE`. Payloads for error statuses are read as text and then parsed as JSON if possible. If they exceed `maxBodySize`, they are set to `null` while preserving the original HTTP status error. Discarded or partially read response bodies are actively canceled to release the connection.

If a `validateStatus` or `throwHttpErrors` callback itself throws, the request fails with `ERR_INVALID_STATUS_POLICY` and is not resent as a retryable network error.

`maxBodySize` is measured in bytes. Only omission or `undefined` means unlimited; an explicit value must be a nonnegative safe integer. `0` allows only an empty body. Negative numbers, fractions, `NaN`, `Infinity`, `null`, and nonnumeric values throw `ERR_INVALID_CONFIG`. Readable streams are counted chunk by chunk, and the underlying response body is canceled immediately when the limit is exceeded. Without a readable stream, the size can only be checked after the runtime buffers the body. Responses decompressed by Fetch are limited by their actual decompressed bytes, rather than incorrectly using the compressed `Content-Length`; raw transports use the bytes they expose. HEAD and `204`/`205`/`304` responses are not counted by their declared length. `responseType: 'response'` preserves metadata such as `url`, `redirected`, and `type`.

Explicit `timeout`, `totalTimeout`, and retry counts are also validated. Timeouts must be nonnegative safe integers, with `0` disabling the timeout; retry counts must be nonnegative safe integers. Delays, maximum delays, and delay callback results must be finite nonnegative numbers no greater than `Number.MAX_SAFE_INTEGER`. Invalid configuration throws `ERR_INVALID_CONFIG` and is not retried as a network error. Valid waits exceeding a single timer's limit are scheduled in segments.

Use `transformRequest` and `stringifyJson` to integrate a custom serialization protocol. A failure in any request transform or serialization hook throws `ERR_TRANSFORM_REQUEST`.

## FormData

```typescript
const form = new FormData();
form.set('file', file);
form.set('purpose', 'content');

const uploaded = await http.post<{ url: string }>('/upload', form);
```

The client does not manually set `Content-Type` for `FormData`; the browser adds the multipart boundary automatically.

## Progress and rate limiting

Download progress is reported chunk by chunk when the Fetch response body is readable. Upload progress requires explicitly selecting the XHR adapter:

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

`RateLimiter` can also be used independently. `AbortSignal` can cancel rate-limit waits; a queue timeout throws `ERR_RATE_LIMIT_QUEUE_TIMEOUT`. The default Fetch adapter does not simulate upload progress because standard Fetch has no consistent cross-runtime request-body progress events. Native XHR progress events support upload and download progress, but browser XHR does not provide reliable byte-level send throttling. As a result, `bytesPerSecond` throttles the transfer itself only for Fetch, Node HTTP/2, and HTTP/3 implemented by a transport.

## Complete responses

Convenience methods return only `data` by default. Use a response method when you need the status code, headers, protocol, and timings:

```typescript
const response = await http.getResponse<{ id: string }>('/users/me');
console.log(response.data, response.status, response.protocol, response.timings.duration);
```

The available methods are `requestResponse`, `getResponse`, `headResponse`, `optionsResponse`, `traceResponse`, `connectResponse`, `postResponse`, `putResponse`, `patchResponse`, and `deleteResponse`. Complete responses do not enter the GET data cache. With regular methods, `responseType: 'response'` still returns the raw `Response`.

When receiving a raw `Response`, the caller should consume or cancel its body to release the connection. Request cancellation, timeouts, and transport cleanup remain active until reading the response body completes, fails, or is canceled.

### API signature reference

The following table shows calls with explicit generics and no schema. When a schema is configured, use [automatic type inference](#schema-and-type-inference).

| API | Signature |
| --- | --- |
| Create a client | `createHttpClient(config?: HttpClientConfig): HttpClient` |
| General request | `request<T>(config)` or `request<T>(url, config?): Promise<T>` |
| Complete response | `requestResponse<T>(config)` or `requestResponse<T>(url, config?): Promise<HttpResponse<T>>` |
| Convenience methods | `get/head/options/trace/connect<T>(url, config?)`, `delete<T>(url, config?)` |
| Methods with a request body | `post<T, B>(url, data?, config?)`, `put<T, B>(...)`, `patch<T, B>(...)` |
| Complete-response convenience methods | `getResponse`, `headResponse`, `optionsResponse`, `traceResponse`, `connectResponse`, `postResponse`, `putResponse`, `patchResponse`, `deleteResponse` |

Refer to the package's exported `RequestConfig`, `HttpClientConfig`, `HttpResponse`, and `HttpError` for the complete field types.

## Error handling

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

Possible `HttpError.code` values:

| Code | Meaning |
| --- | --- |
| `ERR_BAD_RESPONSE` | The HTTP status does not satisfy the status policy; by default, any non-2xx status |
| `ERR_NETWORK` | Network-layer failure |
| `ETIMEDOUT` | The request exceeded its timeout |
| `ERR_CANCELED` | Cancellation by an external `AbortSignal` |
| `ERR_BAD_PAYLOAD` | A successful response could not be parsed as JSON |
| `ERR_TRANSFORM_REQUEST` | A request transform hook threw an exception |
| `ERR_TRANSFORM_RESPONSE` | A response transform hook threw an exception |
| `ERR_SCHEMA_VALIDATION` | The response failed Standard Schema validation |
| `ERR_INVALID_HEADER` | A header name or value contains invalid characters |
| `ERR_INVALID_CONFIG` | An explicitly supplied configuration value or URL is invalid |
| `ERR_INVALID_STATUS_POLICY` | A status-policy callback threw an exception |
| `ERR_MAX_BODY_SIZE` | The response body exceeds `maxBodySize` |
| `ERR_RATE_LIMIT_QUEUE_TIMEOUT` | The request timed out in the rate-limit queue |
| `ERR_UNSUPPORTED_ADAPTER` | The selected adapter is unsupported in the current environment |
| `ERR_UNSUPPORTED_METHOD` | The selected adapter does not support the HTTP method |
| `ERR_PROTOCOL_NEGOTIATION` | The transport could not negotiate the requested protocol |

An `HttpError` caused by response schema validation preserves the available `status` and `response`. Its `cause` is a `SchemaValidationError`; use the read-only `issues` to inspect each issue's `message` and optional `path`:

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

`isHttpError` / `instanceof HttpError` and `isSchemaValidationError` / `instanceof SchemaValidationError` recognize duplicate module instances of the same version within the same global runtime, preserving error classification, response, cancellation, and timeout information. Recognition across versions, processes, or realms is not guaranteed. Ordinary objects with the same name or shape are not treated as axnexus errors.

## Cancellation and timeouts

```typescript
const controller = new AbortController();
const pending = http.get('/large-report', {
  signal: controller.signal,
  timeout: 30_000,
});

controller.abort();
await pending;
```

`timeout` bounds a single adapter attempt, including response body reading and waits for response interceptors. `totalTimeout` starts when the public request method is entered and covers the first asynchronous request interceptor, `transformRequest`, queuing, retry decisions, backoff waits, and every attempt. The total budget is determined by the request configuration or client defaults at call time; interceptors do not restart it. Either timeout throws `ETIMEDOUT`. Adapter responses that arrive after timeout or cancellation are actively released.

Timeouts, backoff, rate-limit waits, and chunk retries use segmented timers, so waits beyond the runtime's 32-bit timer range do not overflow into immediate execution. Relative waits use a monotonic clock and are unaffected by backward system-clock adjustments.

External cancellation throws `ERR_CANCELED` and ends pending waits for request interceptors, request transforms, rate-limit queues, adapters, response body reading, and response interceptors as early as possible. When a per-attempt timeout races with external cancellation, whichever fires first takes precedence; if the total timeout timer has already fired, the result is `ETIMEDOUT`. Canceled requests are not automatically retried. Custom adapters and asynchronous callbacks must still respond to the signal themselves to stop underlying operations that have already started.

## Retry

Requests are not retried by default. When `retry` is configured, the default retry statuses are `408`, `429`, `500`, `502`, `503`, and `504`, and the allowed methods are GET, HEAD, OPTIONS, and TRACE. POST, PUT, PATCH, and DELETE are not automatically retried by default.

```typescript
const created = await http.post('/jobs', payload, {
  retry: 2,
  retryDelay: (attempt) => attempt * 500,
  retryUnsafeMethods: true,
});
```

Network errors and per-attempt timeouts follow the same retry-count configuration; cancellations are not retried. A request-level `retry` object inherits from the client-level object, overriding only explicitly supplied fields. A request-level number overrides only `limit`, preserving the client's status, method, and backoff settings. Backoff precedence is request-level `retryDelay`, client-level `retryDelay`, then `retry.delay`. A numeric delay increases linearly with the retry attempt number; the function argument `attempt` starts at `1`. The `RetryContext.delay` received by `shouldRetry` and `beforeRetry` is the final value after applying `Retry-After`, `maxDelay`, and jitter. `validateStatus` takes precedence over `throwHttpErrors`; statuses accepted by `validateStatus` or `throwHttpErrors: false` do not produce `ERR_BAD_RESPONSE` or trigger status-based retries.

Status-code policy precedence is request-level `retryOn`, request-level `retry.statusCodes`, client-level `retryOn`, client-level `retry.statusCodes`, and finally the built-in defaults. Prefer one form at each level. `respectRetryAfter` defaults to `true`: a valid `Retry-After` overrides local backoff, after which `maxDelay` remains the final cap, including jitter. Set it to `false` to ignore server-specified backoff.

A nonempty `retry.errorCodes` is an allowlist: only the listed error codes can be retried under the method and count policies, with no exception for `ERR_NETWORK` or timeouts. If omitted or empty, the default error policy applies. The allowlist can override an error's default `retryable: false`. The default policy does not retry `ERR_INVALID_STATUS_POLICY` thrown by a local status callback.

Every attempt, including retries, reenters the rate-limit queue, so automatic retries do not bypass `requestsPerInterval`. Retry hooks (`beforeRetry`) and response interceptors do not occupy a `maxConcurrent` slot while awaiting completion, so they can safely make requests such as token refreshes through the same client.

The same `X-Request-Id` is reused across retries. Once `totalTimeout` expires, no further retry begins; the request returns `ETIMEDOUT` even if retry attempts remain.

Pass an object for finer control:

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

`methods` explicitly adjusts the allowed methods, and `shouldRetry` can take over the default method, status, and error decisions. Retries use the method and body actually sent for the current attempt; the diagnostic `error.config` does not determine retry eligibility. External cancellations and nonreplayable `ReadableStream` request bodies are never retried, even if `shouldRetry` returns `true`.

## Interceptors

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
  // Log or recover from the error here; rethrow to preserve the retry policy.
  console.warn(error);
  throw error;
});
```

Request interceptors run in registration order; response interceptors run in reverse registration order. Request interceptor callbacks receive `AxiosHeaders`, with `.set()` and `.delete()` available directly. These are the request's final headers, so deleting a client default header prevents later merges from restoring it. `use` returns a numeric ID that can be passed to the corresponding manager's `eject` method to remove the interceptor. Interceptors belong only to the current client instance and do not modify global state.

## GET cache

```typescript
const cachedHttp = createHttpClient({
  baseURL: 'https://api.example.com',
  credentials: 'omit',
  cache: { ttl: 30_000 },
});

await cachedHttp.get('/catalog');
await cachedHttp.get('/catalog'); // Reuse the cache within its TTL.
await cachedHttp.get('/catalog', { bypassCache: true });

cachedHttp.clearCache();
```

Caching applies only to GET. After request interceptors run, the key is generated from the final URL, headers, response type, credentials, and Fetch behavior options, excluding automatically generated request IDs. The cache stores snapshots of response bytes. Each caller independently runs parsing, schema validation, transforms, and response interceptors; cache hits do not skip these steps. Network requests with the same key can be deduplicated, while each caller's cancellation, per-attempt timeout, and total timeout remain independent. The shared transport is canceled once all waiters leave.

Requests that may carry automatic cookies, including the default `same-origin` mode, must specify a session partition to use the result cache or share network requests. For public data, use `credentials: 'omit'`:

```typescript
await http.get('/me', {
  cache: { ttl: 5_000, partition: `session:${sessionVersion}` },
});
```

Change the partition on login, logout, or user switches, and call `clearCache()` to release old entries. SSR should create a request-scoped client. Explicit Authorization/Cookie headers also contribute to the key. The `credentials` string alone cannot distinguish sessions established by HttpOnly cookies.

`signal`, timeouts, and interceptors do not themselves disable caching. Complete-response APIs, raw Responses, request bodies, and request-level `maxBodySize`, upload/download progress, rate limiting, `dispatcher`, or `agent` still conservatively bypass sharing. Non-2xx responses and responses with `Cache-Control: no-store` or `Vary: *` are not retained as TTL entries. The client cache is not a complete browser HTTP cache.

Non-GET requests that are actually sent clear the current instance's cache, including requests changed from GET to POST during retries. They clear the cache even if response parsing or validation later fails. The cache lives in memory and is neither shared across instances nor persisted. `GetRequestCache` keeps at most 512 entries by default, does not retain individual entries larger than approximately 1 MB, and provides `prune()` to actively reclaim expired entries. Strings, Blobs, and binary values are estimated in bytes; binary views are counted using their entire underlying buffer. Map/Set values are estimated recursively, and objects whose size cannot be estimated are not retained. Invalidation metadata is also reclaimed.

### stale-while-revalidate response cache

Use `ResponseCache` directly for stale-while-revalidate or stale-if-error behavior. It is independent of the client GET cache and does not share its entries:

```typescript
import { ResponseCache } from '@nexusmc-cn/axnexus';

const cache = new ResponseCache<{ items: string[] }>({ maxEntries: 128 });
const data = await cache.getOrLoad('catalog', loadCatalog, {
  ttl: 30_000,
  staleWhileRevalidate: 120_000,
  staleIfError: true,
});
```

`maxEntries` limits the number of entries and defaults to `256`. Both writes and reads prefer `structuredClone`, falling back to a JSON clone, which may lose type information such as `Date` and `Map`. Values unsupported by both methods are returned by their original reference, so cached values should be treated as immutable. There is no public clone toggle.

When using `GetRequestCache` directly, `options.signal` cancels only the current caller's wait. Once all waiters leave, the signal passed to the shared loader is aborted. `ResponseCache` itself provides no per-caller cancellation option; the caller manages the loader's cancellation policy.

## SSR and one-off JSON requests

`fetchJson` is a lightweight JSON helper with no client instance state, suitable for SSR, middleware, and one-off requests. It supports an explicit `cookie`, an injected `fetch`, and a JSON parser. Its `headers` accepts the same `HeaderInput` as the main client, including `AxiosHeaders`; `maxBodySize` imposes no response body limit by default. Both `timeout` and `timeoutMs` are accepted, with `timeoutMs` taking precedence when both are supplied.

It follows native Fetch credential behavior. Explicitly pass `credentials: 'include'` when cross-origin credentials are needed in the browser, and use `cookie` to forward cookies on the server.

```typescript
import { fetchJson } from '@nexusmc-cn/axnexus';

const data = await fetchJson<{ ok: boolean }>('https://api.example.test/health', {
  cookie: request.headers.get('cookie') ?? undefined,
  timeout: 5_000,
});
```

Non-2xx responses return `null` by default, preserving existing behavior. Set `throwHttpErrors: true` to throw an `HttpError` containing the status and response. Successful JSON `null`, `204`, `205`, `HEAD`, `Content-Length: 0`, empty bytes, and whitespace-only responses still return `null`. A 304 returns `null` by default and is treated as non-2xx when throwing is enabled. Use `fetchJsonResult` when you need the status code and response metadata:

```typescript
import { fetchJsonResult } from '@nexusmc-cn/axnexus';

const result = await fetchJsonResult<{ ok: boolean }>('https://api.example.com/health', {
  timeout: 5_000,
});
if (result.status >= 400) {
  console.warn('upstream status:', result.status);
}
```

Nonempty successful responses are passed to `parseJson` (defaulting to `JSON.parse`); parsing failures throw `ERR_BAD_PAYLOAD`. Timeouts and external signal cancellation propagate as native `AbortError`, unlike the client's `ETIMEDOUT` / `ERR_CANCELED` error codes. The `response` returned by `fetchJsonResult` has already been consumed or canceled by the helper. Use the client's `responseType: 'response'` when you need the raw body.

## SSE and NDJSON

`./stream` incrementally decodes an unconsumed raw `Response` and returns an `AsyncIterable`. By default, `parseSSE` preserves string data and the `event`, `id`, and `retry` fields; `parseNDJSON` parses JSON line by line with a default type of `unknown`. Providing a `schema` validates each item and infers the output type. For JSON data in SSE, also explicitly configure `parseJson: JSON.parse`.

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

`maxMessageSize` defaults to `1 MiB` and limits each NDJSON record or entire SSE frame in UTF-8 bytes, including SSE fields and comments but excluding newline characters. It is independent of `maxBodySize`, which limits the whole response. `idleTimeout` limits the wait for the next response chunk; `0` or omission disables it, and time spent by the consumer processing messages is excluded. Parsing failures, validation failures, `break`, iterator `.return()`, and external `signal` cancellation all release the reader. `.return()` also interrupts a pending read or validation.

`connectSSE` connects only once by default. Reconnection must be explicitly enabled and supports only GET. `maxAttempts` includes the initial connection, and delays are capped by `maxDelay`; normal EOF does not trigger reconnection by default. Reconnection sends the last valid `Last-Event-ID`, which an empty id resets. HTTP 204 or `isComplete(event)` returning `true` ends the stream, and the completion event is not yielded. The server still needs to handle replay and deduplication; this does not guarantee exactly-once delivery. Ordinary request retries are disabled when connecting. Client response interceptors used with this entry point should preserve the unconsumed raw response. XHR is unsuitable for real-time SSE.

## Fetch bridge and oRPC

`createFetchHandler` from `./fetch` creates an SDK-injectable Fetch function backed by a dedicated client. It accepts only transport, headers, timeout, size-limit, rate-limit, and progress configuration. It disables axnexus retries and caching, leaving HTTP statuses and raw response bodies to the SDK. It does not accept schema, response transform, client plugin, or interceptor configuration.

When using oRPC, install `@orpc/client` in your application:

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

The bridge preserves the Request/init method, headers, signal, raw body, and `redirect: 'manual'`, without encoding JSON a second time or reading the response in advance. Transport failures retain axnexus's `HttpError` classification. Call `close()` after the application finishes using the transport to release resources such as persistent connections.

## Endpoint contracts

`defineEndpoint` from `./contracts` describes the method, relative path, query/body/output schemas, and a domain `errors` map. `{name}` path parameters are encoded as individual segments. Query and body values accept the schema's input type; network requests send its validated output. Path or input validation failures produce no network I/O.

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
  console.log('Existing user:', result.error.data.name);
}
```

You can also call `updateUser.call(http, input)` / `safeCall(http, input)` directly. `call` throws on failure; `safeCall` uses `kind` to distinguish `success`, `domain`, `http`, `transport`, and `unexpected`. A `DomainError` with a domain code and data is created only when both the status code and a declared error schema match. Undeclared statuses or mismatched error bodies remain HTTP errors. Domain codes are independent of `HttpErrorCode`.

The contract validates its own output and overrides the client's default schema and response transforms. Call-level or client-default `timeout` / `totalTimeout` establish a budget for the entire call, covering input validation, the network request, output validation, and domain-error validation. The external signal also covers these stages. Schema callbacks should stop their own internal asynchronous work; cancellation ends the caller's wait. The client's context type is preserved both before and after binding.

## Chunked uploads

`uploadChunks` accepts a `Uint8Array` and orchestrates chunking, concurrency, and aggregate progress. The caller provides the actual upload operation, allowing integration with multipart uploads, object storage, or custom chunk protocols:

```typescript
import { uploadChunks } from '@nexusmc-cn/axnexus';

const controller = new AbortController();
const parts = await uploadChunks(bytes, {
  chunkSize: 5 * 1024 * 1024,
  concurrency: 3,
  signal: controller.signal,
  retry: 2, // Allow 2 additional attempts per chunk.
  retryDelay: (attempt) => attempt * 200,
  onPartError: ({ part, attempt, error }) => reportPartFailure(part.index, attempt, error),
  onProgress: (loaded, total) => console.log(loaded / total),
  upload: ({ index, body, signal }) => putPart(index, body, { signal }),
});
```

`retry` applies only to failed chunks and does not reupload successful ones. `onPartError` receives every failure, including the final one, and the same orchestration `signal`. Retries reuse the same `body`, which the upload callback should not modify. `part.end` is the exclusive end offset.

Call `controller.abort()` to cancel. The orchestrator stops starting new chunks, ends retry waits, stops waiting for asynchronous callbacks, and throws a native `AbortError`. Callbacks must pass `part.signal` to the underlying request to cancel in-flight network operations. Results arriving after cancellation are neither added to the aggregate results nor reported as successful progress.

If a chunk ultimately fails, or `onPartError`, `retryDelay`, or `onProgress` throws, the overall Promise rejects and no new chunks are scheduled. Uploads already in flight are not automatically canceled or rolled back. The upload protocol is responsible for server cleanup, resumability, and assembly; upload callbacks should ensure idempotency by chunk ID. `onProgress` counts only bytes from successful chunks; an empty source emits no progress events.

`chunkSize` and `concurrency` are rounded down to positive integers, with nonfinite or nonpositive values falling back to `1`. Nonfinite or negative `retryDelay` values fall back to `0`. Perform any strict argument validation before calling the function.

## Request observability

### Context and plugins

`createHttpClient<TContext>()` preserves the local context type across configuration, interceptors, plugins, and optional integrations. Context is not automatically sent to the server, logged, or included in cache keys. Tenants, languages, or identities that affect the response must still be explicitly mapped to requests and cache partitions.

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

`plugins` are registered in configuration order, and `use()` returns an asynchronous detach function that can be called repeatedly. `setup(client)` runs synchronously once, can register interceptors, and can return a cleanup function. `close()` detaches plugins and releases adapter resources. When reusing a stateful plugin definition, use `create()` to create independent state for each client.

`onEvent` records events; its return value does not replace the request result. Synchronous exceptions and asynchronous rejections are isolated from request results, and requests do not wait for observation tasks to finish. Event config/context values retain their references; to modify requests, register interceptors through `setup`. Events distinguish logical requests, attempts, transports, cache hits/deduplication, and the start and end of `queue`, `retry`, and `body` phases. End-event `duration` is measured in milliseconds. Retry duration includes `beforeRetry` and the wait; its `attempt` is the upcoming retry number, starting at 1. The final request event for a raw stream is emitted on EOF, read failure, or cancellation.

### Automatic logging

An existing logger can be attached to the client's lifecycle automatically:

```typescript
import { createRequestLogger, attachRequestLogger, createRequestLoggerPlugin } from '@nexusmc-cn/axnexus';

const autoLogger = createRequestLogger((record) => console.info(record));
const detachLogger = attachRequestLogger(http, autoLogger);
// Or configure plugins: [createRequestLoggerPlugin(autoLogger)] at creation time.
await http.get('/health');
await detachLogger();
```

Automatic logging records one start and one end for each logical request, following the redaction rules below. End records summarize time spent queuing, waiting for retries, and consuming raw streams, along with the attempt count and cache reuse mode. A raw stream's log ends only after consumption finishes. You can still use the logger independently for manual records:

`createRequestLogger` represents request starts, completions, and errors in a consistent record format sent to an injectable sink. It redacts `authorization`, `cookie`, and `set-cookie` by default. `record`, `start`, `complete`, and `error` share the same input and redaction rules. `start` returns a single-use lifecycle handle that calculates duration using `options.now` (defaulting to `Date.now`):

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

`record(input)` writes a complete record directly, with the following fields:

| Field | Description |
| --- | --- |
| `phase` | `start`, `complete`, or `error` |
| `method` / `url` | Request method and URL; the method is normalized to uppercase |
| `headers` | Accepts `HeaderInput`; output is normalized and sensitive headers are redacted |
| `status` | Optional HTTP status code |
| `duration` | Milliseconds; lifecycle handles can calculate this automatically |
| `timings` | Cumulative `queue` and `retry` milliseconds from automatic logging; includes `body` when the raw body ends, measured from when the response is handed to the consumer |
| `attempts` / `cache` | Automatic-log attempt count, plus `hit` or `dedupe` when cache reuse occurs; attempts are not the same as actual network requests |
| `responseBytes` | Optional response size in bytes |
| `error` | Error summary with arbitrary extra fields removed and `HttpError.config.headers` redacted |

The handle returned by `start()` ends only its own lifecycle and records it once. Top-level `logger.complete()` and `logger.error()` are shortcuts for `record()` and do not end existing handles. `redactHeaders` adds sensitive headers. URLs, error messages, and `HttpError.config.url` filter sensitive query parameters such as token, access_token, key, api_key, secret, password, and signature by default, including encoded and repeated parameters; ordinary parameters are preserved. Add fields with `redactQueryParams: ['ticket']`, or use `redactError: (sanitizedError) => ...` to handle other sensitive content in domain errors.

### OpenTelemetry

Install `@opentelemetry/api` only when using `./opentelemetry`. The application configures the SDK/provider/exporter and supplies its own tracer. The plugin does not install a global provider or inject trace headers by default.

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

The plugin creates spans for logical requests and attempts, recording cache, transport, queuing, retry-wait, and stream-consumption events. End events record elapsed milliseconds as `axnexus.duration_ms`. By default, it records only method, status, duration, and error classification, omitting request URLs, headers, payloads, and context.

## TanStack Query

`./tanstack-query` provides `createQueryOptions`, `createInfiniteQueryOptions`, and `createMutationOptions`, preserving schema output and client context types. You can also bind a client with `createQueryIntegration(client)` and call `.query(input)`, `.mutation<S, Variables>(input)`, and `.infiniteQuery<Page, S>(input)`. Install Query v5's `@tanstack/query-core` in the application; the returned options can also be passed to the Query integration for your framework.

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

Query manages caching, retries, and invalidation. These options default to `retry: false`; explicitly configure retries at the Query layer when needed. The underlying axnexus request always disables retries and the GET cache, and the schema configured for that call validates the output. Query/infinite options combine Query's cancellation signal with `config.signal`, propagating cancellation from either to the underlying request. Mutation options also preserve `config.signal`.

Specify mutation variable types with the second generic; the response is inferred from the schema. Applications remain responsible for idempotency when enabling automatic retries. When the client has typed context and you need to specify Variables explicitly, use the bound factory above to avoid losing the client context type because TypeScript cannot infer only the remaining generics. Standalone factories remain suitable for calls with full inference.

`partition` is required for query/infinite options. Use nonsensitive session-version, tenant, and language identifiers, and switch partitions when identity changes. The default key includes the URL and ordinary query parameters; regular and infinite queries use separate namespaces. URLs/params containing credentials require an explicit nonsensitive `key`. Do not put tokens, Cookie, Authorization, or passwords in keys. Sensitive-field detection uses the logger's default list and recognizes encoded field names in URLs; callers must still avoid custom sensitive fields themselves. An explicit key replaces the URL/params portion, so callers must include all response-affecting filters, sorting, page sizes, and other partition conditions.

`createInfiniteQueryOptions` also requires `initialPageParam`, `params(pageParam)`, and `getNextPageParam`. Its key does not automatically expand the parameters function; callers must use an explicit `key` to distinguish fixed filters and pagination strategies. Each page's result is likewise inferred from the schema and includes possible `null`.

## CSRF

CSRF protection is not enabled by default. Use `createCsrfInterceptor` to inject a token reader:

```typescript
import { createCsrfInterceptor } from '@nexusmc-cn/axnexus';

const csrf = createCsrfInterceptor({
  readToken: () => getCsrfTokenFromYourStore(),
});

http.interceptors.request.use(csrf);
```

By default, it handles only `POST`, `PUT`, `PATCH`, and `DELETE`, trusting the browser's own origin and the origin of the client's `baseURL`. Explicitly allow legitimate cross-origin APIs with `allowedOrigins: ['https://api.example.com']`. The destination is checked again just before sending; if a later interceptor rewrites the URL to an external origin, the automatically injected token is removed. `credentials: 'omit'` does not control explicit headers and cannot replace origin validation.

The source of an automatic token is kept in private metadata; no internal marker is sent. If the reader returns no token, a retry removes the old one. Explicitly set headers take precedence, and callers are responsible for their destination scope. Requests carrying automatic tokens cannot follow redirects automatically (`redirect: 'error'`; explicit `manual` is preserved). Because XHR cannot control redirects, it rejects these requests with `ERR_UNSUPPORTED_ADAPTER`; use Fetch instead. Custom adapters should honor the `redirect` configuration.

## HTTP/2 and HTTP/3

Enable HTTP/2 through its separate entry point. The adapter reuses sessions by origin and marks complete responses with `protocol: 'h2'`. Node uses native `node:http2`; HTTP/2 through Bun's Node compatibility layer should be treated as experimental:

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

Each request has its own stream; an individual request's error, cancellation, or timeout closes only that stream. A session-level `error` or `close` ends active requests on that session and removes it from the reuse pool. After `GOAWAY`, new requests establish a new connection. Callers must still handle errors for each request separately.

Idle sessions have `unref()` called on them. To explicitly release transport resources held by the adapter, call:

```typescript
await nodeHttp.close();
```

Node HTTP/2 upload writes wait for `drain`, and downloads pause the underlying stream when the consumer cannot keep up. `ReadableStream` request bodies support cancellation during reading and are not automatically retried. The injected transport is responsible for HTTP/3 connection management and backpressure.

HTTP/3 is not tied to a specific QUIC implementation. Supply a `QuicTransport` to create an adapter from `@nexusmc-cn/axnexus/node-http3`:

```typescript
import { createHttp3Adapter } from '@nexusmc-cn/axnexus/node-http3';

const http3 = createHttpClient({ adapter: createHttp3Adapter(myQuicTransport) });
```

Without an injected transport, `ERR_UNSUPPORTED_ADAPTER` is thrown. The default entry point does not load Node built-in modules. The default Fetch adapter does not inspect the underlying protocol, so complete responses report `protocol: 'unknown'`.

### Bun runtime

The root entry point depends on standard Fetch, Headers, Response, ReadableStream, Blob, and AbortSignal. Bun support depends on these Web APIs and the compatibility of the selected adapter:

| Entry point/feature | Bun status | Notes |
| --- | --- | --- |
| `@nexusmc-cn/axnexus` | Standard Web APIs | Uses Bun's Fetch and related Web APIs |
| `@nexusmc-cn/axnexus/node-http2` | Experimental | Depends on Bun's `node:http2` compatibility layer; validate the TLS, ALPN, session reuse, and error-isolation scenarios you need before use |
| `@nexusmc-cn/axnexus/node-http3` | Injected transport required | The caller supplies a QUIC transport suitable for the current runtime |
| XHR adapter | Browser only | Returns `ERR_UNSUPPORTED_ADAPTER` when browser XHR is unavailable in Bun; no automatic polyfill |

The cross-runtime `RequestConfig` does not include Bun-specific Fetch options. For runtime-specific extensions, inject a custom fetch implementation through `createFetchAdapter`.

## Runtime differences

| Capability | Browser Fetch | Browser XHR | Node.js 20+ Fetch | Node.js HTTP/2 | Injected HTTP/3 |
| --- | --- | --- | --- | --- | --- |
| JSON, text, Blob, ArrayBuffer | Supported | Supported | Supported | Supported | Depends on transport |
| AbortSignal and timeouts | Supported | Supported | Supported | Supported | Depends on transport |
| Download progress | When the response body is readable | Supported | When the response body is readable | Supported | Depends on transport |
| Upload progress | Not guaranteed by standard Fetch | Supported via `xhr.upload` | Not guaranteed by standard Fetch | Implemented by the adapter | Depends on transport |
| HTTP/2 | Negotiated by the browser; not forced by the client | Negotiated by the browser | Not forced by the default Fetch adapter | `@nexusmc-cn/axnexus/node-http2` | Not applicable |
| HTTP/3 | Negotiated by the browser | Negotiated by the browser | Disabled by default | Not applicable | `@nexusmc-cn/axnexus/node-http3` + QUIC transport |

The default entry point does not load the Node.js HTTP/2 or HTTP/3 entry points.

## License

MIT
