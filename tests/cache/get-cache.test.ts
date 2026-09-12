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

test('rejects an already-aborted subscriber before a cached hit or load', async () => {
  const cache = new GetRequestCache('test');
  let calls = 0;
  const load = async () => {
    calls += 1;
    return { value: 'cached' };
  };
  await cache.getOrLoad('key', 1_000, load);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cache.getOrLoad('key', 1_000, load, { signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(calls, 1);
});

test('cancels only one subscriber while keeping a shared load available', async () => {
  const cache = new GetRequestCache('test');
  let calls = 0;
  let resolveLoad!: (value: { value: string }) => void;
  const load = () => {
    calls += 1;
    return new Promise<{ value: string }>((resolve) => {
      resolveLoad = resolve;
    });
  };
  const controller = new AbortController();
  const canceled = cache.getOrLoad('key', 1_000, load, { signal: controller.signal });
  const shared = cache.getOrLoad('key', 1_000, load);

  controller.abort();
  await assert.rejects(
    canceled,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  resolveLoad({ value: 'shared' });
  assert.deepEqual(await shared, { value: 'shared' });
  assert.equal(calls, 1);
});

test('expires only the subscriber waiting past its cache deadline', async () => {
  const cache = new GetRequestCache('test');
  let resolveLoad!: (value: string) => void;
  const load = () => new Promise<string>((resolve) => {
    resolveLoad = resolve;
  });
  const deadline = Date.now() + 5;
  const timedOut = cache.getOrLoad('key', 1_000, load, { deadline });
  const shared = cache.getOrLoad('key', 1_000, load);

  await assert.rejects(
    timedOut,
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
  resolveLoad('shared');
  assert.equal(await shared, 'shared');
});
