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

test('request retry statusCodes override client retryOn consistently', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retryOn: [500],
    retry: { limit: 1 },
    adapter: async () => {
      attempts += 1;
      return new Response('{}', { status: attempts === 1 ? 503 : 200 });
    },
  });

  assert.deepEqual(
    await client.get('/retry-status-precedence', {
      retry: { statusCodes: [503], delay: 0 },
    }),
    {},
  );
  assert.equal(attempts, 2);
});

test('request retryOn overrides client retry statusCodes', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: { limit: 1, statusCodes: [503] },
    adapter: async () => {
      attempts += 1;
      return new Response('{}', { status: attempts === 1 ? 500 : 200 });
    },
  });

  assert.deepEqual(await client.get('/retry-status-legacy-precedence', {
    retryOn: [500],
    retry: { delay: 0 },
  }), {});
  assert.equal(attempts, 2);
});

test('retry errorCodes opt in an otherwise non-retryable error', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: { limit: 1, errorCodes: ['ERR_RATE_LIMIT_QUEUE_TIMEOUT'], delay: 0 },
    adapter: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new HttpError('queue timed out', { code: 'ERR_RATE_LIMIT_QUEUE_TIMEOUT' });
      }
      return new Response('{}', { status: 200 });
    },
  });

  assert.deepEqual(await client.get('/retry-error-code'), {});
  assert.equal(attempts, 2);
});

test('retry respects Retry-After and caps the final jittered delay', async () => {
  let seenDelay = -1;
  const client = createHttpClient({
    adapter: async () => new Response('{}', {
      status: 503,
      headers: { 'retry-after': '2' },
    }),
  });

  await assert.rejects(client.get('/retry-after', {
    retry: {
      limit: 1,
      statusCodes: [503],
      delay: 100,
      maxDelay: 50,
      jitter: () => 250,
      shouldRetry: ({ delay }) => {
        seenDelay = delay;
        return false;
      },
    },
  }));
  assert.equal(seenDelay, 50);
});

test('retry can ignore Retry-After when explicitly disabled', async () => {
  let seenDelay = -1;
  const client = createHttpClient({
    adapter: async () => new Response('{}', {
      status: 503,
      headers: { 'retry-after': '2' },
    }),
  });

  await assert.rejects(client.get('/retry-after-disabled', {
    retry: {
      limit: 1,
      statusCodes: [503],
      delay: 100,
      respectRetryAfter: false,
      shouldRetry: ({ delay }) => {
        seenDelay = delay;
        return false;
      },
    },
  }));
  assert.equal(seenDelay, 100);
});

test('cancels a pending fulfilled response interceptor on single-attempt timeout', async () => {
  const client = createHttpClient({
    timeout: 10,
    adapter: async () => new Response('{}', { status: 200 }),
  });
  client.interceptors.response.use(async () => new Promise(() => undefined));

  await assert.rejects(
    Promise.race([
      client.get('/pending-response-interceptor'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT',
  );
});

test('cancels a pending rejected response interceptor on single-attempt timeout', async () => {
  const client = createHttpClient({
    timeout: 10,
    adapter: async () => {
      throw new Error('upstream failed');
    },
  });
  client.interceptors.response.use(undefined, async () => new Promise(() => undefined));

  await assert.rejects(
    Promise.race([
      client.get('/pending-error-interceptor'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT',
  );
});

test('cancels a pending response transform on single-attempt timeout', async () => {
  const client = createHttpClient({
    timeout: 10,
    adapter: async () => new Response('{}', { status: 200 }),
  });

  await assert.rejects(
    Promise.race([
      client.get('/pending-response-transform', {
        transformResponse: async () => new Promise(() => undefined),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT',
  );
});

test('cancels a pending JSON parser on single-attempt timeout', async () => {
  const client = createHttpClient({
    timeout: 10,
    adapter: async () => new Response('{}', { status: 200 }),
  });

  await assert.rejects(
    Promise.race([
      client.get('/pending-json-parser', {
        parseJson: async () => new Promise(() => undefined),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT',
  );
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

test('allows shouldRetry to override a non-retryable application error', async () => {
  let attempts = 0;
  const client = createHttpClient({
    adapter: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new HttpError('application busy', {
          code: 'ERR_NETWORK',
          retryable: false,
        });
      }
      return new Response('{"ok":true}', { status: 200 });
    },
  });

  const result = await client.get('/custom-retryable-error', {
    retry: {
      limit: 1,
      shouldRetry: () => true,
      delay: 0,
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
});

test('passes the calculated retry delay to shouldRetry', async () => {
  let seenDelay = -1;
  const client = createHttpClient({
    retry: {
      limit: 1,
      delay: 25,
      shouldRetry: (context) => {
        seenDelay = context.delay;
        return false;
      },
    },
    adapter: async () => new Response('{"busy":true}', { status: 503 }),
  });

  await assert.rejects(client.get('/retry-delay-context'));
  assert.equal(seenDelay, 25);
});

test('does not retry a cross-realm readable stream body', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    retryUnsafeMethods: true,
    adapter: async () => {
      attempts += 1;
      return new Response('{"busy":true}', { status: 503 });
    },
  });
  const crossRealmLikeStream = {
    getReader() {
      return {
        read: async () => ({ done: true, value: undefined }),
        releaseLock() {},
      };
    },
  };

  await assert.rejects(
    client.post('/cross-realm-stream', undefined, {
      body: crossRealmLikeStream as never,
      retryUnsafeMethods: true,
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_BAD_RESPONSE',
  );
  assert.equal(attempts, 1);
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

test('classifies an adapter cancellation caused by timeout as ETIMEDOUT', async () => {
  const client = createHttpClient({
    adapter: (config) => new Promise<Response>((_resolve, reject) => {
      config.signal?.addEventListener('abort', () => {
        reject(new HttpError('adapter canceled', { code: 'ERR_CANCELED', isAbort: true }));
      }, { once: true });
    }),
  });
  await assert.rejects(
    client.get('/adapter-timeout-classification', { timeout: 5 }),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT' && error.isTimeout,
  );
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

test('merges request retry objects with client defaults and preserves explicit delay precedence', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const client = createHttpClient({
    retry: { limit: 2, statusCodes: [503], delay: 1 },
    retryDelay: 2,
    adapter: async () => {
      attempts += 1;
      return new Response('{"busy":true}', { status: 503 });
    },
  });

  await assert.rejects(client.get('/retry-merge', {
    retry: { limit: 1 },
    retryDelay: (attempt: number) => { delays.push(attempt); return 0; },
  } as never));
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1]);
});

test('does not share cached data between response types', async () => {
  let reads = 0;
  const client = createHttpClient({
    cache: { ttl: 1_000 },
    adapter: async (config) => {
      reads += 1;
      return config.responseType === 'text'
        ? new Response('plain', { status: 200 })
        : new Response('{"reads":' + reads + '}', { status: 200 });
    },
  });

  assert.deepEqual(await client.get('/cache-type'), { reads: 1 });
  assert.equal(await client.get<string>('/cache-type', { responseType: 'text' }), 'plain');
  assert.equal(reads, 2);
});

test('request cancellation does not wait on a shared cached loader', async () => {
  let resolveResponse!: (response: Response) => void;
  let adapterStarted!: () => void;
  const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
  let reads = 0;
  const client = createHttpClient({
    cache: { ttl: 1_000 },
    adapter: async (config) => {
      reads += 1;
      adapterStarted();
      return new Promise<Response>((resolve, reject) => {
        resolveResponse = resolve;
        config.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = client.get('/cache-cancel', { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED');
  resolveResponse(new Response('{"ok":true}', { status: 200 }));
  assert.equal(reads, 1);
});

test('does not cache GET responses when body limits, progress, or rate limits are request-specific', async () => {
  let reads = 0;
  const client = createHttpClient({
    cache: { ttl: 1_000 },
    adapter: async () => {
      reads += 1;
      return new Response('12345', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  await assert.rejects(client.get('/cache-body-limit', { responseType: 'text', maxBodySize: 3 }), (error: unknown) =>
    error instanceof HttpError && error.code === 'ERR_MAX_BODY_SIZE');
  assert.equal(await client.get('/cache-body-limit', { responseType: 'text', maxBodySize: 10 }), '12345');
  assert.equal(reads, 2);
});

test('normalizes custom JSON serialization failures', async () => {
  const client = createHttpClient({ adapter: async () => new Response('{"ok":true}', { status: 200 }) });
  await assert.rejects(
    client.post('/serialize-error', { value: true }, { stringifyJson: () => { throw new Error('serialize failed'); } }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_TRANSFORM_REQUEST',
  );
});

test('maps response transform failures to ERR_TRANSFORM_RESPONSE', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('{"ok":true}', { status: 200 }),
  });
  await assert.rejects(
    client.get('/transform-error', { transformResponse: () => { throw new Error('transform failed'); } }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_TRANSFORM_RESPONSE',
  );
});

test('maps request transform failures to ERR_TRANSFORM_REQUEST', async () => {
  const client = createHttpClient({ adapter: async () => new Response('{"ok":true}', { status: 200 }) });
  await assert.rejects(
    client.post('/transform-request-error', { ok: true }, { transformRequest: () => { throw new Error('transform failed'); } }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_TRANSFORM_REQUEST',
  );
});

test('does not retry a status accepted by validateStatus', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: 2,
    adapter: async () => {
      attempts += 1;
      return new Response('{"accepted":true}', { status: 503 });
    },
  });
  const result = await client.get('/accepted-status', { validateStatus: (status) => status < 600 });
  assert.deepEqual(result, { accepted: true });
  assert.equal(attempts, 1);
});

test('bounds non-success response payloads with maxBodySize', async () => {
  const client = createHttpClient({
    adapter: async () => new Response('0123456789', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    }),
  });
  await assert.rejects(
    client.get('/large-error', { maxBodySize: 3 }),
    (error: unknown) => error instanceof HttpError
      && error.code === 'ERR_BAD_RESPONSE'
      && error.response?.data === null,
  );
});

test('aborts response body reads when the single-attempt timeout expires', async () => {
  const client = createHttpClient({
    adapter: async () => new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    }), { status: 200 }),
  });
  await assert.rejects(
    Promise.race([
      client.get('/slow-body', { timeout: 5 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('body read hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT',
  );
});
