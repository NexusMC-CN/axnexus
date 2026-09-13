import { strict as assert } from 'node:assert';
import test from 'node:test';
import { HttpError } from '../../dist/index.js';
import { createHttp3Adapter } from '../../dist/adapters/node-http3.js';

test('http3 adapter requires an injected transport', () => {
  assert.throws(() => createHttp3Adapter(), (error: unknown) => error instanceof HttpError && error.code === 'ERR_UNSUPPORTED_ADAPTER');
});

test('http3 adapter marks injected transport responses as h3', async () => {
  const adapter = createHttp3Adapter({
    request: async () => ({ status: 204, headers: { 'x-protocol': 'h3' }, body: '' }),
  });
  const result = await adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  assert.equal(result.metadata?.protocol, 'h3');
  assert.equal(result.response.status, 204);
});

test('http3 adapter returns null bodies for every bodyless status', async () => {
  for (const status of [204, 205, 304]) {
    const adapter = createHttp3Adapter({
      request: async () => ({ status, body: 'must-not-be-used' }),
    });
    const result = await adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
    assert.equal(result.response.status, status);
    assert.equal(result.response.body, null);
  }
});

test('http3 adapter cancels an injected transport on abort', async () => {
  let canceled = false;
  const controller = new AbortController();
  const adapter = createHttp3Adapter({
    request: () => new Promise(() => undefined),
    cancel: () => { canceled = true; },
  });
  const pending = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal } as never);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED');
  assert.equal(canceled, true);
});

test('http3 adapter preserves a timeout reason from an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort({ code: 'ETIMEDOUT', name: 'TimeoutError' });
  let requestCalls = 0;
  let cancelCalls = 0;
  const adapter = createHttp3Adapter({
    request: async () => {
      requestCalls += 1;
      return { status: 200 };
    },
    cancel: () => { cancelCalls += 1; },
  });
  await assert.rejects(
    adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT' && error.isTimeout,
  );
  assert.equal(requestCalls, 0);
  assert.equal(cancelCalls, 1);
});

test('http3 adapter classifies a timeout abort that races with transport startup', async () => {
  const controller = new AbortController();
  let cancelCalls = 0;
  const adapter = createHttp3Adapter({
    request: () => new Promise<Response>(() => undefined),
    cancel: () => { cancelCalls += 1; },
  });
  const pending = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal } as never);
  controller.abort({ code: 'ETIMEDOUT', name: 'TimeoutError' });
  await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT');
  assert.equal(cancelCalls, 1);
});

test('http3 adapter normalizes synchronous transport failures', async () => {
  const cause = new Error('transport exploded');
  const adapter = createHttp3Adapter({
    request: () => { throw cause; },
  });
  await assert.rejects(
    adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_NETWORK' && error.retryable && error.cause === cause,
  );
});

test('http3 adapter normalizes invalid transport response shapes', async () => {
  const adapter = createHttp3Adapter({
    request: async () => ({ status: 99 }),
  });
  await assert.rejects(
    adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_NETWORK' && error.retryable,
  );
});

test('http3 adapter does not let a throwing cancel hook escape the abort path', async () => {
  const controller = new AbortController();
  const adapter = createHttp3Adapter({
    request: () => new Promise<Response>(() => undefined),
    cancel: () => { throw new Error('cancel hook failed'); },
  });
  const pending = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal } as never);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED');
});
