import type { DataTag, FetchQueryOptions, InfiniteData, InfiniteQueryObserverOptions, MutationOptions, QueryFunctionContext } from '@tanstack/query-core';
import type { HttpClient, QueryParams, RequestConfig } from '../core/types.js';
import type { InferSchemaOutput, StandardSchema } from '../core/schema.js';
import { combineSignals } from '../utils/signal.js';
import { isSensitiveQueryName } from '../utils/sensitive-query.js';

type Schema = StandardSchema<any, any>;
type Output<S> = S extends Schema ? InferSchemaOutput<S> | null : unknown;
type Key = readonly unknown[];
type ClientContext<Client> = Client extends HttpClient<infer Context, any> ? Context : unknown;
type IntegrationConfig<TContext = unknown> = Omit<RequestConfig<TContext>, 'url' | 'method' | 'params' | 'data' | 'body' | 'schema' | 'transformResponse' | 'responseType' | 'cache' | 'retry' | 'retryUnsafeMethods'>;

export interface QueryOptionsInput<S extends Schema | undefined = undefined, TContext = unknown> {
  url: string;
  /** Non-secret session/tenant/locale namespace. Change it when identity changes. */
  partition: string | readonly (string | number | boolean | null)[];
  /** Supply a non-secret key when the URL itself contains credentials. */
  key?: Key;
  params?: QueryParams;
  schema?: S;
  config?: IntegrationConfig<TContext>;
}

export interface QueryOptionsResult<S extends Schema | undefined = undefined> {
  queryKey: DataTag<Key, Output<S>, Error>;
  retry: false;
  queryFn(context: QueryFunctionContext<Key>): Promise<Output<S>>;
}

function queryKey(input: Pick<QueryOptionsInput<Schema | undefined>, 'url' | 'partition' | 'key'>, params: unknown, kind: 'query' | 'infinite'): Key {
  if (input.partition === undefined) throw new TypeError('Query partition is required');
  if (!input.key) {
    const url = new URL(input.url, 'http://axnexus.invalid');
    if (url.username || url.password || [...url.searchParams.keys()].some(isSensitiveQueryName)) {
      throw new TypeError('Credential-bearing URLs require an explicit non-secret query key');
    }
    if (params && typeof params === 'object' && Object.keys(params).some(isSensitiveQueryName)) {
      throw new TypeError('Credential-bearing parameters require an explicit non-secret query key');
    }
  }
  return ['axnexus', kind, input.partition, ...(input.key ?? [input.url, params ?? null])];
}

function request(client: HttpClient<any, any>, url: string, config: RequestConfig, signal?: AbortSignal): Promise<unknown> {
  // The integration owns decoding and policy. The final schema is applied by core.
  const call = client.request as (url: string, config: RequestConfig) => Promise<unknown>;
  const combined = combineSignals([config.signal, signal]);
  return call(url, { ...config, signal: combined.signal, retry: 0, retryUnsafeMethods: false, cache: false,
    transformResponse: [], responseType: 'json',
  }).finally(combined.cleanup);
}

export function createQueryOptions<S extends Schema | undefined = undefined, Client extends HttpClient<any, any> = HttpClient>(client: Client, input: QueryOptionsInput<S, NoInfer<ClientContext<Client>>>): QueryOptionsResult<S> {
  const key = queryKey(input, input.params, 'query') as DataTag<Key, Output<S>, Error>;
  return {
    queryKey: key,
    retry: false as const,
    queryFn: ({ signal }: QueryFunctionContext<Key>) => request(client, input.url, {
      ...input.config, method: 'GET', params: input.params, schema: input.schema,
    }, signal) as Promise<Output<S>>,
  } satisfies FetchQueryOptions<Output<S>, Error, Output<S>, Key>;
}

export interface MutationOptionsInput<S extends Schema | undefined = undefined, TContext = unknown> {
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  schema?: S;
  config?: IntegrationConfig<TContext>;
}

export function createMutationOptions<S extends Schema | undefined = undefined, Variables = unknown, Client extends HttpClient<any, any> = HttpClient>(
  client: Client, input: MutationOptionsInput<S, NoInfer<ClientContext<Client>>>,
): MutationOptions<Output<S>, Error, Variables> & { retry: false; mutationFn: (data: Variables) => Promise<Output<S>> } {
  return {
    retry: false,
    mutationFn: data => request(client, input.url, {
      ...input.config, method: input.method ?? 'POST', data, schema: input.schema,
    }) as Promise<Output<S>>,
  };
}

export interface InfiniteQueryOptionsInput<Page, S extends Schema | undefined = undefined, TContext = unknown> extends Omit<QueryOptionsInput<S, TContext>, 'params'> {
  initialPageParam: Page;
  params(page: Page): QueryParams;
  getNextPageParam(last: Output<S>, all: Output<S>[], lastPage: Page, allPages: Page[]): Page | undefined | null;
}

export interface InfiniteQueryOptionsResult<Page, S extends Schema | undefined = undefined> {
  queryKey: DataTag<Key, InfiniteData<Output<S>, Page>, Error>;
  retry: false;
  initialPageParam: Page;
  getNextPageParam(last: Output<S>, all: Output<S>[], lastPage: Page, allPages: Page[]): Page | undefined | null;
  queryFn(context: QueryFunctionContext<Key, Page>): Promise<Output<S>>;
}

export function createInfiniteQueryOptions<Page, S extends Schema | undefined = undefined, Client extends HttpClient<any, any> = HttpClient>(
  client: Client, input: InfiniteQueryOptionsInput<Page, S, NoInfer<ClientContext<Client>>>,
): InfiniteQueryOptionsResult<Page, S> {
  const key = queryKey(input, null, 'infinite') as DataTag<Key, InfiniteData<Output<S>, Page>, Error>;
  return {
    queryKey: key,
    retry: false as const,
    initialPageParam: input.initialPageParam,
    getNextPageParam: input.getNextPageParam,
    queryFn: ({ signal, pageParam }: QueryFunctionContext<Key, Page>) => request(client, input.url, {
      ...input.config, method: 'GET', params: input.params(pageParam as Page), schema: input.schema,
    }, signal) as Promise<Output<S>>,
  } satisfies InfiniteQueryObserverOptions<Output<S>, Error, InfiniteData<Output<S>, Page>, Key, Page>;
}

/** Bind context once, retaining it when callers explicitly specify schema/variable types. */
export function createQueryIntegration<Client extends HttpClient<any, any>>(client: Client) {
  type Context = ClientContext<Client>;
  return {
    query: <S extends Schema | undefined = undefined>(input: QueryOptionsInput<S, Context>): QueryOptionsResult<S> =>
      createQueryOptions<S, Client>(client, input),
    mutation: <S extends Schema | undefined = undefined, Variables = unknown>(input: MutationOptionsInput<S, Context>) =>
      createMutationOptions<S, Variables, Client>(client, input),
    infiniteQuery: <Page, S extends Schema | undefined = undefined>(input: InfiniteQueryOptionsInput<Page, S, Context>): InfiniteQueryOptionsResult<Page, S> =>
      createInfiniteQueryOptions<Page, S, Client>(client, input),
  };
}
