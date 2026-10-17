import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/index.js';
import { GetRequestCache } from '../../dist/cache/get-cache.js';
import { ResponseCache } from '../../dist/cache/response-cache.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('small binary views cannot retain an oversized backing buffer', async () => {
  for (const value of [
    new Uint8Array(new ArrayBuffer(2_000_000), 0, 1),
    new DataView(new ArrayBuffer(2_000_000), 0, 1),
  ]) {
    const cache = new GetRequestCache('backing-buffer');
    await cache.getOrLoad('x', 1000, async () => value);
    assert.equal(cache.size(), 0);
  }
});

test('snapshot hits rerun transforms and interceptors independently', async () => {
  let calls = 0;
  let hooks = 0;
  const client = createHttpClient({
    credentials: 'omit',
    cache: { ttl: 1000 },
    adapter: async () => {
      calls++;
      return new Response('{"n":2}');
    },
  });
  client.interceptors.response.use((r) => {
    hooks++;
    return r;
  });
  assert.equal(await client.get('/x', { transformResponse: (d) => (d as any).n * 2 }), 4);
  assert.equal(await client.get('/x', { transformResponse: (d) => (d as any).n * 3 }), 6);
  assert.equal(calls, 1);
  assert.equal(hooks, 2);
});

test('independent timeout subscribers share the network', async () => {
  let calls = 0;
  let networkSignal: AbortSignal | undefined;
  const client = createHttpClient({
    credentials: 'omit',
    cache: true,
    adapter: async (c) => {
      calls++;
      networkSignal = c.signal;
      await pause(40);
      return new Response('1');
    },
  });
  const a = client.get('/x', { timeout: 10 });
  const b = client.get('/x', { timeout: 200 });
  await assert.rejects(a, (e: any) => e.isTimeout);
  assert.equal(await b, 1);
  assert.equal(calls, 1);
  assert.equal(networkSignal?.aborted, false);
});

test('unpartitioned automatic credentials cannot cache', async () => {
  let calls = 0;
  const client = createHttpClient({
    credentials: 'include',
    cache: { ttl: 1000 },
    adapter: async () => new Response(String(++calls)),
  });
  assert.equal(await client.get('/x'), 1);
  assert.equal(await client.get('/x'), 2);
});

test('no-store response is not retained', async () => {
  let calls = 0;
  const client = createHttpClient({
    credentials: 'omit',
    cache: { ttl: 1000 },
    adapter: async () => new Response(String(++calls), { headers: { 'cache-control': 'no-store' } }),
  });
  await client.get('/x');
  await client.get('/x');
  assert.equal(calls, 2);
});

test('totalTimeout covers the initial interceptor', async () => {
  const client = createHttpClient({
    totalTimeout: 10,
    adapter: async () => new Response('1'),
  });
  client.interceptors.request.use(async (c) => {
    await pause(50);
    return c;
  });
  await assert.rejects(client.get('/x'), (e: any) => e.isTimeout);
});

test('oversized strings blobs and buffers are not retained', async () => {
  for (const value of ['x'.repeat(1_000_001), new Blob([new Uint8Array(1_000_001)]), new ArrayBuffer(1_000_001)]) {
    const cache = new GetRequestCache('test');
    await cache.getOrLoad('x', 1000, async () => value);
    assert.equal(cache.size(), 0);
  }
});

test('clearing known keys does not retain generation metadata', async () => {
  const cache = new ResponseCache();
  for (let i = 0; i < 100; i++) {
    await cache.getOrLoad(String(i), async () => i);
    cache.clear(String(i));
  }
  assert.equal((cache as any).keyGenerations?.size ?? 0, 0);
});

test('all subscribers leaving aborts shared transport and cancels late response', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let signal: AbortSignal | undefined;
  let canceled = 0;
  let releases = 0;
  let finish!: (r: Response) => void;
  const adapter = Object.assign(async (c: any) => {
    signal = c.signal;
    started();
    return await new Promise<Response>((resolve) => { finish = resolve; });
  }, {
    releaseStream: () => {
      releases++;
    },
  });
  const client = createHttpClient({
    credentials: 'omit',
    cache: true,
    adapter,
  });
  const a = new AbortController();
  const b = new AbortController();
  const p = client.get('/x', { signal: a.signal });
  const q = client.get('/x', { signal: b.signal });
  await ready;
  await pause(0);
  a.abort();
  await assert.rejects(p);
  assert.equal(signal?.aborted, false);
  assert.equal(releases, 0);
  b.abort();
  await assert.rejects(q);
  assert.equal(signal?.aborted, true);
  finish(new Response(new ReadableStream({
    cancel() {
      canceled++;
    },
  })));
  await pause(0);
  assert.equal(canceled, 1);
  assert.equal(releases, 1);
});

test('retry rewriting GET to POST invalidates earlier GET snapshots', async () => {
  let version = 1;
  let trigger = 0;
  const client = createHttpClient({
    credentials: 'omit',
    cache: { ttl: 1000 },
    retry: 1,
    adapter: async (c) => {
      if (c.url === '/catalog') return new Response(String(version));
      if (c.method === 'POST') {
        version++;
        return new Response('true');
      }
      return new Response('false', { status: 503 });
    },
  });
  assert.equal(await client.get('/catalog'), 1);
  client.interceptors.request.use((c) => c.url === '/trigger' && ++trigger > 1 ? { ...c, method: 'POST' } : c);
  await client.get('/trigger');
  assert.equal(await client.get('/catalog'), 2);
});

test('partition and explicit authorization isolate snapshots', async () => {
  let calls = 0;
  const client = createHttpClient({
    credentials: 'include',
    adapter: async () => new Response(String(++calls)),
  });
  for (const partition of ['a', 'b']) {
    assert.equal(await client.get('/x', { cache: { ttl: 1000, partition } }), calls);
    assert.equal(await client.get('/x', { cache: { ttl: 1000, partition } }), calls);
  }
  assert.equal(calls, 2);
  await client.get('/x', {
    cache: { ttl: 1000, partition: 'a' },
    headers: { authorization: 'Bearer changed' },
  });
  assert.equal(calls, 3);
});

test('shared error response leaves retry policy to each subscriber', async () => {
  let calls = 0;
  const client = createHttpClient({
    credentials: 'omit',
    cache: true,
    adapter: async () => {
      const call = ++calls;
      await pause(5);
      return new Response(call === 1 ? 'false' : 'true', { status: call === 1 ? 503 : 200 });
    },
  });
  const results = await Promise.allSettled([client.get('/x', { retry: 0 }), client.get('/x', { retry: 1 })]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(calls, 2);
});

test('cache hit independently parses and validates schema', async () => {
  let calls = 0;
  const client = createHttpClient({
    credentials: 'omit',
    cache: { ttl: 1000 },
    adapter: async () => {
      calls++;
      return new Response('{"n":2}');
    },
  });
  assert.deepEqual(await client.get('/x'), { n: 2 });
  assert.equal(await client.get('/x', { parseJson: () => 7 }), 7);
  await assert.rejects(client.get('/x', {
    schema: {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'no' }] }),
      },
    },
  }), (e: any) => e.code === 'ERR_SCHEMA_VALIDATION');
  assert.equal(calls, 1);
});

test('Vary star and unsuccessful HTTP responses are never retained', async () => {
  for (const init of [{ headers: { vary: 'Accept, *' } }, { status: 503 }]) {
    let calls = 0;
    const client = createHttpClient({
      credentials: 'omit',
      cache: { ttl: 1000 },
      throwHttpErrors: false,
      adapter: async () => new Response(String(++calls), init),
    });
    await client.get('/x');
    await client.get('/x');
    assert.equal(calls, 2);
  }
});

test('collection payloads and opaque objects respect the retention bound', async () => {
  const large = 'x'.repeat(1_000_001);
  class Opaque {
    payload = large;
  }
  const oversized = [
    new Map([[large, 'value']]),
    new Map([['key', large]]),
    new Set([large]),
    new Opaque(),
    new Request('https://example.test'),
    new Response('small'),
  ];
  for (const value of oversized) {
    const cache = new GetRequestCache('test');
    await cache.getOrLoad('x', 1000, async () => value);
    assert.equal(cache.size(), 0, value.constructor.name);
  }
  for (const value of [{ value: 1 }, new Map([['key', 1]]), new Set([1]), new Date(), /small/gi]) {
    const cache = new GetRequestCache('test');
    await cache.getOrLoad('x', 1000, async () => value);
    assert.equal(cache.size(), 1, value.constructor.name);
  }
});
