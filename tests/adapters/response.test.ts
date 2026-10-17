import { strict as assert } from 'node:assert';
import test from 'node:test';
import { HttpError, readResponse } from '../../dist/index.js';

test('enforces max response body size before parsing', async () => {
  await assert.rejects(
    readResponse(new Response('12345'), 'text', 3),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_MAX_BODY_SIZE',
  );
});

test('only omitted maxBodySize is unlimited; invalid explicit values reject', async () => {
  assert.equal(await readResponse(new Response('12345'), 'text'), '12345');
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(readResponse(new Response('12345'), 'text', value),
      (error: unknown) => error instanceof HttpError && error.code === 'ERR_INVALID_CONFIG');
  }
});

test('treats all bodyless HTTP statuses as absent payloads', async () => {
  for (const status of [204, 205, 304]) {
    const response = new Response(null, { status });
    // `undefined` means "no payload at all", which is distinct from a JSON
    // `null` body that schema validation must still see.
    assert.equal(await readResponse(response, 'json'), undefined);
  }
});

test('treats a whitespace-only JSON response as an absence of payload', async () => {
  let parserCalls = 0;
  const value = await readResponse(new Response(' \n\t '), 'json', undefined, () => {
    parserCalls += 1;
    return JSON.parse('never');
  });
  assert.equal(value, undefined);
  assert.equal(parserCalls, 0);
});

test('distinguishes a JSON null payload from an absent payload', async () => {
  assert.equal(await readResponse(new Response('null'), 'json'), null);
});

test('issue 4: releases the response body reader after buffering', async () => {
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
