import { strict as assert } from 'node:assert';
import test from 'node:test';
import { HttpError, createFetchAdapter } from '../../dist/index.js';

const isBunRuntime = Boolean((globalThis as { Bun?: unknown }).Bun);

test('fetch adapter reports download progress from response stream', async () => {
  const originalFetch = globalThis.fetch;
  const events: number[] = [];
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  }), { headers: { 'content-length': '3' } });
  try {
    const response = await createFetchAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(),
      onDownloadProgress: (event) => events.push(event.loaded),
    } as never);
    await response.arrayBuffer();
    assert.deepEqual(events, [2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch adapter emits one completed event when response body is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const events: number[] = [];
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await createFetchAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(),
      onDownloadProgress: (event) => events.push(event.loaded),
    } as never);
    assert.deepEqual(events, [0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch download byte throttling observes request abort', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array([1, 2])); stream.close(); },
  }));
  try {
    const response = await createFetchAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(), signal: controller.signal,
      rateLimit: { bytesPerSecond: 1 }, rateLimiter: new (await import('../../dist/transfer/rate-limiter.js')).RateLimiter(),
    } as never);
    const pending = response.arrayBuffer();
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 100))]), (error: unknown) => {
      return error instanceof Error && (error as { code?: string }).code === 'ERR_CANCELED';
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch adapter resolves the default fetch implementation lazily', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const adapter = createFetchAdapter();
  globalThis.fetch = async () => {
    calls.push('replacement');
    return new Response('ok');
  };
  try {
    await adapter({
      url: 'https://example.test', method: 'GET', headers: new Headers(),
    } as never);
    assert.deepEqual(calls, ['replacement']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch adapter reports a clear error when fetch is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const adapter = createFetchAdapter();
  try {
    Reflect.deleteProperty(globalThis, 'fetch');
    await assert.rejects(
      adapter({ url: 'https://example.test', method: 'GET', headers: new Headers() } as never),
      (error: unknown) => error instanceof HttpError && error.code === 'ERR_UNSUPPORTED_ADAPTER',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch adapter always enables duplex for readable stream uploads', async () => {
  const originalFetch = globalThis.fetch;
  let seenInit: RequestInit | undefined;
  const adapter = createFetchAdapter(async (_input, init) => {
    seenInit = init;
    return new Response('ok');
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  try {
    await adapter({
      url: 'https://example.test', method: 'POST', headers: new Headers(), body,
    } as never);
    // The Fetch standard requires `duplex: 'half'` for a stream body in every
    // environment; omitting it makes a spec-compliant implementation throw.
    assert.equal((seenInit as RequestInit & { duplex?: string } | undefined)?.duplex, 'half');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch adapter leaves progress totals unknown when content length is absent', async () => {
  const originalFetch = globalThis.fetch;
  const events: Array<{ total?: number; percent?: number }> = [];
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.close();
    },
  }));
  try {
    const response = await createFetchAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(),
      onDownloadProgress: (event) => events.push(event),
    } as never);
    await response.arrayBuffer();
    assert.equal(events.length, 1);
    assert.equal('total' in events[0], false);
    assert.equal('percent' in events[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch adapter forwards native and Node-specific request options', async () => {
  let seenInit: (RequestInit & { dispatcher?: unknown; agent?: unknown; priority?: string; duplex?: string }) | undefined;
  const dispatcher = { dispatch() {} };
  const agent = { protocol: 'https:' };
  const adapter = createFetchAdapter(async (_input, init) => {
    seenInit = init as typeof seenInit;
    return new Response('ok');
  });

  await adapter({
    url: 'https://example.test',
    method: 'GET',
    headers: new Headers(),
    fetchCache: 'no-store',
    priority: 'high',
    window: null,
    dispatcher,
    agent,
  } as never);

  assert.equal(seenInit?.cache, 'no-store');
  assert.equal(seenInit?.priority, 'high');
  assert.equal(seenInit?.window, null);
  assert.equal(seenInit?.dispatcher, isBunRuntime ? undefined : dispatcher);
  assert.equal(seenInit?.agent, isBunRuntime ? undefined : agent);
});

test('fetch adapter does not forward Node-only transport options to Bun', { skip: !isBunRuntime }, async () => {
  let seenInit: (RequestInit & { dispatcher?: unknown; agent?: unknown; duplex?: string }) | undefined;
  const adapter = createFetchAdapter(async (_input, init) => {
    seenInit = init as typeof seenInit;
    return new Response('ok');
  });

  await adapter({
    url: 'https://example.test',
    method: 'GET',
    headers: new Headers(),
    dispatcher: { dispatch() {} },
    agent: { protocol: 'https:' },
  } as never);

  assert.equal(seenInit?.dispatcher, undefined);
  assert.equal(seenInit?.agent, undefined);
});

test('fetch adapter forwards duplex to Bun for a readable stream body', { skip: !isBunRuntime }, async () => {
  let seenInit: (RequestInit & { duplex?: string }) | undefined;
  const adapter = createFetchAdapter(async (_input, init) => {
    seenInit = init as typeof seenInit;
    return new Response('ok');
  });

  await adapter({
    url: 'https://example.test',
    method: 'POST',
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
    }),
  } as never);

  // Bun 1.4.2 accepts `duplex` with both stream and plain bodies, and the Fetch
  // standard requires it for a stream body, so it is always forwarded.
  assert.equal(seenInit?.duplex, 'half');
});
