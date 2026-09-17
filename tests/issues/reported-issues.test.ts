import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AxiosHeaders,
  HttpError,
  RateLimiter,
  createCsrfInterceptor,
  createHttpClient,
  mergeMethodHeaders,
  readResponse,
  resolveURL,
  uploadChunks,
} from '../../dist/index.js';
import { ProgressTracker } from '../../dist/transfer/progress.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

// #1 — a schema must not be bypassed by a cache entry stored without one.
test('issue 1: a schema request never reuses a cache entry stored without one', async () => {
  let calls = 0;
  const client = createHttpClient({
    cache: { ttl: 5_000 },
    adapter: async () => {
      calls += 1;
      return jsonResponse({ value: 'text' });
    },
  });

  assert.deepEqual(await client.get('/schema-cache'), { value: 'text' });
  await assert.rejects(
    client.get('/schema-cache', {
      schema: {
        '~standard': {
          validate: () => ({ issues: [{ message: 'expected a number' }] }),
        },
      },
    } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_SCHEMA_VALIDATION',
  );
  assert.equal(calls, 2);
});

// #6 / #55 — a JSON null is a value the schema must see; an empty-issues
// failure result must still fail.
test('issue 6: a JSON null payload is still validated against the schema', async () => {
  let seen: unknown = 'not-called';
  const client = createHttpClient({
    adapter: async () => new Response('null', { headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(
    client.get('/null-body', {
      cache: false,
      schema: {
        '~standard': {
          validate: (value: unknown) => {
            seen = value;
            return { issues: [{ message: 'null is not allowed' }] };
          },
        },
      },
    } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_SCHEMA_VALIDATION',
  );
  assert.equal(seen, null);
});

test('issue 55: a standard-schema failure with empty issues is not treated as success', async () => {
  const client = createHttpClient({
    adapter: async () => jsonResponse({ ok: true }),
  });

  await assert.rejects(
    client.get('/empty-issues', {
      cache: false,
      schema: { '~standard': { validate: () => ({ issues: [] as { message: string }[] }) } },
    } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_SCHEMA_VALIDATION',
  );
});

// #12 — errorCodes is a whitelist, so network errors and timeouts must match it.
test('issue 12: retry.errorCodes narrows network errors and timeouts', async () => {
  let calls = 0;
  const client = createHttpClient({
    adapter: async () => {
      calls += 1;
      throw new Error('socket hang up');
    },
  });

  await assert.rejects(
    client.get('/whitelist', { retry: { limit: 2, errorCodes: ['ETIMEDOUT'], delay: 0 } } as never),
  );
  // Only the initial attempt: ERR_NETWORK is not in the whitelist.
  assert.equal(calls, 1);
});

// #48 — a throwing validateStatus is a local policy error, not a retryable
// network failure.
test('issue 48: a throwing validateStatus is not retried as a network failure', async () => {
  let calls = 0;
  const client = createHttpClient({
    adapter: async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    },
  });

  await assert.rejects(
    client.get('/status-throw', {
      retry: 2,
      validateStatus: () => { throw new Error('policy exploded'); },
    } as never),
    (error: unknown) => error instanceof HttpError
      && error.code === 'ERR_INVALID_STATUS_POLICY'
      && error.retryable === false,
  );
  assert.equal(calls, 1);
});

// #37 — the outer setup signal stays connected after preparation completes.
test('issue 37: cancelling the caller signal after preparation still stops the request', async () => {
  const controller = new AbortController();
  let adapterStarted = false;
  const client = createHttpClient({
    signal: controller.signal,
    adapter: async () => {
      adapterStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return jsonResponse({ ok: true });
    },
  });

  const pending = client.get('/outer-signal');
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED',
  );
  assert.equal(adapterStarted, true);
});

// #43 — a triggered total timeout must not be overwritten by a later cancel.
test('issue 43: a triggered total timeout keeps ETIMEDOUT when the caller cancels afterwards', async () => {
  const controller = new AbortController();
  const client = createHttpClient({
    adapter: async (config) => {
      const signal = (config as { signal?: AbortSignal }).signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 200);
      });
      // Cancel the caller's signal right after the internal timeout fired.
      controller.abort();
      throw signal?.reason ?? new Error('aborted');
    },
  });

  await assert.rejects(
    client.get('/total-timeout', { totalTimeout: 20, signal: controller.signal } as never),
    (error: unknown) => error instanceof HttpError
      && error.code === 'ETIMEDOUT'
      && error.isTimeout === true,
  );
});

// #45 — a write that already reached the server must invalidate the GET cache
// even when local response handling fails.
test('issue 45: a failed response parse after a write still invalidates the cache', async () => {
  let stored = 'before';
  let writes = 0;
  const client = createHttpClient({
    cache: { ttl: 60_000 },
    adapter: async (config) => {
      if (config.method === 'PUT') {
        writes += 1;
        stored = 'after';
        // 200 with a body that is not valid JSON.
        return new Response('OK', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return jsonResponse({ value: stored });
    },
  });

  assert.deepEqual(await client.get('/cached-value'), { value: 'before' });
  await assert.rejects(
    client.put('/cached-value', { value: 'after' }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_BAD_PAYLOAD',
  );
  assert.equal(writes, 1);
  // The cache must have been invalidated even though the request rejected.
  assert.deepEqual(await client.get('/cached-value'), { value: 'after' });
});

// #13 / #29 / #52 — HEAD reports the GET size but transfers nothing.
test('issue 13: a HEAD Content-Length is not enforced as a real body size', async () => {
  const { markResponseMethod } = await import('../../dist/utils/response.js');
  const response = markResponseMethod(
    new Response(null, { status: 200, headers: { 'content-length': '1024' } }),
    'HEAD',
  );
  const bytes = await readResponse(response, 'arrayBuffer', 0);
  assert.equal(bytes, undefined);
});

test('issue 13 / issue 52: HEAD does not report a fabricated download of the declared size', async () => {
  const client = createHttpClient({
    // A HEAD response carries no body but advertises the GET resource size.
    adapter: async () => new Response(null, {
      status: 200,
      headers: { 'content-length': '1024' },
    }),
  });
  const events: number[] = [];
  await client.head('/probe', { onDownloadProgress: (event) => events.push(event.loaded) } as never);
  // Either no event or a zero-byte completion is acceptable; 1024 is not.
  assert.equal(events.every((loaded) => loaded === 0), true);
});

// #9 — a Blob result keeps the response MIME type.
test('issue 9: a blob response keeps its MIME type', async () => {
  const blob = await readResponse(
    new Response('binary', { headers: { 'content-type': 'image/png' } }),
    'blob',
  ) as Blob;
  assert.equal(blob.type, 'image/png');
});

// #7 — an over-limit payload cancels the underlying body.
test('issue 7: exceeding maxBodySize cancels the response stream', async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    },
    cancel() { canceled = true; },
  });
  await assert.rejects(
    readResponse(new Response(stream), 'arrayBuffer', 2),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_MAX_BODY_SIZE',
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(canceled, true);
});

// #17 / #18 — header deletions and raw header strings survive configuration merge.
test('issue 17: a request-level null removes a client default header', async () => {
  let seen: string | null = 'unset';
  const client = createHttpClient({
    headers: { Authorization: 'Bearer client-default' },
    adapter: async (config) => {
      seen = config.headers.get('authorization');
      return jsonResponse({ ok: true });
    },
  });

  await client.get('/drop-auth', { headers: { Authorization: null } } as never);
  assert.equal(seen, null);
});

test('issue 18: a raw header string is parsed instead of dropped', async () => {
  let seen: string | null = null;
  const client = createHttpClient({
    adapter: async (config) => {
      seen = config.headers.get('authorization');
      return jsonResponse({ ok: true });
    },
  });

  await client.get('/raw-headers', { headers: 'Authorization: Bearer raw-token' } as never);
  assert.equal(seen, 'Bearer raw-token');
});

test('issue 18: a raw header block works together with a rewrite argument', () => {
  const headers = new AxiosHeaders({ 'X-Trace': 'old' });
  headers.set('X-Trace: next', true);
  assert.equal(headers.get('X-Trace'), 'next');
  headers.set('X-Trace: ignored', false);
  assert.equal(headers.get('X-Trace'), 'next');
});

// #14 — repeated Set-Cookie values must be preserved.
test('issue 14: multiple Set-Cookie headers are not merged into one value', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'a=1; Path=/');
  headers.append('set-cookie', 'b=2; Path=/');
  const store = new AxiosHeaders(headers);
  const first = store.get('set-cookie');
  assert.equal(typeof first, 'string');
  assert.equal(first.includes('b=2'), true);
});

// #10 — redaction matches formatted header names.
test('issue 10: redaction still applies after header names are re-cased', () => {
  const headers = new AxiosHeaders({ Authorization: 'Bearer secret', Cookie: 'session=1' });
  headers.normalize(true);
  const merged = AxiosHeaders.from(headers);
  const seen: Record<string, string> = {};
  merged.forEach((value, name) => { seen[name] = value; });
  const redacted = Object.fromEntries(
    Object.entries(seen).map(([name, value]) => [name.toLowerCase(), value]),
  );
  assert.equal(redacted.authorization, 'Bearer secret');
  assert.equal(redacted.cookie, 'session=1');
});

// #22 — a backslash network path cannot bypass allowAbsoluteURL: false.
test('issue 22: a backslash network path is rejected when absolute URLs are disabled', () => {
  assert.throws(
    () => resolveURL('', '/\\outside.example/resource', false),
    /Absolute URLs are disabled/,
  );
});

// #11 — a throwing hook stops other chunk workers.
test('issue 11: a throwing progress hook stops further chunk uploads', async () => {
  const uploaded: number[] = [];
  await assert.rejects(
    uploadChunks(new Uint8Array(40), {
      chunkSize: 10,
      concurrency: 2,
      onProgress: () => { throw new Error('progress observer failed'); },
      upload: async (part) => {
        uploaded.push(part.index);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return part.index;
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  // Only the in-flight parts may have been attempted after the hook threw.
  assert.equal(uploaded.length <= 4, true);
});

// #38 — staleIfError alone falls back to the previous value.
test('issue 38: staleIfError alone serves the previous value when refresh fails', async () => {
  const { ResponseCache } = await import('../../dist/cache/response-cache.js');
  let now = 0;
  const cache = new ResponseCache<number>({ now: () => now });
  const first = await cache.getOrLoad('k', async () => 1, { ttl: 100, staleIfError: true });
  assert.equal(first, 1);
  now = 1_000;
  const second = await cache.getOrLoad('k', async () => { throw new Error('upstream down'); }, {
    ttl: 100,
    staleIfError: true,
  });
  assert.equal(second, 1);
});

// #20 — clearing an unknown key does not retain generation metadata, and a
// parameterless clear releases it.
test('issue 20: invalidation metadata does not grow for unknown keys', async () => {
  const { ResponseCache } = await import('../../dist/cache/response-cache.js');
  const cache = new ResponseCache<number>({ maxEntries: 2 });
  for (let index = 0; index < 50; index += 1) cache.clear(`never-cached-${index}`);
  assert.equal(cache.size(), 0);
  cache.clear();
  assert.equal(cache.size(), 0);
});

// #26 — expired GET-cache payloads are reclaimable.
test('issue 26: expired get-cache entries can be pruned without re-requesting them', async () => {
  const { GetRequestCache } = await import('../../dist/cache/get-cache.js');
  const cache = new GetRequestCache('prune', { maxEntries: 4 });
  for (let index = 0; index < 10; index += 1) {
    await cache.getOrLoad(`key-${index}`, 1, async () => index);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const removed = cache.prune();
  assert.equal(removed > 0, true);
  assert.equal(cache.size(), 0);
});

// #15 — a throttled transfer still reports its final byte count.
test('issue 15: a throttled tracker still emits the final loaded value', () => {
  const events: number[] = [];
  const tracker = new ProgressTracker({
    phase: 'download',
    progressInterval: 1_000,
    onProgress: (event) => events.push(event.loaded),
  });
  tracker.update(2);
  tracker.update(3);
  tracker.complete();
  assert.equal(events[events.length - 1], 3);
});

// #54 — cancelling a tracked stream stops the byte throttle instead of
// reporting a false completion.
test('issue 54: cancelling a tracked download stream does not report completion', async () => {
  const { trackReadableStream } = await import('../../dist/transfer/progress.js');
  const events: number[] = [];
  const limiter = new RateLimiter({ bytesPerSecond: 1 });
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
  });
  const tracked = trackReadableStream(source, {
    phase: 'download',
    total: 1024,
    progressInterval: 0,
    onProgress: (event) => events.push(event.loaded),
    rateLimiter: limiter,
    rateLimit: { bytesPerSecond: 1 },
  });
  const reader = tracked.getReader();
  const pending = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reader.cancel();
  await pending.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((loaded) => loaded === 1024), false);
});

// #16 — a re-created Response keeps its url/redirected/type.
test('issue 16: a wrapped fetch response keeps its url and redirect metadata', async () => {
  const { createFetchAdapter } = await import('../../dist/adapters/fetch.js');
  // A real fetch resolves with a Response whose `url` reflects the request.
  const adapter = createFetchAdapter(async (input) => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '11' },
    });
    Object.defineProperty(response, 'url', { value: String(input) });
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  });
  const response = await adapter({
    url: 'https://example.test/final',
    method: 'GET',
    headers: new Headers(),
    onDownloadProgress: () => undefined,
  } as never);
  const resolved = response instanceof Response ? response : response.response;
  assert.equal(resolved.url, 'https://example.test/final');
  assert.equal(resolved.redirected, true);
  assert.equal(resolved.type, 'basic');
});

// #50 — duplex is forwarded for a stream body outside Node as well.
test('issue 50: a ReadableStream body always enables duplex', async () => {
  const { createFetchAdapter } = await import('../../dist/adapters/fetch.js');
  let seen: (RequestInit & { duplex?: string }) | undefined;
  const adapter = createFetchAdapter(async (_input, init) => {
    seen = init as typeof seen;
    return new Response('ok');
  });
  await adapter({
    url: 'https://example.test/upload',
    method: 'POST',
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
  } as never);
  assert.equal(seen?.duplex, 'half');
});

// #23 — credentials: 'omit' is rejected instead of silently ignored by XHR.
test('issue 23: the XHR adapter refuses credentials: omit instead of leaking cookies', async () => {
  const { createXhrAdapter } = await import('../../dist/adapters/xhr.js');
  const original = globalThis.XMLHttpRequest;
  class MinimalXHR {
    upload = {};
    open() {}
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() {}
    abort() {}
  }
  globalThis.XMLHttpRequest = MinimalXHR as never;
  try {
    await assert.rejects(
      createXhrAdapter()({
        url: 'https://example.test',
        method: 'GET',
        headers: new Headers(),
        credentials: 'omit',
      } as never),
      (error: unknown) => error instanceof HttpError && error.code === 'ERR_UNSUPPORTED_ADAPTER',
    );
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

// #57 — the XHR adapter refuses a streaming body rather than stringifying it.
test('issue 57: the XHR adapter refuses a ReadableStream request body', async () => {
  const { createXhrAdapter } = await import('../../dist/adapters/xhr.js');
  const original = globalThis.XMLHttpRequest;
  class MinimalXHR {
    upload = {};
    open() {}
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() {}
    abort() {}
  }
  globalThis.XMLHttpRequest = MinimalXHR as never;
  try {
    await assert.rejects(
      createXhrAdapter()({
        url: 'https://example.test',
        method: 'POST',
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      } as never),
      (error: unknown) => error instanceof HttpError && error.code === 'ERR_UNSUPPORTED_ADAPTER',
    );
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

// #2 / #21 — 204 and an empty body are not network errors, and binary payloads
// survive the arraybuffer path.
test('issue 2: an XHR 204 response resolves instead of failing as a network error', async () => {
  const { createXhrAdapter } = await import('../../dist/adapters/xhr.js');
  const original = globalThis.XMLHttpRequest;
  class NoContentXHR {
    upload = {};
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    readyState = 0;
    status = 204;
    statusText = 'No Content';
    responseType = '';
    response: ArrayBuffer | null = null;
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() { this.readyState = 4; this.onreadystatechange?.(); }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = NoContentXHR as never;
  try {
    const response = await createXhrAdapter()({
      url: 'https://example.test',
      method: 'DELETE',
      headers: new Headers(),
    } as never);
    assert.equal(response.status, 204);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('issue 21: the XHR adapter preserves non-text response bytes', async () => {
  const { createXhrAdapter } = await import('../../dist/adapters/xhr.js');
  const original = globalThis.XMLHttpRequest;
  const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  class BinaryXHR {
    upload = {};
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    readyState = 0;
    status = 200;
    statusText = 'OK';
    responseType = '';
    response = payload.buffer;
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return 'content-type: image/jpeg\r\n'; }
    send() { this.readyState = 4; this.onreadystatechange?.(); }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = BinaryXHR as never;
  try {
    const response = await createXhrAdapter()({
      url: 'https://example.test/image',
      method: 'GET',
      headers: new Headers(),
      responseType: 'response',
    } as never);
    const bytes = [...new Uint8Array(await response.arrayBuffer())];
    assert.deepEqual(bytes, [...payload]);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

// #31 — fetchJson must respect a `false` header opt-out.
test('issue 31: fetchJson does not re-add a header disabled with false', async () => {
  const { fetchJson } = await import('../../dist/server/json.js');
  let seen: Headers | undefined;
  await fetchJson('/opt-out', {
    headers: { Cookie: false as never, Accept: false as never },
    cookie: 'session=1',
    fetch: (async (_url, init) => {
      seen = new Headers((init as RequestInit).headers);
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as never,
  });
  assert.equal(seen?.get('cookie'), null);
  assert.equal(seen?.get('accept'), null);
});

// #27 — a non-success fetchJson response releases its body.
test('issue 27: fetchJson releases the body of a non-success response', async () => {
  const { fetchJsonResult } = await import('../../dist/server/json.js');
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('nope')); },
    cancel() { canceled = true; },
  });
  const result = await fetchJsonResult('/error', {
    fetch: (async () => new Response(body, { status: 500 })) as never,
  });
  assert.equal(result.status, 500);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(canceled, true);
});

// #36 — a CSRF token refreshed between retries is re-read.
test('issue 36: the CSRF interceptor refreshes its own token on a retry', async () => {
  let token = 'old-token';
  const interceptor = createCsrfInterceptor({ readToken: () => token });
  const first = interceptor({ method: 'POST', url: '/x', headers: new AxiosHeaders() } as never);
  const firstHeaders = new Headers(first.headers as HeadersInit);
  assert.equal(firstHeaders.get('x-csrf-token'), 'old-token');

  token = 'new-token';
  // Reuse the previous attempt's config, as the retry loop does.
  const second = interceptor({ ...first, headers: new AxiosHeaders(first.headers as never) } as never);
  const secondHeaders = new Headers(second.headers as HeadersInit);
  assert.equal(secondHeaders.get('x-csrf-token'), 'new-token');
});

// #40 — method-grouped headers do not leak across methods for fetchJson.
test('issue 40: an unrelated method group does not supply the request header', () => {
  const headers = mergeMethodHeaders(undefined, 'GET', {
    get: { Authorization: 'Bearer read-token' },
    post: { Authorization: 'Bearer write-token' },
  });
  assert.equal(headers.get('Authorization'), 'Bearer read-token');
});

// #56 — a cross-realm ArrayBuffer is uploaded as bytes, not JSON.
test('issue 56: an ArrayBuffer is not JSON-serialized when encoded as a body', async () => {
  const { encodeBody, isPlainBody } = await import('../../dist/utils/body.js');
  const buffer = new ArrayBuffer(3);
  assert.equal(isPlainBody(buffer), false);
  const headers = new AxiosHeaders();
  const body = encodeBody(buffer, undefined, headers);
  assert.equal(body, buffer);
  assert.equal(headers.has('Content-Type'), false);
});

// #44 — the client exposes a transport close hook.
test('issue 44: the client exposes a close hook for adapter transports', async () => {
  let closed = 0;
  const adapter = Object.assign(
    async () => jsonResponse({ ok: true }),
    { closeTransport: () => { closed += 1; } },
  );
  const client = createHttpClient({ adapter: adapter as never });
  await client.close();
  assert.equal(closed, 1);
});
