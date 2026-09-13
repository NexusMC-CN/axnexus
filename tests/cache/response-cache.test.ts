import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCache } from '../../dist/cache/response-cache.js';

test('serves stale values while refreshing once', async () => {
  let loads = 0;
  const cache = new ResponseCache<string>({ now: () => Date.now() });
  const first = await cache.getOrLoad('catalog', async () => {
    loads += 1;
    return 'v1';
  }, { ttl: 1, staleWhileRevalidate: 1000 });
  assert.equal(first, 'v1');

  await new Promise((resolve) => setTimeout(resolve, 5));
  const values = await Promise.all([
    cache.getOrLoad('catalog', async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return 'v2';
    }, { ttl: 100, staleWhileRevalidate: 1000 }),
    cache.getOrLoad('catalog', async () => {
      loads += 1;
      return 'unexpected';
    }, { ttl: 100, staleWhileRevalidate: 1000 }),
  ]);

  assert.deepEqual(values, ['v1', 'v1']);
  assert.equal(loads, 2);
});

test('clear prevents an old in-flight load from repopulating the cache', async () => {
  let resolveLoad!: (value: string) => void;
  const cache = new ResponseCache<string>();
  const pending = cache.getOrLoad('catalog', () => new Promise<string>((resolve) => {
    resolveLoad = resolve;
  }), { ttl: 10_000 });

  cache.clear();
  resolveLoad('stale');
  assert.equal(await pending, 'stale');
  assert.equal(cache.size(), 0);
});

test('normalizes non-finite maxEntries and does not leak stale refresh rejections', async () => {
  const cache = new ResponseCache<string>({ maxEntries: Number.NaN });
  await cache.getOrLoad('one', async () => 'one', { ttl: 1_000 });
  await cache.getOrLoad('two', async () => 'two', { ttl: 1_000 });
  assert.equal(cache.size(), 2);

  let now = 0;
  const staleCache = new ResponseCache<string>({ now: () => now });
  await staleCache.getOrLoad('stale', async () => 'v1', { ttl: 1, staleWhileRevalidate: 100 });
  now = 2;
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(await staleCache.getOrLoad('stale', async () => { throw new Error('refresh failed'); }, { ttl: 1, staleWhileRevalidate: 100 }), 'v1');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, 0);
});

test('bounds entries and clones values on reads', async () => {
  const cache = new ResponseCache<{ items: number[] }>({ maxEntries: 1 });
  let firstLoads = 0;
  const first = await cache.getOrLoad('first', async () => {
    firstLoads += 1;
    return { items: [1] };
  }, { ttl: 10_000 });
  first.items.push(99);

  await cache.getOrLoad('second', async () => ({ items: [2] }), { ttl: 10_000 });
  const secondRead = await cache.getOrLoad('second', async () => ({ items: [3] }), { ttl: 10_000 });
  secondRead.items.push(99);
  const secondAgain = await cache.getOrLoad('second', async () => ({ items: [4] }), { ttl: 10_000 });

  assert.equal(cache.size(), 1);
  assert.deepEqual(secondAgain, { items: [2] });
  await cache.getOrLoad('first', async () => {
    firstLoads += 1;
    return { items: [5] };
  }, { ttl: 10_000 });
  assert.equal(firstLoads, 2);
});
