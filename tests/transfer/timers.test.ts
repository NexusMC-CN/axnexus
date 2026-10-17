import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, uploadChunks } from '../../dist/index.js';
import { MAX_TIMER_DELAY } from '../../dist/core/lifecycle/timers.js';

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test('a long queue timeout does not expire immediately', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 1 });
  let finish!: () => void;
  const first = limiter.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  let settled = false;
  const queued = limiter.run(() => undefined, { queueTimeout: MAX_TIMER_DELAY + 100, signal: controller.signal });
  void queued.then(() => { settled = true; }, () => { settled = true; });
  try {
    await wait(20);
    assert.equal(settled, false);
  } finally {
    controller.abort();
    finish();
    await first;
    await assert.rejects(queued, { code: 'ERR_CANCELED' });
  }
});

test('long request-rate windows never pass an overflowing delay to the runtime', async () => {
  const delays: number[] = [];
  const nativeTimer = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
    delays.push(delay);
    return nativeTimer(callback, delay, ...args);
  }) as typeof setTimeout;
  const limiter = new RateLimiter({ requestsPerInterval: 1, interval: MAX_TIMER_DELAY + 100 });
  await limiter.run(() => undefined);
  const controller = new AbortController();
  const queued = limiter.run(() => undefined, { signal: controller.signal });
  void queued.catch(() => undefined);
  try {
    await wait(20);
    assert.ok(delays.length > 0);
    assert.ok(delays.every(delay => delay <= MAX_TIMER_DELAY));
  } finally {
    globalThis.setTimeout = nativeTimer;
    controller.abort();
    await assert.rejects(queued, { code: 'ERR_CANCELED' });
  }
});

test('a long chunk retry delay waits until canceled instead of retrying immediately', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = uploadChunks(new Uint8Array([1]), {
    chunkSize: 1,
    retry: 1,
    retryDelay: MAX_TIMER_DELAY + 100,
    signal: controller.signal,
    upload: async () => { attempts++; throw new Error('retry later'); },
  });
  void pending.catch(() => undefined);
  try {
    await wait(20);
    assert.equal(attempts, 1);
  } finally {
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
});
