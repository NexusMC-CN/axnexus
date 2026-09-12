import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createFetchAdapter } from '../../dist/index.js';

test('fetch adapter reports download progress from response stream', async () => {
  const originalFetch = globalThis.fetch;
  const events: number[] = [];
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  }), { headers: { 'content-length': '3' } });
  try {
    const response = await createFetchAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(),
      onDownloadProgress: (event) => events.push(event.loaded),
    } as never);
    await response.arrayBuffer();
    assert.deepEqual(events, [2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch adapter emits one completed event when response body is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const events: number[] = [];
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await createFetchAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(),
      onDownloadProgress: (event) => events.push(event.loaded),
    } as never);
    assert.deepEqual(events, [0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch download byte throttling observes request abort', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array([1, 2])); stream.close(); },
  }));
  try {
    const response = await createFetchAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(), signal: controller.signal,
      rateLimit: { bytesPerSecond: 1 }, rateLimiter: new (await import('../../dist/transfer/rate-limiter.js')).RateLimiter(),
    } as never);
    const pending = response.arrayBuffer();
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 100))]), (error: unknown) => {
      return error instanceof Error && (error as { code?: string }).code === 'ERR_CANCELED';
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
