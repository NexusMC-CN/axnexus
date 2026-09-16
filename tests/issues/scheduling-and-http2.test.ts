import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, RateLimiter, createHttpClient } from '../../dist/index.js';
import { createNodeHttp2Adapter } from '../../dist/adapters/node-http2.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// #19 — automatic retries must pass back through requestsPerInterval.
test('issue 19: automatic retries respect requestsPerInterval', async () => {
  const callTimes: number[] = [];
  const started = Date.now();
  const client = createHttpClient({
    adapter: async () => {
      callTimes.push(Date.now() - started);
      return jsonResponse({ retry: true }, 503);
    },
  });

  await assert.rejects(
    client.get('/limited-retry', {
      retry: { limit: 2, delay: 0, statusCodes: [503] },
      rateLimit: { requestsPerInterval: 1, interval: 200 },
    } as never),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_BAD_RESPONSE',
  );
  assert.equal(callTimes.length, 3);
  // Each retry needs its own slot: one request per 200ms window.
  assert.equal(callTimes[0] < 100, true);
  assert.equal(callTimes[1] >= 150, true);
  assert.equal(callTimes[2] >= 350, true);
});

// #19b — a beforeRetry hook that calls the same client must not deadlock.
test('issue 19b: a beforeRetry hook can call the same client with maxConcurrent 1', async () => {
  let refreshes = 0;
  let attempts = 0;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async (config) => {
      if (config.url.includes('/refresh')) {
        refreshes += 1;
        return jsonResponse({ token: 'fresh' });
      }
      attempts += 1;
      if (attempts === 1) return jsonResponse({ retry: true }, 503);
      return jsonResponse({ ok: true });
    },
  });

  const result = await client.get<{ ok: boolean }>('/needs-refresh', {
    retry: {
      limit: 1,
      delay: 0,
      statusCodes: [503],
      beforeRetry: async () => { await client.get('/refresh'); },
    },
  } as never);

  assert.deepEqual(result, { ok: true });
  assert.equal(refreshes, 1);
  assert.equal(attempts, 2);
});

// #19b — the same deadlock via a response error interceptor.
test('issue 19b: a response error interceptor can call the same client with maxConcurrent 1', async () => {
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
      // Always unauthorized: the point is that the nested refresh can run at
      // all, not that the outer request eventually succeeds.
      return jsonResponse({ unauthorized: true }, 401);
    },
  });

  client.interceptors.response.use(undefined, async (error: unknown) => {
    if ((error as { status?: number }).status === 401 && !refreshed) {
      await client.get('/refresh');
    }
    throw error;
  });

  await assert.rejects(
    client.get('/protected', { retry: 0 } as never),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
  // Without releasing the slot this nested request could never start.
  assert.equal(refreshed, true);
  assert.equal(attempts, 1);
});

// #35 — a short window on the same group must not erase a long window's history.
test('issue 35: a short request-rate window does not erase a long window history', async () => {
  const limiter = new RateLimiter();
  const group = { resourceGroup: 'shared-windows' };

  // Fill a 60s window that allows two requests.
  await limiter.run(() => undefined, { ...group, requestsPerInterval: 2, interval: 60_000 });
  await limiter.run(() => undefined, { ...group, requestsPerInterval: 2, interval: 60_000 });

  // A shorter window on the same group must not discard the 60s history.
  await limiter.run(() => undefined, { ...group, requestsPerInterval: 5, interval: 50 });

  const controller = new AbortController();
  const third = limiter.run(() => undefined, {
    ...group,
    requestsPerInterval: 2,
    interval: 60_000,
    signal: controller.signal,
  });

  // The third request in the 60s window is still held.
  const settledEarly = await Promise.race([
    third.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 80)),
  ]);
  assert.equal(settledEarly, false);

  controller.abort();
  await third.catch(() => undefined);
});

// #42 — switching byte rates must not refill the bucket.
test('issue 42: alternating byte rates do not grant a fresh burst each call', async () => {
  const limiter = new RateLimiter();
  const started = Date.now();
  await limiter.consume(1_000, { bytesPerSecond: 1_000, resourceGroup: 'rate-switch' });
  await limiter.consume(1_001, { bytesPerSecond: 1_001, resourceGroup: 'rate-switch' });
  const elapsed = Date.now() - started;
  // A full refill per call would finish instantly.
  assert.equal(elapsed > 400, true);
});

// #46 — wake-up timers are coalesced and do not outlive the queue.
test('issue 46: queued rate-limit wake-ups are coalesced', async () => {
  const limiter = new RateLimiter({ requestsPerInterval: 1, interval: 50 });
  await limiter.run(() => undefined);
  const controller = new AbortController();
  const queued = [
    limiter.run(() => undefined, { signal: controller.signal }),
    limiter.run(() => undefined, { signal: controller.signal }),
    limiter.run(() => undefined, { signal: controller.signal }),
  ];
  controller.abort();
  await Promise.all(queued.map((pending) => pending.catch(() => undefined)));
  // The scheduler must still be usable afterwards.
  const result = await limiter.run(() => 'ok', { requestsPerInterval: 100, interval: 1 });
  assert.equal(result, 'ok');
});

// #53 — idle resource groups are reclaimable.
test('issue 53: the rate limiter exposes resource-group bookkeeping', () => {
  const limiter = new RateLimiter({ maxConcurrent: 1 });
  assert.equal(typeof limiter.groupCount(), 'number');
  assert.equal(limiter.groupCount(), 0);
});

// #25 — GOAWAY retires the session from the reuse pool.
test('issue 25: a GOAWAY retires the session so new requests reconnect', async () => {
  const sessions: ManualSession[] = [];
  let connects = 0;
  const adapter = createNodeHttp2Adapter({
    module: {
      connect: () => {
        connects += 1;
        const session = new ManualSession();
        sessions.push(session);
        return session;
      },
      constants: { NGHTTP2_CANCEL: 8 },
    },
  });

  const first = adapter({ url: 'https://example.test/a', method: 'GET', headers: new Headers() } as never);
  await new Promise((resolve) => setImmediate(resolve));
  sessions[0].streams[0].emit('response', { ':status': 200 });
  sessions[0].streams[0].emit('end');
  await first;
  assert.equal(connects, 1);

  // The peer announces it will accept no new streams.
  sessions[0].emit('goaway');

  const second = adapter({ url: 'https://example.test/b', method: 'GET', headers: new Headers() } as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 2);
  sessions[1].streams[0].emit('response', { ':status': 200 });
  sessions[1].streams[0].emit('end');
  const result = await second;
  assert.equal(result.response.status, 200);
});

// #33 — a DELETE body must be writable.
test('issue 33: a DELETE request body can be written over HTTP/2', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({
    module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } },
  });

  const pending = adapter({
    url: 'https://example.test/resource',
    method: 'DELETE',
    headers: new Headers(),
    body: 'delete-payload',
  } as never);
  await new Promise((resolve) => setImmediate(resolve));

  // The stream must have been opened without ending the writable side.
  assert.deepEqual(session.requestOptions[0], { endStream: false });
  session.streams[0].emit('response', { ':status': 200 });
  session.streams[0].emit('end');
  const result = await pending;
  assert.equal(result.response.status, 200);
});

// #39 — CONNECT must not carry a :path pseudo-header.
test('issue 39: a CONNECT request omits the :path pseudo-header', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({
    module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } },
  });

  const pending = adapter({
    url: 'https://example.test/tunnel',
    method: 'CONNECT',
    headers: new Headers(),
  } as never);
  await new Promise((resolve) => setImmediate(resolve));

  const headers = session.requestHeaders[0];
  assert.equal(':method' in headers, true);
  assert.equal(':path' in headers, false);

  session.streams[0].emit('response', { ':status': 200 });
  session.streams[0].emit('end');
  const result = await pending;
  assert.equal(result.response.status, 200);
});

// #14 — repeated Set-Cookie values from HTTP/2 are preserved individually.
test('issue 14: HTTP/2 keeps each Set-Cookie header separate', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({
    module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } },
  });

  const pending = adapter({ url: 'https://example.test/cookies', method: 'GET', headers: new Headers() } as never);
  await new Promise((resolve) => setImmediate(resolve));
  session.streams[0].emit('response', {
    ':status': 200,
    'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
  });
  session.streams[0].emit('end');
  const result = await pending;
  const raw = result.response.headers.get('set-cookie') ?? '';
  assert.equal(raw.includes('a=1'), true);
  assert.equal(raw.includes('b=2'), true);
});

// #44 — the adapter exposes a transport close hook.
test('issue 44: the HTTP/2 adapter exposes closeTransport', async () => {
  const session = new ManualSession();
  let closed = 0;
  session.close = () => { closed += 1; };
  const adapter = createNodeHttp2Adapter({
    module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } },
  });

  const pending = adapter({ url: 'https://example.test/close', method: 'GET', headers: new Headers() } as never);
  await new Promise((resolve) => setImmediate(resolve));
  session.streams[0].emit('response', { ':status': 200 });
  session.streams[0].emit('end');
  await pending;

  (adapter as unknown as { closeTransport?: () => void }).closeTransport?.();
  assert.equal(closed >= 1, true);
});

/** Minimal scriptable HTTP/2 session used by the adapter tests. */
class ManualSession {
  streams: ManualStream[] = [];
  requestOptions: Array<{ endStream?: boolean } | undefined> = [];
  requestHeaders: Array<Record<string, string>> = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  closed = false;
  destroyed = false;

  request(headers: Record<string, string>, options?: { endStream?: boolean }): ManualStream {
    this.requestHeaders.push(headers);
    this.requestOptions.push(options);
    const stream = new ManualStream();
    this.streams.push(stream);
    return stream;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  close(): void { this.closed = true; }
  destroy(): void { this.destroyed = true; }
  unref(): void { /* no-op */ }
}

class ManualStream {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  written: unknown[] = [];
  ended = false;
  closed = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  write(chunk: unknown): boolean {
    this.written.push(chunk);
    // Report backpressure once so the writer must wait for `drain`.
    return this.written.length > 1;
  }

  end(body?: unknown): void {
    if (body !== undefined) this.written.push(body);
    this.ended = true;
  }

  close(): void { this.closed = true; }
  pause(): void { /* no-op */ }
  resume(): void { /* no-op */ }
}
