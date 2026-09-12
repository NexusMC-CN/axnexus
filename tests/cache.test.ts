import test from 'node:test';
import assert from 'node:assert/strict';
import { GetRequestCache } from '../dist/cache/get-cache.js';

test('deduplicates concurrent loads and clones cached values', async () => {
  const cache = new GetRequestCache('test-instance');
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return { items: [1] };
  };

  const [first, second] = await Promise.all([
    cache.getOrLoad('GET /items', 1000, loader),
    cache.getOrLoad('GET /items', 1000, loader),
  ]);
  (first as { items: number[] }).items.push(2);

  assert.equal(loads, 1);
  assert.deepEqual(second, { items: [1] });
  assert.deepEqual(await cache.getOrLoad('GET /items', 1000, loader), { items: [1] });
  assert.equal(loads, 1);
});

test('expires entries and clears the instance cache', async () => {
  const cache = new GetRequestCache('test-instance');
  let loads = 0;
  const loader = async () => ++loads;

  await cache.getOrLoad('GET /value', 5, loader);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await cache.getOrLoad('GET /value', 5, loader);
  cache.clear();
  await cache.getOrLoad('GET /value', 1000, loader);

  assert.equal(loads, 3);
});
