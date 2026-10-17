import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError } from '../../dist/index.js';

test('defaults to same-origin credentials without a custom request header', async () => {
  const seen: Array<{ credentials: unknown; id: string | null }> = [];
  const client = createHttpClient({ adapter: async (config) => {
    seen.push({ credentials: config.credentials, id: config.headers.get('x-request-id') });
    return Response.json({ ok: true });
  } });
  await client.get('https://public.example.test/');
  await client.get('https://private.example.test/', { credentials: 'include', requestId: true } as never);
  assert.deepEqual(seen[0], { credentials: 'same-origin', id: null });
  assert.equal(seen[1].credentials, 'include');
  assert.ok(seen[1].id);
});

test('rejects invalid numeric request options before invoking the adapter', async () => {
  let calls = 0;
  const client = createHttpClient({ adapter: async () => {
    calls += 1;
    return Response.json({ ok: true });
  } });
  for (const config of [
    { maxBodySize: -1 }, { maxBodySize: NaN }, { maxBodySize: Infinity },
    { maxBodySize: null }, { maxBodySize: 1.5 }, { maxBodySize: '10' },
    { timeout: NaN }, { totalTimeout: Infinity }, { timeout: -1 },
    { retry: -1 }, { retry: 1.5 }, { retry: Infinity },
    { retry: { limit: NaN } }, { retry: { maxDelay: Infinity } },
    { retryDelay: -2 }, { retry: { methods: ['GET', 3] } },
  ]) {
    await assert.rejects(client.get('/invalid', config as never), (error: unknown) =>
      error instanceof HttpError && error.code === 'ERR_INVALID_CONFIG');
  }
  assert.equal(calls, 0);
});

test('rejects invalid defaults and retry callback results as configuration errors', async () => {
  assert.throws(() => createHttpClient({ timeout: Infinity }), (error: unknown) =>
    error instanceof HttpError && error.code === 'ERR_INVALID_CONFIG');
  let calls = 0;
  const client = createHttpClient({ retry: 1, retryDelay: () => NaN, adapter: async () => {
    calls += 1;
    return new Response('busy', { status: 503 });
  } });
  await assert.rejects(client.get('/retry'), (error: unknown) =>
    error instanceof HttpError && error.code === 'ERR_INVALID_CONFIG');
  assert.equal(calls, 1);
});

test('a large Retry-After does not become an immediate retry', async () => {
  let calls = 0;
  const client = createHttpClient({ totalTimeout: 20, retry: 1, adapter: async () => {
    calls += 1;
    return new Response('busy', { status: 503, headers: { 'retry-after': '2147484' } });
  } });
  await assert.rejects(client.get('/busy'), (error: unknown) =>
    error instanceof HttpError && error.code === 'ETIMEDOUT');
  assert.equal(calls, 1);
});
