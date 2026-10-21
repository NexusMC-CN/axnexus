import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/query-core';
import { createHttpClient } from '../../dist/index.js';
import { createQueryOptions, createMutationOptions, createInfiniteQueryOptions } from '../../dist/integrations/tanstack-query.js';

test('Query invalidation reaches transport and owns cache and retry', async () => {
  let calls = 0;
  const http = createHttpClient({ cache: { ttl: 60_000 }, credentials: 'omit', retry: 3,
    adapter: async () => new Response(JSON.stringify({ calls: ++calls })),
  });
  const query = new QueryClient();
  const options = createQueryOptions(http, { url: 'https://example.test/data', partition: ['user-a', 'zh-CN'] });
  assert.equal(options.retry, false);
  assert.deepEqual(await query.fetchQuery(options), { calls: 1 });
  await query.invalidateQueries({ queryKey: options.queryKey });
  assert.deepEqual(await query.fetchQuery(options), { calls: 2 });
  const other = createQueryOptions(http, { url: 'https://example.test/data', partition: ['user-b', 'zh-CN'] });
  assert.notDeepEqual(other.queryKey, options.queryKey);
  query.clear();
  await http.close();
});

test('Query cancellation reaches adapter and mutation options disable replay', async () => {
  let canceled = false;
  let started!: () => void;
  const pending = new Promise<void>(resolve => started = resolve);
  const http = createHttpClient({ adapter: async config => {
    started();
    return new Promise((_resolve, reject) => config.signal!.addEventListener('abort', () => {
      canceled = true; reject(config.signal!.reason);
    }, { once: true }));
  } });
  const query = new QueryClient();
  const options = createQueryOptions(http, { url: 'https://example.test/wait', partition: 'a' });
  const result = query.fetchQuery(options).catch(error => error);
  await pending;
  await query.cancelQueries({ queryKey: options.queryKey });
  await result;
  assert.equal(canceled, true);
  const mutation = createMutationOptions(http, { url: 'https://example.test/write', method: 'POST' });
  assert.equal(mutation.retry, false);
  assert.equal(typeof mutation.mutationFn, 'function');
  const pages = createInfiniteQueryOptions(http, { url: 'https://example.test/pages', partition: 'a', initialPageParam: 0,
    getNextPageParam: (_last, _all, page: number) => page + 1, params: (page: number) => ({ page }),
  });
  assert.equal(pages.initialPageParam, 0);
  query.clear();
  await http.close();
});

test('ordinary and infinite queries cannot reuse incompatible cached shapes', () => {
  const http = createHttpClient();
  const ordinary = createQueryOptions(http, { url: '/items', partition: 'a' });
  const infinite = createInfiniteQueryOptions(http, { url: '/items', partition: 'a', initialPageParam: 0,
    params: page => ({ page }), getNextPageParam: () => undefined,
  });
  assert.notDeepEqual(ordinary.queryKey, infinite.queryKey);
});

test('credential parameters require an explicit key and never enter it implicitly', () => {
  const http = createHttpClient();
  assert.throws(() => createQueryOptions(http, { url: '/items', partition: 'a', params: { access_token: 'private-secret' } }), TypeError);
  for (const name of ['client_secret', 'id_token', 'signature', 'sessionid', 'csrf_token']) {
    assert.throws(() => createQueryOptions(http, { url: '/items', partition: 'a', params: { [name]: 'private-secret' } }), TypeError);
  }
  assert.throws(() => createQueryOptions(http, { url: '/items?%61ccess_token=private-secret', partition: 'a' }), TypeError);
  const options = createQueryOptions(http, { url: '/items', partition: 'a', key: ['items'], params: { access_token: 'private-secret' } });
  assert(!JSON.stringify(options.queryKey).includes('private-secret'));
});

test('query and infinite options preserve explicit request cancellation', async () => {
  let calls = 0;
  const http = createHttpClient({ adapter: async () => { calls++; return new Response('{}'); } });
  const query = new QueryClient();
  const canceled = AbortSignal.abort(new Error('Canceled by caller'));
  const ordinary = createQueryOptions(http, { url: '/items', partition: 'a', config: { signal: canceled } });
  const infinite = createInfiniteQueryOptions(http, { url: '/items', partition: 'a', config: { signal: canceled },
    initialPageParam: 0, params: page => ({ page }), getNextPageParam: () => undefined,
  });
  await assert.rejects(query.fetchQuery(ordinary), error => error.code === 'ERR_CANCELED');
  await assert.rejects(query.fetchInfiniteQuery(infinite), error => error.code === 'ERR_CANCELED');
  assert.equal(calls, 0);
  query.clear();
  await http.close();
});
