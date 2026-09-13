import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError } from '../dist/index.js';

test('exports createHttpClient', () => {
  assert.equal(typeof createHttpClient, 'function');
});

test('supports Axios-style request overloads and standard method helpers', async () => {
  const methods: string[] = [];
  const client = createHttpClient({
    adapter: async (config) => {
      methods.push(config.method);
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(await client.request<{ ok: boolean }>('/request-overload', { bypassCache: true }), { ok: true });
  assert.deepEqual(await client.head<{ ok: boolean }>('/head', { bypassCache: true }), { ok: true });
  assert.deepEqual(await client.options<{ ok: boolean }>('/options', { bypassCache: true }), { ok: true });
  assert.deepEqual(await client.trace<{ ok: boolean }>('/trace', { bypassCache: true }), { ok: true });
  assert.deepEqual(await client.connect<{ ok: boolean }>('/connect', { bypassCache: true }), { ok: true });
  assert.deepEqual(methods, ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);
});

test('accepts iterable request headers through the client pipeline', async () => {
  let observed: string | null = null;
  const client = createHttpClient({
    adapter: async (config) => {
      observed = config.headers.get('x-map-header');
      return jsonResponse({ ok: true });
    },
  });
  await client.get('/map-headers', {
    headers: new Map([['X-Map-Header', 'present']]),
  });
  assert.equal(observed, 'present');
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

test('allows request interceptors to remove client default headers', async () => {
  let observedAuthorization: string | null = null;
  const client = createHttpClient({
    headers: { Authorization: 'Bearer default-token' },
    adapter: async (config) => {
      observedAuthorization = config.headers.get('authorization');
      return jsonResponse({ ok: true });
    },
  });
  client.interceptors.request.use((config) => {
    config.headers.delete('Authorization');
    return config;
  });

  await client.get('/remove-default-header');
  assert.equal(observedAuthorization, null);
});

test('merges plain request-interceptor header patches with client defaults', async () => {
  let observed: { authorization: string | null; custom: string | null } = { authorization: null, custom: null };
  const client = createHttpClient({
    headers: { Authorization: 'Bearer default-token' },
    adapter: async (config) => {
      observed = {
        authorization: config.headers.get('authorization'),
        custom: config.headers.get('x-interceptor'),
      };
      return jsonResponse({ ok: true });
    },
  });
  client.interceptors.request.use((config) => ({
    ...config,
    headers: { 'X-Interceptor': 'yes' },
  }));

  await client.get('/merge-interceptor-headers');
  assert.deepEqual(observed, { authorization: 'Bearer default-token', custom: 'yes' });
});

test('honors false header opt-outs without injecting automatic defaults', async () => {
  let observed: { accept: string | null; contentType: string | null; body: unknown } = {
    accept: null,
    contentType: null,
    body: undefined,
  };
  const client = createHttpClient({
    adapter: async (config) => {
      observed = {
        accept: config.headers.get('accept'),
        contentType: config.headers.get('content-type'),
        body: config.body,
      };
      return jsonResponse({ ok: true });
    },
  });

  await client.post('/header-opt-out', { value: 1 }, {
    headers: { Accept: false, 'Content-Type': false },
  });
  assert.deepEqual(observed, { accept: null, contentType: null, body: '{"value":1}' });
});

test('allows an explicit request-id opt-out and does not invoke its factory', async () => {
  let factoryCalls = 0;
  let observed: string | null = null;
  const client = createHttpClient({
    requestId: () => {
      factoryCalls += 1;
      return 'generated-id';
    },
    adapter: async (config) => {
      observed = config.headers.get('x-request-id');
      return jsonResponse({ ok: true });
    },
  });

  await client.get('/request-id-opt-out', { headers: { 'X-Request-Id': false } });
  assert.equal(observed, null);
  assert.equal(factoryCalls, 0);
});

test('does not restore an auto request-id deleted by an interceptor', async () => {
  let observed: string | null = null;
  const client = createHttpClient({
    requestId: () => 'generated-id',
    adapter: async (config) => {
      observed = config.headers.get('x-request-id');
      return jsonResponse({ ok: true });
    },
  });
  client.interceptors.request.use((config) => {
    config.headers.delete('X-Request-Id');
    return config;
  });

  await client.get('/request-id-delete');
  assert.equal(observed, null);
});

test('runs response rejected interceptors for adapter failures and can recover', async () => {
  let attempts = 0;
  let rejected = 0;
  const client = createHttpClient({
    retry: 2,
    adapter: async () => {
      attempts += 1;
      throw new Error('offline');
    },
  });
  client.interceptors.response.use(undefined, () => {
    rejected += 1;
    return { data: { recovered: true } } as never;
  });

  assert.deepEqual(await client.get('/recover-adapter-error'), { recovered: true });
  assert.equal(rejected, 1);
  assert.equal(attempts, 1);
});

test('passes normalized HttpError values to response rejected interceptors', async () => {
  let seen: unknown;
  const client = createHttpClient({
    adapter: async () => { throw new Error('offline'); },
  });
  client.interceptors.response.use(undefined, (error) => {
    seen = error;
    throw error;
  });

  await assert.rejects(client.get('/normalized-response-error'));
  assert.equal(seen instanceof HttpError, true);
  assert.equal((seen as HttpError).code, 'ERR_NETWORK');
  assert.equal((seen as HttpError).config?.url, '/normalized-response-error');
});

test('preserves retry semantics when a rejected response interceptor rethrows', async () => {
  let attempts = 0;
  let rejected = 0;
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    retryUnsafeMethods: true,
    adapter: async () => {
      attempts += 1;
      return jsonResponse({ busy: true }, 503);
    },
  });
  client.interceptors.response.use(undefined, (error) => {
    rejected += 1;
    throw error;
  });

  await assert.rejects(client.get('/rethrow-response-error'));
  assert.equal(attempts, 2);
  assert.equal(rejected, 2);
});

test('does not retry errors thrown by fulfilled response interceptors', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: 2,
    adapter: async () => {
      attempts += 1;
      return jsonResponse({ ok: true });
    },
  });
  client.interceptors.response.use(() => { throw new Error('consumer failure'); });

  await assert.rejects(client.get('/response-interceptor-error'), (error: unknown) => {
    assert.equal((error as HttpError).message, 'consumer failure');
    return true;
  });
  assert.equal(attempts, 1);
});

test('preserves cancellation while a fulfilled response interceptor is pending', async () => {
  const controller = new AbortController();
  const client = createHttpClient({
    adapter: async () => jsonResponse({ ok: true }),
  });
  client.interceptors.response.use(() => new Promise<never>(() => {}));

  const pending = client.get('/response-interceptor-cancel', { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('response interceptor cancellation hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
});

test('cancels while a request interceptor is pending', async () => {
  const controller = new AbortController();
  const client = createHttpClient({
    adapter: async () => jsonResponse({ ok: true }),
  });
  client.interceptors.request.use(() => new Promise<never>(() => {}));

  const pending = client.get('/request-interceptor-cancel', { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('request interceptor cancellation hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
});

test('cancels while a request transform is pending', async () => {
  const controller = new AbortController();
  const client = createHttpClient({
    adapter: async () => jsonResponse({ ok: true }),
  });

  const pending = client.post('/request-transform-cancel', { value: 1 }, {
    signal: controller.signal,
    transformRequest: () => new Promise<never>(() => {}),
  });
  controller.abort();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('request transform cancellation hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
});

test('runs response rejected handlers once when a fulfilled handler fails', async () => {
  let rejectedRuns = 0;
  const client = createHttpClient({
    adapter: async () => jsonResponse({ ok: true }),
  });
  client.interceptors.response.use(undefined, (error) => {
    rejectedRuns += 1;
    throw error;
  });
  client.interceptors.response.use(() => { throw new Error('consumer failure'); });

  await assert.rejects(client.get('/response-interceptor-once'));
  assert.equal(rejectedRuns, 1);
});

test('normalizes header setup failures and notifies onRequestError', async () => {
  const errors: HttpError[] = [];
  const client = createHttpClient({
    onRequestError: (error) => errors.push(error),
    adapter: async () => jsonResponse({ ok: true }),
  });

  await assert.rejects(client.get('/invalid-header', { headers: { 'bad name': 'x' } }), (error: unknown) => {
    assert.equal(error instanceof HttpError, true);
    assert.equal((error as HttpError).code, 'ERR_INVALID_HEADER');
    return true;
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ERR_INVALID_HEADER');
});

test('does not invoke a failing requestId factory again while normalizing setup errors', async () => {
  let factoryCalls = 0;
  const client = createHttpClient({
    requestId: () => {
      factoryCalls += 1;
      throw new Error('id factory failed');
    },
  });

  await assert.rejects(client.get('/request-id-failure'), (error: unknown) => error instanceof HttpError);
  assert.equal(factoryCalls, 1);
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

test('honors a signal replaced by a retry request interceptor', async () => {
  let attempts = 0;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const client = createHttpClient({
    retry: { limit: 1, delay: 0 },
    adapter: async (config) => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ busy: true }, 503);
      markSecondStarted();
      return new Promise<Response>((_resolve, reject) => {
        if (config.signal?.aborted) {
          reject(config.signal.reason);
          return;
        }
        config.signal?.addEventListener('abort', () => {
          reject(config.signal?.reason ?? new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    },
  });
  client.interceptors.request.use((config) => ({
    ...config,
    signal: attempts === 0 ? firstController.signal : secondController.signal,
  }));

  const pending = client.get('/retry-replaced-signal');
  await secondStarted;
  secondController.abort();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('replaced signal was ignored')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
  assert.equal(attempts, 2);
});

test('does not start a retry when its replacement signal is already aborted', async () => {
  let attempts = 0;
  const firstController = new AbortController();
  const replacementController = new AbortController();
  replacementController.abort();
  const client = createHttpClient({
    retry: { limit: 1, delay: 0 },
    adapter: async () => {
      attempts += 1;
      return jsonResponse({ busy: true }, 503);
    },
  });
  client.interceptors.request.use((config) => ({
    ...config,
    signal: attempts === 0 ? firstController.signal : replacementController.signal,
  }));

  await assert.rejects(
    client.get('/retry-preaborted-signal'),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
  assert.equal(attempts, 1);
});

test('cancels a retry delay when an interceptor-provided signal aborts', async () => {
  const controller = new AbortController();
  let attempts = 0;
  let markBeforeRetry!: () => void;
  const beforeRetryCalled = new Promise<void>((resolve) => { markBeforeRetry = resolve; });
  const client = createHttpClient({
    retry: {
      limit: 1,
      delay: 1_000,
      beforeRetry: () => {
        markBeforeRetry();
        setTimeout(() => controller.abort(), 10);
      },
    },
    adapter: async () => {
      attempts += 1;
      return jsonResponse({ busy: true }, 503);
    },
  });
  client.interceptors.request.use((config) => ({ ...config, signal: controller.signal }));

  const pending = client.get('/cancel-interceptor-signal-delay');
  await beforeRetryCalled;
  const startedAt = Date.now();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('retry delay cancellation hung')), 300)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
  assert.ok(Date.now() - startedAt < 300);
  assert.equal(attempts, 1);
});

test('retries from the intercepted config and keeps the request id stable', async () => {
  let attempts = 0;
  const urls: string[] = [];
  const ids: string[] = [];
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    adapter: async (config) => {
      attempts += 1;
      urls.push(config.url);
      ids.push(config.headers.get('x-request-id') || '');
      return attempts === 1 ? jsonResponse({ busy: true }, 503) : jsonResponse({ ok: true });
    },
  });
  client.interceptors.request.use((config) => ({
    ...config,
    url: config.url === '/retry-base' ? '/retry-mutated' : config.url,
    headers: { ...Object.fromEntries(new Headers(config.headers).entries()), 'X-Request-Id': `rewritten-${attempts + 1}` },
  }));

  await client.get('/retry-base');
  assert.deepEqual(urls, ['/retry-mutated', '/retry-mutated']);
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids[0], 'rewritten-1');
});

test('feeds the latest intercepted headers into each retry interceptor pass', async () => {
  let attempts = 0;
  const markers: string[] = [];
  const client = createHttpClient({
    retry: 2,
    retryDelay: 0,
    adapter: async (config) => {
      attempts += 1;
      markers.push(config.headers.get('x-retry-marker') || '');
      return attempts < 3 ? jsonResponse({ busy: true }, 503) : jsonResponse({ ok: true });
    },
  });
  client.interceptors.request.use((config) => {
    const headers = new Headers(config.headers as HeadersInit);
    headers.set('X-Retry-Marker', String(Number(headers.get('X-Retry-Marker') || 0) + 1));
    return { ...config, headers };
  });

  await client.get('/retry-latest-interceptor');
  assert.deepEqual(markers, ['1', '2', '3']);
});

test('reapplies request transforms when a request is retried', async () => {
  let attempts = 0;
  const bodies: string[] = [];
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    retryUnsafeMethods: true,
    adapter: async (config) => {
      attempts += 1;
      bodies.push(String(config.body));
      return attempts === 1 ? jsonResponse({ busy: true }, 503) : jsonResponse({ ok: true });
    },
  });

  await client.post('/retry-transform', { value: 1 }, {
    transformRequest: (data) => ({ ...(data as { value: number }), signed: true }),
  });
  assert.deepEqual(bodies, ['{"value":1,"signed":true}', '{"value":1,"signed":true}']);
});

test('cancels while a retry request transform is pending', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    retryUnsafeMethods: true,
    adapter: async () => {
      attempts += 1;
      return jsonResponse({ busy: true }, 503);
    },
  });
  client.interceptors.request.use((config) => ({
    ...config,
    transformRequest: attempts === 0 ? config.transformRequest : () => new Promise<never>(() => {}),
  }));

  const pending = client.post('/retry-transform-cancel', { value: 1 }, {
    signal: controller.signal,
    transformRequest: (data) => data,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('retry transform cancellation hung')), 100)),
    ]),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
  assert.equal(attempts, 1);
});

test('does not retry non-replayable ReadableStream request bodies', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: 2,
    retryDelay: 0,
    retryUnsafeMethods: true,
    adapter: async () => {
      attempts += 1;
      return jsonResponse({ busy: true }, 503);
    },
  });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });

  await assert.rejects(client.post('/stream-retry', undefined, { body, retryUnsafeMethods: true }), (error: unknown) =>
    error instanceof HttpError && error.code === 'ERR_BAD_RESPONSE');
  assert.equal(attempts, 1);
});

test('uses the runtime attempt method when a custom HttpError supplies another config', async () => {
  let attempts = 0;
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    adapter: async (config) => {
      attempts += 1;
      if (attempts === 1) {
        throw new HttpError('adapter failed', {
          code: 'ERR_NETWORK',
          retryable: true,
          config: { ...config, method: 'POST' },
        });
      }
      return jsonResponse({ ok: true });
    },
  });

  assert.deepEqual(await client.get('/custom-error-method', { bypassCache: true }), { ok: true });
  assert.equal(attempts, 2);
});

test('uses the runtime body when a custom HttpError omits a stream body from its config', async () => {
  let attempts = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const client = createHttpClient({
    retry: 1,
    retryDelay: 0,
    retryUnsafeMethods: true,
    adapter: async (config) => {
      attempts += 1;
      throw new HttpError('adapter failed', {
        code: 'ERR_NETWORK',
        retryable: true,
        config: { ...config, body: undefined },
      });
    },
  });

  await assert.rejects(
    client.post('/custom-error-stream', undefined, {
      body,
      retryUnsafeMethods: true,
      bypassCache: true,
    }),
    (error: unknown) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal((error as HttpError).code, 'ERR_NETWORK');
      // The adapter's diagnostic config is preserved even though policy uses
      // the actual runtime config passed to this attempt.
      assert.equal((error as HttpError).config?.body, undefined);
      return true;
    },
  );
  assert.equal(attempts, 1);
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

test('normalizes cancellation during a retry delay and notifies once', async () => {
  const errors: HttpError[] = [];
  const controller = new AbortController();
  const client = createHttpClient({
    retry: 2,
    retryDelay: 100,
    onRequestError: (error) => errors.push(error),
    adapter: async () => jsonResponse({ busy: true }, 503),
  });
  const pending = client.get('/cancel-retry-delay', { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof HttpError, true);
    assert.equal((error as HttpError).code, 'ERR_CANCELED');
    assert.equal((error as HttpError).isAbort, true);
    return true;
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ERR_CANCELED');
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

test('does not cache GET requests with a body or data payload', async () => {
  let reads = 0;
  const client = createHttpClient({
    cache: { ttl: 1000 },
    adapter: async (config) => {
      reads += 1;
      return jsonResponse({ body: config.body });
    },
  });

  const first = await client.get('/cache-get-body', { body: 'a' });
  const second = await client.get('/cache-get-body', { body: 'b' });
  assert.deepEqual(first, { body: 'a' });
  assert.deepEqual(second, { body: 'b' });
  assert.equal(reads, 2);
});

test('does not cache responses when response interceptors are registered', async () => {
  let reads = 0;
  let intercepted = 0;
  const client = createHttpClient({
    cache: { ttl: 1_000 },
    adapter: async () => {
      reads += 1;
      return jsonResponse({ reads });
    },
  });
  client.interceptors.response.use((response) => {
    intercepted += 1;
    return { ...response, data: { ...(response.data as object), intercepted } };
  });

  assert.deepEqual(await client.get('/cache-response-interceptor'), { reads: 1, intercepted: 1 });
  assert.deepEqual(await client.get('/cache-response-interceptor'), { reads: 2, intercepted: 2 });
  assert.equal(reads, 2);
});

test('does not cache requests when request interceptors can change the effective URL during retry', async () => {
  let reads = 0;
  let interceptorRuns = 0;
  const client = createHttpClient({
    cache: { ttl: 1_000 },
    retry: 1,
    retryDelay: 0,
    adapter: async (config) => {
      reads += 1;
      return reads === 1
        ? jsonResponse({ url: config.url, reads }, 503)
        : jsonResponse({ url: config.url, reads });
    },
  });
  client.interceptors.request.use((config) => {
    interceptorRuns += 1;
    return { ...config, url: interceptorRuns % 2 === 0 ? '/cache-retry-b' : '/cache-retry-a' };
  });

  const first = await client.get<{ url: string; reads: number }>('/cache-request-interceptor');
  const second = await client.get<{ url: string; reads: number }>('/cache-request-interceptor');

  assert.deepEqual(first, { url: '/cache-retry-b', reads: 2 });
  assert.deepEqual(second, { url: '/cache-retry-a', reads: 3 });
  assert.equal(reads, 3);
});

test('includes caller-provided request ids in the cache key', async () => {
  let reads = 0;
  const client = createHttpClient({
    cache: { ttl: 1_000 },
    adapter: async (config) => {
      reads += 1;
      return jsonResponse({ requestId: config.headers.get('x-request-id'), reads });
    },
  });

  assert.deepEqual(await client.get('/cache-request-id', { headers: { 'X-Request-Id': 'caller-a' } }), {
    requestId: 'caller-a',
    reads: 1,
  });
  assert.deepEqual(await client.get('/cache-request-id', { headers: { 'X-Request-Id': 'caller-b' } }), {
    requestId: 'caller-b',
    reads: 2,
  });
  assert.deepEqual(await client.get('/cache-request-id', { headers: { 'X-Request-Id': 'caller-a' } }), {
    requestId: 'caller-a',
    reads: 1,
  });
  assert.equal(reads, 2);
});

test('merges request method header groups', async () => {
  let value = '';
  const client = createHttpClient({
    adapter: async (config) => {
      value = config.headers.get('x-request-method') || '';
      return jsonResponse({ ok: true });
    },
  });
  await client.get('/method-headers', { headers: { get: { 'X-Request-Method': 'yes' } } as never });
  assert.equal(value, 'yes');
});
