import { strict as assert } from 'node:assert';
import test from 'node:test';
import { HttpError, readResponse } from '../../dist/index.js';

test('enforces max response body size before parsing', async () => {
  await assert.rejects(
    readResponse(new Response('12345'), 'text', 3),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_MAX_BODY_SIZE',
  );
});

test('treats omitted and invalid maxBodySize values as unlimited', async () => {
  const response = new Response('12345');
  assert.equal(await readResponse(response, 'text'), '12345');
  assert.equal(await readResponse(new Response('12345'), 'text', -1), '12345');
  assert.equal(await readResponse(new Response('12345'), 'text', Number.NaN), '12345');
  assert.equal(await readResponse(new Response('12345'), 'text', Number.POSITIVE_INFINITY), '12345');
});

test('treats all bodyless HTTP statuses as null responses', async () => {
  for (const status of [204, 205, 304]) {
    const response = new Response(null, { status });
    assert.equal(await readResponse(response, 'json'), null);
  }
});

test('treats a whitespace-only JSON response as an empty response', async () => {
  let parserCalls = 0;
  const value = await readResponse(new Response(' \n\t '), 'json', undefined, () => {
    parserCalls += 1;
    return JSON.parse('never');
  });
  assert.equal(value, null);
  assert.equal(parserCalls, 0);
});

test('releases the response body reader after buffering', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      controller.close();
    },
  }));
  assert.deepEqual(await readResponse(response, 'json'), { ok: true });
  const reader = response.body?.getReader();
  assert.ok(reader);
  reader.releaseLock();
});

test('consumes a late buffered-body rejection when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const response = {
    status: 200,
    headers: new Headers(),
    body: null,
    arrayBuffer: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('buffer failed after cancellation');
    },
  } as unknown as Response;
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      readResponse(response, 'text', undefined, undefined, controller.signal),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, 0);
});
