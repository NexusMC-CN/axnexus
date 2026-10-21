import { createHttpClient, type StandardSchema } from '../../src/index.js';
import { createQueryOptions, createMutationOptions, createInfiniteQueryOptions, createQueryIntegration } from '../../src/integrations/tanstack-query.js';
import { QueryClient } from '@tanstack/query-core';
import type { HttpPlugin } from '../../src/plugins/index.js';

declare const schema: StandardSchema<{ id: number }>;
const http = createHttpClient();
const query = new QueryClient();
const options = createQueryOptions(http, { url: '/items', partition: 'user-1', schema });
const fetched = query.fetchQuery(options);
const result: Promise<{ id: number } | null> = fetched;
// @ts-expect-error Schema output remains numeric.
const wrong: Promise<{ id: string }> = fetched;
const mutation = createMutationOptions<typeof schema, { name: string }>(http, { url: '/items', schema });
const output: Promise<{ id: number } | null> = mutation.mutationFn({ name: 'item' });
// @ts-expect-error Mutation variables are checked.
mutation.mutationFn({ name: 42 });
const infinite = createInfiniteQueryOptions(http, { url: '/items', partition: 'user-1', schema,
  initialPageParam: 0, params: page => ({ page }), getNextPageParam: (_last, _all, page) => page + 1,
});
query.fetchInfiniteQuery(infinite);
const plugin: HttpPlugin<{ tenant: string }> = {
  onEvent(event) { event.context?.tenant.toUpperCase(); },
};
const scoped = createHttpClient<{ tenant: string }>();
createQueryOptions(scoped, { url: '/items', partition: 'a', config: { context: { tenant: 'a' } } });
// @ts-expect-error Query integration retains the client context contract.
createQueryOptions(scoped, { url: '/items', partition: 'a', config: { context: { tenant: 42 } } });
createMutationOptions(scoped, { url: '/items', config: { context: { tenant: 'a' } } });
// @ts-expect-error Mutation integration retains client context.
createMutationOptions(scoped, { url: '/items', config: { context: { tenant: 42 } } });
createInfiniteQueryOptions(scoped, { url: '/items', partition: 'a', config: { context: { tenant: 'a' } },
  initialPageParam: 0, params: page => ({ page }), getNextPageParam: () => undefined,
});
// @ts-expect-error Infinite integration retains client context.
createInfiniteQueryOptions(scoped, { url: '/items', partition: 'a', config: { context: { tenant: 42 } }, initialPageParam: 0, params: page => ({ page }), getNextPageParam: () => undefined });
const bound = createQueryIntegration(scoped);
const boundQuery = bound.query<typeof schema>({ url: '/items', partition: 'a', schema, config: { context: { tenant: 'a' } } });
const boundResult: Promise<{ id: number } | null> = query.fetchQuery(boundQuery);
// @ts-expect-error Explicit schema generics retain bound context.
bound.query<typeof schema>({ url: '/items', partition: 'a', schema, config: { context: { tenant: 42 } } });
const boundMutation = bound.mutation<typeof schema, { name: string }>({ url: '/items', schema, config: { context: { tenant: 'a' } } });
const boundMutationResult: Promise<{ id: number } | null> = boundMutation.mutationFn({ name: 'ok' });
// @ts-expect-error Explicit variable types remain checked.
boundMutation.mutationFn({ name: 42 });
// @ts-expect-error Explicit schema and variable generics retain bound context.
bound.mutation<typeof schema, { name: string }>({ url: '/items', schema, config: { context: { tenant: 42 } } });
const boundInfinite = bound.infiniteQuery<number, typeof schema>({ url: '/items', partition: 'a', schema,
  config: { context: { tenant: 'a' } }, initialPageParam: 0, params: page => ({ page }), getNextPageParam: () => undefined,
});
query.fetchInfiniteQuery(boundInfinite);
// @ts-expect-error Explicit page and schema generics retain bound context.
bound.infiniteQuery<number, typeof schema>({ url: '/items', partition: 'a', schema, config: { context: { tenant: 42 } }, initialPageParam: 0, params: page => ({ page }), getNextPageParam: () => undefined });
void boundResult; void boundMutationResult;
scoped.use(plugin);
scoped.interceptors.request.use(config => {
  config.context?.tenant.toUpperCase();
  // @ts-expect-error Typed interceptors do not accept undeclared context fields.
  config.context?.account;
  return config;
});
scoped.get('/items', { context: { tenant: 'a' } });
// @ts-expect-error Request context has a checked shape.
scoped.get('/items', { context: { tenant: 42 } });
void result; void wrong; void output;
