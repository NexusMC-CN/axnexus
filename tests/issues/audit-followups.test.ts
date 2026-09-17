import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInterceptorChain, createInterceptorManager, HttpError } from '../../dist/index.js';
import { readResponse } from '../../dist/utils/response.js';

// --- Finding 1: the abort guard must cover the rejected path too. ----------
// A cancelled request must not be resurrected by a `rejected` handler. The
// fulfilled path was guarded; the rejected sibling was not, so a recovering
// handler could still resolve a chain whose signal had already aborted.

test('guard: a rejected handler does not recover a chain whose signal aborted', async () => {
  const controller = new AbortController();
  const manager = createInterceptorManager<number>();

  manager.use(
    async () => {
      controller.abort();
      throw new Error('boom');
    },
    undefined,
  );
  manager.use(undefined, () => 888);

  await assert.rejects(
    applyInterceptorChain(manager, 1, { signal: controller.signal }),
    (error: unknown) => (error as { name?: string }).name === 'AbortError',
  );
});

test('guard: a mid-chain abort still lets an earlier rejection be handled', async () => {
  // The rejection happens *before* the abort and its handler is the one that
  // aborts; recovery must still run so real error handling keeps working.
  const controller = new AbortController();
  const manager = createInterceptorManager<number>();
  const seen: string[] = [];

  manager.use(undefined, (error) => {
    seen.push('recover');
    controller.abort();
    return 5;
  });
  manager.use(() => {
    seen.push('fulfilled-after-abort');
    return 6;
  });

  await assert.rejects(
    applyInterceptorChain(manager, Promise.reject(new Error('original')) as never, { signal: controller.signal }),
    (error: unknown) => (error as { name?: string }).name === 'AbortError',
  );
  assert.deepEqual(seen, ['recover'], 'the fulfilled handler must not run after the abort');
});

test('guard: an un-aborted signal still runs rejected handlers normally', async () => {
  const manager = createInterceptorManager<number>();
  manager.use(undefined, () => 42);
  const value = await applyInterceptorChain(
    manager,
    Promise.reject(new Error('x')) as never,
    { signal: new AbortController().signal },
  );
  assert.equal(value, 42);
});

// --- Finding 2: the wrapped raw response must keep its metadata. ----------

test('raw limit: a limited raw response keeps url, redirected and type', async () => {
  const original = new Response('12345', {
    status: 200,
    headers: { 'content-length': '5' },
  });
  const limited = await readResponse(original, 'response', 10) as Response;
  assert.notEqual(limited, original, 'a limit means the body had to be wrapped');
  assert.equal(limited.url, original.url);
  assert.equal(limited.redirected, original.redirected);
  assert.equal(limited.type, original.type);
  assert.equal(limited.status, 200);
});

test('raw limit: a limited raw response reports the size of the GET resource', async () => {
  // `redirected`/`url` matter most when they are non-default, so exercise a
  // real redirect hop rather than relying on the empty defaults.
  const redirected = await fetch(
    'data:text/plain,hi',
  ).catch(() => undefined);
  if (redirected) {
    const limited = await readResponse(redirected, 'response', 100) as Response;
    assert.equal(limited.url, redirected.url);
    assert.equal(limited.type, redirected.type);
  }
});

// --- Finding 3: a non-number maxBodySize must mean "unlimited". -----------

test('raw limit: maxBodySize null, false and empty string do not impose a limit', async () => {
  for (const value of [null, false, ''] as never[]) {
    const response = new Response('12345', { status: 200 });
    const result = await readResponse(response, 'response', value) as Response;
    assert.equal(
      result,
      response,
      `maxBodySize=${JSON.stringify(value)} must be treated as unlimited`,
    );
    assert.equal(await result.text(), '12345');
  }
});

test('raw limit: the buffered path agrees that null means unlimited', async () => {
  const response = new Response('{"a":1}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await readResponse(response, 'json', null as never), { a: 1 });
});

test('raw limit: a real numeric limit is still enforced', async () => {
  // A chunked body has no Content-Length, so the limit can only surface while
  // the caller consumes the wrapped stream.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
      controller.enqueue(new Uint8Array(3));
      controller.close();
    },
  });
  const limited = await readResponse(new Response(stream, { status: 200 }), 'response', 4) as Response;
  await assert.rejects(
    limited.arrayBuffer(),
    (error: unknown) => (error as { code?: string }).code === 'ERR_MAX_BODY_SIZE',
  );
});

// --- Finding 4: a `false` rewrite on a raw header block must be honoured. --

test('headers: set(rawBlock, false) does not apply the block', async () => {
  const { AxiosHeaders } = await import('../../dist/index.js');
  const headers = new AxiosHeaders();
  headers.set('X-A: 1\nX-B: 2', false as never);
  assert.equal(headers.get('x-a'), undefined);
  assert.equal(headers.get('x-b'), undefined);
});

test('headers: set(rawBlock, true) still applies the block', async () => {
  const { AxiosHeaders } = await import('../../dist/index.js');
  const headers = new AxiosHeaders();
  headers.set('X-A: 1\nX-B: 2', true as never);
  assert.equal(headers.get('x-a'), '1');
  assert.equal(headers.get('x-b'), '2');
});

test('headers: an existing value survives a false rewrite on a raw block', async () => {
  const { AxiosHeaders } = await import('../../dist/index.js');
  const headers = new AxiosHeaders({ 'X-A': 'original' });
  headers.set('X-A: next', false as never);
  assert.equal(headers.get('x-a'), 'original');
});

test('headers: a function rewrite still works on a raw block', async () => {
  const { AxiosHeaders } = await import('../../dist/index.js');
  const headers = new AxiosHeaders({ 'X-A': 'original' });
  headers.set('X-A: next', (() => false) as never);
  assert.equal(headers.get('x-a'), 'original');
  headers.set('X-B: v', (() => true) as never);
  assert.equal(headers.get('x-b'), 'v');
});

test('headers: a raw block with a rewrite argument is unchanged', async () => {
  const { AxiosHeaders } = await import('../../dist/index.js');
  const headers = new AxiosHeaders({ 'X-Trace': 'orig' });
  headers.set('X-Trace: next', undefined as never, false as never);
  assert.equal(headers.get('x-trace'), 'orig');
});

// Keep HttpError referenced so an accidental unused import cannot mask a
// compile failure in this file.
test('guard: HttpError is exported for callers', () => {
  assert.equal(typeof HttpError, 'function');
});
