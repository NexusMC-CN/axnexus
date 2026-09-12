import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError } from '../../dist/index.js';
import { createFetchAdapter } from '../../dist/adapters/fetch.js';

test('returns non-success responses when validateStatus opts in', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('{"missing":true}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await client.get<{ missing: boolean }>('/missing', {
    validateStatus: (status: number) => status < 500,
  } as never);

  assert.deepEqual(result, { missing: true });
});

test('supports structured retry policy and invokes beforeRetry', async () => {
  let attempts = 0;
  const retryAttempts: number[] = [];
  const client = createHttpClient({
    adapter: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('{"retrying":true}', { status: 503 })
        : new Response('{"ok":true}', { status: 200 });
    },
  });

  const result = await client.get<{ ok: boolean }>('/retry', {
    retry: {
      limit: 1,
      methods: ['GET'],
      statusCodes: [503],
      delay: 0,
      beforeRetry: ({ retryCount }: { retryCount: number }) => retryAttempts.push(retryCount),
    },
  } as never);

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(retryAttempts, [1]);
});

test('allows shouldRetry to opt unsafe methods into retries', async () => {
  let attempts = 0;
  const client = createHttpClient({
    adapter: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('{"retrying":true}', { status: 503 })
        : new Response('{"ok":true}', { status: 200 });
    },
  });

  const result = await client.post<{ ok: boolean }>('/retry-post', {}, {
    retry: {
      limit: 1,
      shouldRetry: ({ error }) => error.status === 503,
      delay: 0,
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
});

test('enforces totalTimeout across retry delays', async () => {
  let attempts = 0;
  const client = createHttpClient({
    adapter: async () => {
      attempts += 1;
      return new Response('{"retry":true}', { status: 503 });
    },
  });

  await assert.rejects(
    client.get('/slow-retry', {
      retry: { limit: 2, delay: 50 },
      timeout: 1_000,
      totalTimeout: 20,
    } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT',
  );
  assert.equal(attempts, 1);
});

test('uses an injected fetch implementation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('global fetch must not be used');
  }) as typeof fetch;
  try {
    const adapter = createFetchAdapter(async () => new Response('{"injected":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = createHttpClient({ adapter });
    assert.deepEqual(await client.get('/injected'), { injected: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('supports a custom JSON parser and response transform', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('{"value":2}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await client.get<{ value: number; transformed: boolean }>('/json', {
    parseJson: (text: string) => ({ value: Number(JSON.parse(text).value) }),
    transformResponse: (data: { value: number }) => ({ ...data, transformed: true }),
  } as never);

  assert.deepEqual(result, { value: 2, transformed: true });
});

test('maps asynchronous JSON parser failures to ERR_BAD_PAYLOAD', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('{"value":2}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    client.get('/invalid-json', { parseJson: async () => { throw new Error('parser failed'); } }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_BAD_PAYLOAD',
  );
});
