import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHttpClient, HttpError } from '../../dist/index.js';

test('client applies default rate limit to complete requests', async () => {
  let active = 0;
  let peak = 0;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response('{"ok":true}');
    },
  });
  await Promise.all([client.get('/one'), client.get('/two')]);
  assert.equal(peak, 1);
});

test('client request rate limit can override the default concurrency', async () => {
  let active = 0;
  let peak = 0;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return new Response('{"ok":true}');
    },
  });
  await Promise.all([
    client.get('/one', { rateLimit: { maxConcurrent: 2 } }),
    client.get('/two', { rateLimit: { maxConcurrent: 2 } }),
  ]);
  assert.equal(peak, 2);
});

test('request rate-limit overrides inherit the default cancellation signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let started = 0;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1, signal: controller.signal },
    adapter: async () => {
      started += 1;
      return new Response('{"ok":true}');
    },
  });

  await assert.rejects(
    client.get('/default-rate-limit-signal', { rateLimit: { maxConcurrent: 2 } }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
  assert.equal(started, 0);
});

test('cancels a request queued by the rateLimit signal', async () => {
  let started = 0;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async () => {
      started += 1;
      if (started === 1) {
        markFirstStarted();
        await firstDone;
      }
      return new Response('{"ok":true}');
    },
  });

  const first = client.get('/one');
  await firstStarted;
  const controller = new AbortController();
  const second = client.get('/two', { rateLimit: { signal: controller.signal } });
  controller.abort();

  await assert.rejects(
    Promise.race([
      second,
      new Promise((_, reject) => setTimeout(() => reject(new Error('queued request hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
  releaseFirst();
  await first;
  assert.equal(started, 1);
});
