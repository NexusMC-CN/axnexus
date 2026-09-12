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
