import { strict as assert } from 'node:assert';
import test from 'node:test';
import { HttpError, RateLimiter } from '../../dist/index.js';

test('limits concurrent tasks and honors priority', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 1 });
  const order: string[] = [];
  const first = limiter.run(async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push('first-end');
  });
  const low = limiter.run(async () => order.push('low'), { priority: 1 });
  const high = limiter.run(async () => order.push('high'), { priority: 10 });
  await Promise.all([first, low, high]);
  assert.deepEqual(order, ['first-start', 'first-end', 'high', 'low']);
});

test('times out queued tasks', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 1 });
  const first = limiter.run(() => new Promise((resolve) => setTimeout(resolve, 30)));
  await assert.rejects(
    limiter.run(() => Promise.resolve(), { queueTimeout: 1 }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_RATE_LIMIT_QUEUE_TIMEOUT',
  );
  await first;
});

test('cancels queued tasks without starting them', async () => {
  const limiter = new RateLimiter({ maxConcurrent: 1 });
  const controller = new AbortController();
  const first = limiter.run(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const queued = limiter.run(() => Promise.resolve('started'), { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED');
  await first;
});

test('consumes bytes through a token bucket', async () => {
  const limiter = new RateLimiter({ bytesPerSecond: 1000 });
  const started = Date.now();
  await limiter.consume(1100);
  assert.equal(Date.now() - started >= 80, true);
});
