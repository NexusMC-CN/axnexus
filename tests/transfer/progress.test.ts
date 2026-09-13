import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ProgressTracker, RateLimiter, trackReadableStream } from '../../dist/index.js';

test('calculates progress rate and final percent', async () => {
  const events: Array<{ loaded: number; percent?: number }> = [];
  const tracker = new ProgressTracker({ phase: 'download', total: 10, onProgress: (event) => events.push(event) });
  tracker.update(4, 1000);
  tracker.update(10, 2000);
  tracker.complete(2000);
  assert.equal(events.at(-1)?.loaded, 10);
  assert.equal(events.at(-1)?.percent, 100);
  assert.equal(events.at(-1)?.rate, 6);
});

test('does not invent percent for unknown total', () => {
  const events: Array<{ percent?: number }> = [];
  const tracker = new ProgressTracker({ phase: 'download', onProgress: (event) => events.push(event) });
  tracker.update(4, 1000);
  tracker.complete(1500);
  assert.equal('percent' in events[0], false);
});

test('tracks bytes through a readable stream', async () => {
  const events: number[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const tracked = trackReadableStream(stream, { phase: 'download', total: 3, onProgress: (event) => events.push(event.loaded) });
  const reader = tracked.getReader();
  while (!(await reader.read()).done) {}
  assert.deepEqual(events, [2, 3]);
});

test('cancels byte throttling when the tracked stream signal aborts', async () => {
  const controller = new AbortController();
  const limiter = new RateLimiter({ bytesPerSecond: 1 });
  await limiter.consume(1);
  const stream = new ReadableStream<Uint8Array>({
    start(source) {
      source.enqueue(new Uint8Array([1]));
      source.close();
    },
  });
  const tracked = trackReadableStream(stream, {
    phase: 'download',
    rateLimiter: limiter,
    rateLimit: { bytesPerSecond: 1 },
    signal: controller.signal,
  });
  const reader = tracked.getReader();
  const pending = reader.read();
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(
    Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 100))]),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'ERR_CANCELED',
  );
});

test('progress tracker does not emit after its signal aborts', () => {
  const controller = new AbortController();
  const events: number[] = [];
  const tracker = new ProgressTracker({
    phase: 'download', total: 10, signal: controller.signal,
    onProgress: (event) => events.push(event.loaded),
  });
  controller.abort();
  assert.equal(tracker.update(5), undefined);
  assert.equal(tracker.complete(), undefined);
  assert.deepEqual(events, []);
});

test('tracked stream cancels a pending reader when its signal aborts', async () => {
  const controller = new AbortController();
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  });
  const tracked = trackReadableStream(source, { phase: 'download', signal: controller.signal });
  const pending = tracked.getReader().read();
  controller.abort();
  await assert.rejects(
    Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('stream hung')), 100))]),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(canceled, true);
});

test('tracked stream observes a signal supplied through rateLimit options', async () => {
  const controller = new AbortController();
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
  });
  const tracked = trackReadableStream(source, {
    phase: 'download',
    rateLimiter: new RateLimiter({ bytesPerSecond: 1 }),
    rateLimit: { bytesPerSecond: 1, signal: controller.signal },
  });
  const pending = tracked.getReader().read();
  controller.abort();
  await assert.rejects(
    Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('stream hung')), 100))]),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});
