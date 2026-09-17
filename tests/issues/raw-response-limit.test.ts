import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/index.js';
import { readResponse } from '../../dist/utils/response.js';

// #29 — `responseType: 'response'` must not silently ignore maxBodySize.
test('issue 29: a raw response with an oversized Content-Length is rejected', async () => {
  const response = new Response('12345', {
    status: 200,
    headers: { 'content-length': '5' },
  });
  await assert.rejects(
    readResponse(response, 'response', 3),
    (error: unknown) => (error as { code?: string }).code === 'ERR_MAX_BODY_SIZE',
  );
});

test('issue 29: a raw response without a declared length is limited while consumed', async () => {
  // A chunked body has no Content-Length, so the limit must apply on read.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('123'));
      controller.enqueue(new TextEncoder().encode('456'));
      controller.close();
    },
  });
  const response = new Response(stream, { status: 200 });
  const limited = await readResponse(response, 'response', 4) as Response;
  assert.equal(limited instanceof Response, true);

  await assert.rejects(
    limited.arrayBuffer(),
    (error: unknown) => (error as { code?: string }).code === 'ERR_MAX_BODY_SIZE',
  );
});

test('issue 29: a raw response within maxBodySize still reads fully', async () => {
  const response = new Response('12345', {
    status: 200,
    headers: { 'content-length': '5' },
  });
  const limited = await readResponse(response, 'response', 5) as Response;
  const text = await limited.text();
  assert.equal(text, '12345');
});

test('issue 29: the client rejects an oversized raw response', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('12345', { status: 200, headers: { 'content-length': '5' } }),
  });
  await assert.rejects(
    client.get('/raw', { responseType: 'response', maxBodySize: 3 } as never),
    (error: unknown) => (error as { code?: string }).code === 'ERR_MAX_BODY_SIZE',
  );
});

test('issue 29: an unlimited raw response is returned untouched', async () => {
  const original = new Response('12345', { status: 200 });
  const result = await readResponse(original, 'response');
  // Without a limit there is no reason to wrap the body.
  assert.equal(result, original);
});
