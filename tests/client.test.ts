import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError } from '../dist/index.js';

test('exports createHttpClient', () => {
  assert.equal(typeof createHttpClient, 'function');
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('builds a JSON request and returns parsed data', async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const client = createHttpClient({
    baseURL: 'https://api.example.test/v1/',
    adapter: async (config) => {
      requests.push(config);
      return jsonResponse({ id: 'user-1' });
    },
  });

  const result = await client.post<{ id: string }, { name: string }>('/users', { name: 'Ada' }, {
    params: { active: true, tag: ['one', 'two'] },
  });

  assert.deepEqual(result, { id: 'user-1' });
  assert.equal(requests[0].url, 'https://api.example.test/v1/users?active=true&tag=one&tag=two');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.get('content-type'), 'application/json');
  assert.match(requests[0].headers.get('x-request-id') || '', /^[0-9a-f-]{8,}$/i);
  assert.equal(requests[0].body, JSON.stringify({ name: 'Ada' }));
});

test('preserves FormData and parses alternate response types', async () => {
  const bodies: unknown[] = [];
  const client = createHttpClient({
    adapter: async (config) => {
      bodies.push(config.body);
      if (config.responseType === 'text') return new Response('plain text');
      return new Response(JSON.stringify({ uploaded: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const form = new FormData();
  form.set('file', new Blob(['data']), 'file.txt');

  const uploaded = await client.post<{ uploaded: boolean }>('/upload', form);
  const text = await client.get<string>('/message', { responseType: 'text', bypassCache: true });
  await client.post('/raw', 'plain body', { responseType: 'text', bypassCache: true });

  assert.deepEqual(uploaded, { uploaded: true });
  assert.equal(text, 'plain text');
  assert.equal(bodies[0], form);
  assert.equal((bodies[0] as FormData).get('file') instanceof Blob, true);
  assert.equal(bodies[2], 'plain body');
});

test('applies request and response interceptors on the client instance', async () => {
  const order: string[] = [];
  const client = createHttpClient({
    adapter: async (config) => {
      order.push(`adapter:${config.headers.get('x-test')}`);
      return jsonResponse({ value: 1 });
    },
  });
  client.interceptors.request.use((config) => {
    order.push('request');
    return { ...config, headers: { 'X-Test': 'set' } };
  });
  client.interceptors.response.use((response) => {
    order.push('response');
    return { ...response, data: { value: (response.data as { value: number }).value + 1 } };
  });

  const result = await client.get<{ value: number }>('/intercept');

  assert.deepEqual(result, { value: 2 });
  assert.deepEqual(order, ['request', 'adapter:set', 'response']);
});

test('converts non-2xx responses to HttpError with response payload', async () => {
  const client = createHttpClient({
    adapter: async () => jsonResponse({ code: 'NOT_ALLOWED', message: 'No access' }, 403),
  });

  await assert.rejects(
    client.get('/private'),
    (error: unknown) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal((error as HttpError).status, 403);
      assert.equal((error as HttpError).code, 'ERR_BAD_RESPONSE');
      assert.equal((error as HttpError).message, 'No access');
      return true;
    },
  );
});

test('retries idempotent requests and reuses the request id', async () => {
  let attempts = 0;
  const requestIds: string[] = [];
  const client = createHttpClient({
    retry: 2,
    retryDelay: 0,
    adapter: async (config) => {
      attempts += 1;
      requestIds.push(config.headers.get('x-request-id') || '');
      if (attempts < 3) return jsonResponse({ error: 'busy' }, 503);
      return jsonResponse({ ok: true });
    },
  });

  await assert.doesNotReject(client.get('/retry'));
  assert.equal(attempts, 3);
  assert.equal(new Set(requestIds).size, 1);
});

test('reruns request interceptors for each retry attempt', async () => {
  let interceptorRuns = 0;
  let attempts = 0;
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    adapter: async (config) => {
      attempts += 1;
      assert.equal(config.headers.get('x-attempt-marker'), String(attempts));
      if (attempts === 1) return jsonResponse({ error: 'busy' }, 503);
      return jsonResponse({ ok: true });
    },
  });
  client.interceptors.request.use((config) => {
    interceptorRuns += 1;
    return { ...config, headers: { ...Object.fromEntries(new Headers(config.headers).entries()), 'X-Attempt-Marker': String(interceptorRuns) } };
  });

  await client.get('/retry-interceptor');
  assert.equal(interceptorRuns, 2);
});

test('does not retry unsafe methods unless explicitly enabled', async () => {
  let defaultAttempts = 0;
  const defaultClient = createHttpClient({
    retry: 2,
    retryDelay: 0,
    adapter: async () => {
      defaultAttempts += 1;
      return jsonResponse({ error: 'busy' }, 503);
    },
  });
  await assert.rejects(defaultClient.post('/unsafe', {}));

  let enabledAttempts = 0;
  const enabledClient = createHttpClient({
    retry: 2,
    retryDelay: 0,
    adapter: async () => {
      enabledAttempts += 1;
      return jsonResponse({ error: 'busy' }, 503);
    },
  });
  await assert.rejects(enabledClient.post('/unsafe', {}, { retryUnsafeMethods: true }));

  assert.equal(defaultAttempts, 1);
  assert.equal(enabledAttempts, 3);
});

test('does not retry unsafe methods after a network error by default', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: 2,
    retryDelay: 0,
    adapter: async () => {
      attempts += 1;
      throw new TypeError('offline');
    },
  });

  await assert.rejects(client.post('/unsafe-network', {}));
  assert.equal(attempts, 1);
});

test('calls onRequestError once for a failed request', async () => {
  const errors: HttpError[] = [];
  const client = createHttpClient({
    onRequestError: (error) => errors.push(error),
    adapter: async () => jsonResponse({ error: 'broken' }, 500),
  });

  await assert.rejects(client.get('/hook-error'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 500);
});

test('keeps the original error when onRequestError throws', async () => {
  const original = new Error('observer failure');
  const client = createHttpClient({
    onRequestError: () => { throw new Error('observer crashed'); },
    adapter: async () => { throw original; },
  });

  await assert.rejects(client.get('/observer-error'), (error: unknown) => {
    assert.equal((error as HttpError).code, 'ERR_NETWORK');
    assert.equal((error as HttpError).cause, original);
    return true;
  });
});

test('does not cache raw Response objects', async () => {
  let reads = 0;
  const client = createHttpClient({
    cache: { ttl: 1000 },
    adapter: async () => {
      reads += 1;
      return new Response('ok', { status: 200 });
    },
  });

  const first = await client.get<Response>('/raw-response', { responseType: 'response' });
  const second = await client.get<Response>('/raw-response', { responseType: 'response' });

  assert.equal(first instanceof Response, true);
  assert.equal(second instanceof Response, true);
  assert.equal(reads, 2);
});

test('distinguishes external cancellation from timeout', async () => {
  const client = createHttpClient({
    adapter: async (config) => new Promise<Response>((_resolve, reject) => {
      config.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const controller = new AbortController();
  const canceled = client.get('/cancel', { signal: controller.signal });
  controller.abort();
  await assert.rejects(canceled, (error: unknown) => {
    assert.equal((error as HttpError).code, 'ERR_CANCELED');
    assert.equal((error as HttpError).isAbort, true);
    return true;
  });

  const lateController = new AbortController();
  const lateClient = createHttpClient({
    adapter: async (config) => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => lateController.abort(), 1);
      config.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  await assert.rejects(lateClient.get('/late-cancel', { signal: lateController.signal }), (error: unknown) => {
    assert.equal((error as HttpError).code, 'ERR_CANCELED');
    return true;
  });

  await assert.rejects(client.get('/timeout', { timeout: 5 }), (error: unknown) => {
    assert.equal((error as HttpError).code, 'ETIMEDOUT');
    assert.equal((error as HttpError).isTimeout, true);
    return true;
  });
});

test('deduplicates GET requests and clears cache after mutation', async () => {
  let reads = 0;
  const client = createHttpClient({
    cache: { ttl: 1000 },
    adapter: async () => {
      reads += 1;
      return jsonResponse({ reads });
    },
  });

  const [first, second] = await Promise.all([
    client.get<{ reads: number }>('/cached'),
    client.get<{ reads: number }>('/cached'),
  ]);
  await client.post('/cached', {});
  const third = await client.get<{ reads: number }>('/cached');

  assert.deepEqual(first, { reads: 1 });
  assert.deepEqual(second, { reads: 1 });
  assert.deepEqual(third, { reads: 3 });
  assert.equal(reads, 3);
});
