import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// #41 — a request interceptor rewrites `timeout` on the retry pass; the actual
// per-attempt timer must use the new value, not the first attempt's.
test('issue 41: a retry that rewrites timeout uses the new value for the timer', async () => {
  let attempt = 0;
  const client = createHttpClient({
    adapter: async () => {
      attempt += 1;
      if (attempt === 1) {
        // First attempt fails fast so a retry happens.
        return jsonResponse({ retry: true }, 503);
      }
      // The retry must be cut short by the rewritten 50ms timeout.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return jsonResponse({ ok: true });
    },
  });

  // Request interceptors rerun for every attempt, so the second pass can
  // shrink the timeout.
  client.interceptors.request.use((config) => {
    if (attempt >= 1) (config as { timeout?: number }).timeout = 50;
    return config;
  });

  const started = Date.now();
  const error = await client.get('/retry-timeout', {
    timeout: 5_000,
    retry: { limit: 1, delay: 0, statusCodes: [503] },
  } as never).catch((cause: unknown) => cause as { code?: string });

  const elapsed = Date.now() - started;
  // Without per-attempt recomputation the retry would wait the full 400ms
  // (or the original 5s), so the rewritten 50ms must show up as a timeout.
  assert.equal(elapsed < 350, true, `expected the retry timeout to apply, took ${elapsed}ms`);
  assert.equal((error as { code?: string })?.code, 'ETIMEDOUT');
});

// #41 — the rewritten timeout must not leak into a later attempt either.
test('issue 41: each attempt resolves its own timeout value', async () => {
  const observed: number[] = [];
  let attempt = 0;
  const client = createHttpClient({
    adapter: async (config) => {
      observed.push(Number((config as { timeout?: number }).timeout));
      attempt += 1;
      return attempt === 1 ? jsonResponse({ retry: true }, 503) : jsonResponse({ ok: true });
    },
  });

  client.interceptors.request.use((config) => {
    if (attempt >= 1) (config as { timeout?: number }).timeout = 123;
    return config;
  });

  await client.get('/retry-timeout-sequential', {
    timeout: 5_000,
    retry: { limit: 1, delay: 0, statusCodes: [503] },
  } as never);

  assert.equal(observed.length, 2);
  assert.equal(observed[0], 5_000, 'first attempt keeps the caller timeout');
  assert.equal(observed[1], 123, 'retry attempt uses the interceptor timeout');
});

// #28 — cancellation must stop queued interceptor work, not merely settle the
// caller's promise while remaining handlers still run.
test('issue 28: cancelling stops interceptors that have not started yet', async () => {
  const started: string[] = [];
  const client = createHttpClient({
    adapter: async () => jsonResponse({ ok: true }),
  });

  const controller = new AbortController();
  client.interceptors.request.use(async (config) => {
    started.push('first');
    // Cancel while this interceptor is still pending.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return config;
  });
  client.interceptors.request.use((config) => {
    started.push('second');
    return config;
  });

  await assert.rejects(
    client.get('/cancelled-chain', { signal: controller.signal } as never),
    (error: unknown) => (error as { code?: string }).code === 'ERR_CANCELED',
  );

  // Give the detached chain a chance to (wrongly) continue.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(started, ['first'], 'a cancelled request must not start later interceptors');
});

test('issue 28: cancelling stops request transforms that have not started yet', async () => {
  const controller = new AbortController();
  let releaseFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondCalls = 0;
  const client = createHttpClient({ adapter: async () => jsonResponse({ ok: true }) });

  const pending = client.post('/cancel-request-transforms', { value: 1 }, {
    signal: controller.signal,
    transformRequest: [
      async (value) => { await firstFinished; return value; },
      (value) => { secondCalls += 1; return value; },
    ],
  } as never);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'ERR_CANCELED');

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondCalls, 0, 'a cancelled request must not start the next request transform');
});

test('issue 28: cancelling stops response transforms that have not started yet', async () => {
  const controller = new AbortController();
  let releaseFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondCalls = 0;
  const client = createHttpClient({ adapter: async () => jsonResponse({ ok: true }) });

  const pending = client.get('/cancel-response-transforms', {
    signal: controller.signal,
    transformResponse: [
      async (value) => { await firstFinished; return value; },
      (value) => { secondCalls += 1; return value; },
    ],
  } as never);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'ERR_CANCELED');

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondCalls, 0, 'a cancelled request must not start the next response transform');
});
