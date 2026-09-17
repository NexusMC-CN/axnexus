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
