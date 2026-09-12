import { strict as assert } from 'node:assert';
import test from 'node:test';
import { GetRequestCache } from '../../dist/cache/get-cache.js';

test('modular cache entry keeps generation invalidation behavior', async () => {
  const cache = new GetRequestCache('test');
  let calls = 0;
  const load = () => { calls += 1; return Promise.resolve({ calls }); };
  assert.deepEqual(await cache.getOrLoad('key', 1000, load), { calls: 1 });
  assert.deepEqual(await cache.getOrLoad('key', 1000, load), { calls: 1 });
  assert.equal(calls, 1);
  cache.clear();
  assert.deepEqual(await cache.getOrLoad('key', 1000, load), { calls: 2 });
});
