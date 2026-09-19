import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/index.js';

// End-to-end checks for the audit follow-ups, exercised through the public
// client rather than the interceptor manager in isolation.

test('e2e: a cancelled request is never revived by a response error interceptor', async () => {
  const controller = new AbortController();
  const client = createHttpClient({
    adapter: async () => {
      controller.abort();
      throw new Error('transport failed');
    },
  });

  // The handler may already be in flight when cancellation lands; what matters
  // is that its value cannot win. `raceWithSignal` in the attempt layer makes
  // the cancellation authoritative.
  client.interceptors.response.use(undefined, () => new Response('{"revived":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  await assert.rejects(
    client.get('/revive', { signal: controller.signal } as never),
    (error: unknown) => (error as { code?: string }).code === 'ERR_CANCELED',
  );
});

test('e2e: a response error interceptor still recovers a normal failure', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('nope', { status: 503 }),
  });
  // Error recoverers receive the HttpResponse wrapper, so returning a bare
  // Response is not a supported recovery shape; returning the wrapper is.
  client.interceptors.response.use(undefined, (error: never) => ({
    data: { ok: true },
    status: 200,
    response: (error as { response?: unknown })?.response,
  }) as never);

  assert.deepEqual(await client.get('/recover'), { ok: true });
});

test('e2e: a limited raw response keeps its url through the client', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('12345', {
      status: 200,
      headers: { 'content-length': '5' },
    }),
  });

  const response = await client.get('/raw', {
    responseType: 'response',
    maxBodySize: 10,
  } as never) as Response;

  assert.equal(response.status, 200);
  assert.equal(response.url, '');
  // The limit is lazy: consuming the stream must still enforce it.
  assert.equal(await response.text(), '12345');
});

test('e2e: a client-level maxBodySize null means unlimited', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('12345', { status: 200 }),
  });

  const response = await client.get('/unlimited', {
    responseType: 'response',
    maxBodySize: null,
  } as never) as Response;

  assert.equal(response instanceof Response, true);
  assert.equal(await response.text(), '12345');
});

test('issue 4: aborting after a raw response is returned cancels its pending body read', async () => {
  const requestController = new AbortController();
  let sourceCanceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
    },
    cancel() {
      sourceCanceled = true;
    },
  });
  const client = createHttpClient({
    adapter: async () => new Response(body, { status: 200 }),
  });

  const response = await client.get<Response>('/raw-abort', {
    responseType: 'response',
    signal: requestController.signal,
  } as never);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');

  const pendingRead = reader.read();
  requestController.abort(new DOMException('cancel raw response', 'AbortError'));
  try {
    await assert.rejects(
      Promise.race([
        pendingRead,
        new Promise((_, reject) => setTimeout(() => reject(new Error('raw body read did not abort')), 100)),
      ]),
      (error: unknown) => (error as { name?: string }).name === 'AbortError',
    );
    assert.equal(sourceCanceled, true, 'aborting the request must cancel the transport body');
  } finally {
    try { await reader.cancel(); } catch { /* already aborted */ }
  }
});

test('issue 4: cancelling a returned raw body cancels its transport source', async () => {
  let canceledWith: unknown;
  const client = createHttpClient({
    adapter: async () => new Response(new ReadableStream<Uint8Array>({
      cancel(reason) {
        canceledWith = reason;
      },
    }), { status: 200 }),
  });

  const response = await client.get<Response>('/raw-cancel', {
    responseType: 'response',
    maxBodySize: 1024,
  } as never);
  const reason = new Error('consumer stopped reading');
  await response.body!.cancel(reason);

  assert.equal(canceledWith, reason);
});
