import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosHeaders, createHttpClient } from '../../dist/index.js';
import { cancelBody, readErrorPayload } from '../../dist/utils/response.js';
import { createFetchAdapter } from '../../dist/adapters/fetch.js';
import { trackReadableStream } from '../../dist/transfer/progress.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// 补充第 7 项 — reading an oversized error payload must cancel BOTH the clone
// and the original response, because `clone()` tees the stream.
test('supplement 7: an oversized error payload cancels the original response too', async () => {
  let sourceCancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
    },
    cancel() { sourceCancelled = true; },
  }), { status: 500 });

  // No Content-Length, so the limit is only detected while reading chunks.
  const payload = await readErrorPayload(response, 4);
  assert.equal(payload, null);
  assert.equal(sourceCancelled, true, 'the underlying source must be cancelled');
});

test('supplement 7: cancelBody is idempotent for an already-consumed response', async () => {
  const response = new Response('body', { status: 500 });
  cancelBody(response);
  // A second call must not throw.
  cancelBody(response);
  assert.equal(response.bodyUsed, true);
});

// 补充第 14 项 — the AxiosHeaders conversion must keep every Set-Cookie, on the
// Fetch path and not only in the HTTP/2 adapter.
test('supplement 14: Fetch response headers keep every Set-Cookie', async () => {
  const native = new Headers();
  native.append('set-cookie', 'a=1; Path=/');
  native.append('set-cookie', 'b=2; Path=/');
  native.append('set-cookie', 'c=3; Path=/');

  const store = new AxiosHeaders(native);
  const values = store.getSetCookie?.() ?? [store.get('set-cookie')];
  const joined = JSON.stringify(values);
  for (const cookie of ['a=1', 'b=2', 'c=3']) {
    assert.equal(joined.includes(cookie), true, `missing ${cookie} in ${joined}`);
  }
});

test('supplement 14: a client response surfaces all Set-Cookie values', async () => {
  const client = createHttpClient({
    adapter: async () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'sid=1; Path=/');
      headers.append('set-cookie', 'theme=dark; Path=/');
      return new Response('{"ok":true}', { status: 200, headers });
    },
  });

  const response = await client.getResponse('/cookies');
  const joined = JSON.stringify(response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')]);
  assert.equal(joined.includes('sid=1'), true, joined);
  assert.equal(joined.includes('theme=dark'), true, joined);
});

// 补充第 18 项 — a raw header block combined with a rewrite argument must parse
// the string instead of treating it as a header name.
test('supplement 18: a raw header string works with a rewrite argument', () => {
  const headers = new AxiosHeaders({ 'X-Trace': 'old' });

  // `true` rewrites unconditionally.
  headers.set('X-Trace: next', true);
  assert.equal(headers.get('X-Trace'), 'next');

  // `false` keeps the existing value.
  headers.set('X-Trace: ignored', false);
  assert.equal(headers.get('X-Trace'), 'next');

  // A rewrite function is honoured.
  headers.set('X-Trace: function-value', () => true);
  assert.equal(headers.get('X-Trace'), 'function-value');

  // No rewrite argument still parses the raw block.
  headers.set('X-Trace: plain');
  assert.equal(headers.get('X-Trace'), 'plain');
});

test('supplement 18: an invalid raw header block still reports an error', () => {
  assert.throws(
    () => new AxiosHeaders().set('bad name: value', true),
    (error: unknown) => (error as { code?: string }).code === 'ERR_INVALID_HEADER',
  );
});

// 补充第 19 项 — a beforeRetry hook that awaits the same client must not deadlock
// a maxConcurrent: 1 client.
test('supplement 19: a beforeRetry hook can await the same client without deadlock', async () => {
  let attempts = 0;
  let refreshed = false;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async (config) => {
      if (config.url.includes('/refresh')) {
        refreshed = true;
        return jsonResponse({ token: 'fresh' });
      }
      attempts += 1;
      return attempts === 1 ? jsonResponse({ retry: true }, 503) : jsonResponse({ ok: true });
    },
  });

  const result = await client.get<{ ok: boolean }>('/needs-refresh', {
    retry: {
      limit: 1,
      delay: 0,
      statusCodes: [503],
      beforeRetry: async () => { await client.get('/refresh', { retry: 0 } as never); },
    },
  } as never);

  assert.deepEqual(result, { ok: true });
  assert.equal(refreshed, true);
});

test('supplement 19: a FULFILLED response interceptor can await the same client', async () => {
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async (config) => (
      config.url.includes('/extra') ? jsonResponse({ extra: true }) : jsonResponse({ ok: true })
    ),
  });

  // A real interceptor triggers on a specific response, not unconditionally:
  // an unconditional nested request would recurse into itself forever, which is
  // a property of the interceptor rather than of the scheduler.
  let extra: unknown;
  client.interceptors.response.use(async (response) => {
    if (response.status === 200 && !response.config.url.includes('/extra')) {
      extra = await client.get('/extra', { retry: 0 } as never);
    }
    return response;
  });

  const result = await client.get<{ ok: boolean }>('/main', { retry: 0 } as never);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(extra, { extra: true });
});

// 补充第 52 项 — a compressed response reports compressed Content-Length while
// the body yields decoded bytes, so the declared total must not be used.
test('supplement 52: a compressed response does not use Content-Length as total', async () => {
  const totals: Array<number | undefined> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Decoded payload is larger than the advertised compressed length.
        controller.enqueue(new TextEncoder().encode('y'.repeat(200)));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '20' } },
  )) as unknown as typeof globalThis.fetch;

  try {
    const adapter = createFetchAdapter();
    const out = await adapter({
      url: 'https://example.test/compressed',
      method: 'GET',
      headers: new Headers(),
      onDownloadProgress: (event: { total?: number; loaded: number; percent?: number }) => {
        totals.push(event.total);
        // loaded must never exceed the reported total.
        if (event.total !== undefined) {
          assert.equal(event.loaded <= event.total, true, `loaded ${event.loaded} > total ${event.total}`);
        }
      },
    } as never);
    // Progress is reported while the wrapped body is consumed.
    if (out instanceof Response) await out.text();
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(totals.length > 0, true, 'progress must be reported');
  assert.equal(totals.every((total) => total === undefined), true, `totals seen: ${JSON.stringify(totals)}`);
});

// 补充第 54 项 — cancelling a pending download with no rate limiter must not be
// reported as a completed transfer.
test('supplement 54: cancelling a pending download does not report completion', async () => {
  const events: Array<{ loaded: number; percent?: number }> = [];

  const source = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });
  const tracked = trackReadableStream(source, {
    total: 1024,
    onProgress: (event: { loaded: number; percent?: number }) => events.push(event),
  });
  const reader = tracked.getReader();

  // A read is left pending, then the caller cancels the wrapper.
  const pendingRead = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await reader.cancel();
  await pendingRead.catch(() => undefined);

  // The cancellation must not be mistaken for a completed body, even though no
  // rate limiter and no external signal are involved.
  assert.equal(
    events.some((event) => event.percent === 100),
    false,
    `a cancelled download must not report completion: ${JSON.stringify(events)}`,
  );
  assert.equal(
    events.some((event) => event.loaded === 1024),
    false,
    `a cancelled download must not report the full total: ${JSON.stringify(events)}`,
  );
});

// 补充第 54 项 — the same cancellation path with an external (unused) signal.
test('supplement 54: cancelling with an unaborted signal still suppresses completion', async () => {
  const events: Array<{ loaded: number; percent?: number }> = [];
  const controller = new AbortController();

  const source = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });
  const tracked = trackReadableStream(source, {
    total: 1024,
    signal: controller.signal,
    onProgress: (event: { loaded: number; percent?: number }) => events.push(event),
  });
  const reader = tracked.getReader();

  const pendingRead = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await reader.cancel();
  await pendingRead.catch(() => undefined);

  assert.equal(
    events.some((event) => event.percent === 100),
    false,
    `a cancelled download must not report completion: ${JSON.stringify(events)}`,
  );
  // The external signal was never aborted, so it cannot be what suppressed it.
  assert.equal(controller.signal.aborted, false);
});
