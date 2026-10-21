import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/index.js';

test('plugins observe one logical request and separate retries without leaking context to headers', async () => {
  const events: any[] = [];
  let attempts = 0;
  let disposed = 0;
  const client = createHttpClient({
    credentials: 'omit',
    retry: { limit: 1, delay: 0, jitter: false },
    plugins: [{
      setup: () => () => { disposed++; },
      onEvent: event => events.push(event),
    }],
    adapter: async config => {
      assert.equal(config.headers.has('tenant'), false);
      attempts++;
      return new Response('{}', { status: attempts === 1 ? 503 : 200 });
    },
  });
  await client.get('https://example.test/item', { context: { tenant: 'a' } });
  assert.equal(events.filter(event => event.phase === 'request:start').length, 1);
  assert.equal(events.filter(event => event.phase === 'request:end').length, 1);
  assert.equal(events.filter(event => event.phase === 'attempt:start').length, 2);
  assert.equal(events.filter(event => event.phase === 'attempt:end').length, 2);
  assert(events.every(event => event.context.tenant === 'a'));
  assert.equal(new Set(events.map(event => event.requestId)).size, 1);
  await client.close();
  await client.close();
  assert.equal(disposed, 1);
});

test('raw request completion follows body consumption and cancellation', async () => {
  const events: any[] = [];
  let cancelCount = 0;
  const client = createHttpClient({
    plugins: [{ onEvent: event => events.push(event) }],
    adapter: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelCount++; },
    })),
  });
  const response = await client.get<Response>('https://example.test/stream', { responseType: 'response' });
  assert.equal(events.filter(event => event.phase === 'request:end').length, 0);
  await response.body!.cancel('consumer stopped');
  assert.equal(cancelCount, 1);
  assert.equal(events.filter(event => event.phase === 'body:end').length, 1);
  assert.equal(events.filter(event => event.phase === 'request:end').length, 1);
  assert.equal(events.at(-1).bodyOutcome, 'canceled');
  await client.close();
});

test('cache hits have no transport event and plugin observer failures do not change requests', async () => {
  const phases: string[] = [];
  const client = createHttpClient({
    cache: { ttl: 10_000 }, credentials: 'omit',
    plugins: [{ onEvent(event) { phases.push(event.phase); throw new Error('observer'); } }],
    adapter: async () => new Response('{"ok":true}'),
  });
  assert.deepEqual(await client.get('https://example.test/cache'), { ok: true });
  assert.deepEqual(await client.get('https://example.test/cache'), { ok: true });
  assert.equal(phases.filter(phase => phase === 'transport:start').length, 1);
  assert.equal(phases.filter(phase => phase === 'cache:hit').length, 1);
  await client.close();
});

test('in-flight followers are observed as deduplicated rather than retained cache hits', async () => {
  const phases: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const client = createHttpClient({ cache: true, credentials: 'omit',
    plugins: [{ onEvent: event => phases.push(event.phase) }],
    adapter: async () => { await gate; return new Response('{}'); },
  });
  const first = client.get('https://example.test/shared');
  const second = client.get('https://example.test/shared');
  release();
  await Promise.all([first, second]);
  assert.equal(phases.filter(phase => phase === 'cache:dedupe').length, 1);
  assert.equal(phases.filter(phase => phase === 'cache:hit').length, 0);
  await client.close();
});

test('pre-abort closes logical observers and plugin disposal ejects interceptors once', async () => {
  const phases: string[] = [];
  const client = createHttpClient();
  let intercepted = 0;
  const dispose = client.use({
    setup(http) {
      const id = http.interceptors.request.use(config => { intercepted++; return config; });
      return () => http.interceptors.request.eject(id);
    },
    onEvent: event => phases.push(event.phase),
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.get('https://example.test/abort', { signal: controller.signal }), { code: 'ERR_CANCELED' });
  assert.deepEqual(phases, ['request:start', 'request:end']);
  assert.equal(intercepted, 0);
  await dispose(); await dispose(); await client.close();
});

test('asynchronous observers are isolated and do not reject successful HTTP work', async () => {
  const client = createHttpClient({
    plugins: [{ async onEvent() { throw new Error('observer failed asynchronously'); } }],
    adapter: async () => new Response('{"ok":true}'),
  });
  assert.deepEqual(await client.get('https://example.test/observer'), { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  await client.close();
});

test('queue events measure waiting before transport and close when queued work is canceled', async () => {
  for (const outcome of ['complete', 'cancel', 'timeout']) {
    const events: any[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const firstStarted = new Promise<void>(resolve => started = resolve);
    const client = createHttpClient({ rateLimit: { maxConcurrent: 1 },
      plugins: [{ onEvent: event => events.push(event) }],
      adapter: async config => {
        if (config.context === 'first') { started(); await gate; }
        return new Response('{}');
      },
    });
    const first = client.get('https://example.test/queue', { context: 'first' });
    await firstStarted;
    const controller = new AbortController();
    const waiting = client.get('https://example.test/queue', { context: 'waiting', signal: controller.signal,
      ...(outcome === 'timeout' ? { rateLimit: { queueTimeout: 10 } } : {}),
    });
    const settled = waiting.then(value => value, error => error);
    await new Promise(resolve => setTimeout(resolve, 20));
    if (outcome === 'cancel') controller.abort();
    release();
    await first;
    const result = await settled;
    await client.close();
    const observed = events.filter(event => event.context === 'waiting');
    assert.equal(observed.filter(event => event.phase === 'queue:start').length, 1);
    const ended = observed.filter(event => event.phase === 'queue:end');
    assert.equal(ended.length, 1);
    assert(ended[0].duration >= (outcome === 'timeout' ? 5 : 10), `queue duration ${ended[0].duration}`);
    if (outcome !== 'complete') {
      const code = outcome === 'cancel' ? 'ERR_CANCELED' : 'ERR_RATE_LIMIT_QUEUE_TIMEOUT';
      assert.equal(result.code, code);
      assert.equal(ended[0].error.code, code);
      assert.equal(observed.filter(event => event.phase === 'transport:start').length, 0);
    } else {
      assert.deepEqual(result, {});
      assert(observed.indexOf(ended[0]) < observed.findIndex(event => event.phase === 'transport:start'));
    }
  }
});

test('retry events include beforeRetry work and the subsequent delay', async () => {
  const events: any[] = [];
  let attempts = 0;
  const client = createHttpClient({
    retry: { limit: 1, delay: 20, jitter: false, beforeRetry: () => new Promise(resolve => setTimeout(resolve, 20)) },
    plugins: [{ onEvent: event => events.push(event) }],
    adapter: async () => new Response('{}', { status: ++attempts === 1 ? 503 : 200 }),
  });
  await client.get('https://example.test/retry');
  await client.close();
  const retry = events.filter(event => event.phase.startsWith('retry:'));
  assert.deepEqual(retry.map(event => event.phase), ['retry:start', 'retry:end']);
  assert.equal(retry[0].attempt, 1);
  assert.equal(retry[1].attempt, 1);
  assert(retry[1].duration >= 25, `retry duration ${retry[1].duration}`);
  assert.equal(retry[1].error, undefined);
  assert(events.indexOf(retry[1]) < events.findIndex(event => event.phase === 'attempt:start' && event.attempt === 1));
});

test('retry events end once when canceled during the hook or delay', async () => {
  for (const stage of ['hook', 'delay']) {
    const events: any[] = [];
    let entered!: () => void;
    const hookEntered = new Promise<void>(resolve => entered = resolve);
    const controller = new AbortController();
    const client = createHttpClient({ retry: { limit: 1, delay: 1000, jitter: false,
      beforeRetry() { entered(); return stage === 'hook' ? new Promise<void>(() => {}) : undefined; },
    }, plugins: [{ onEvent: event => events.push(event) }], adapter: async () => new Response('{}', { status: 503 }) });
    const result = client.get('https://example.test/retry-cancel', { signal: controller.signal });
    const rejected = assert.rejects(result, { code: 'ERR_CANCELED' });
    await hookEntered;
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await rejected;
    await client.close();
    const retry = events.filter(event => event.phase.startsWith('retry:'));
    assert.deepEqual(retry.map(event => event.phase), ['retry:start', 'retry:end']);
    assert(retry[1].duration >= 10);
    assert.equal(retry[1].error.code, 'ERR_CANCELED');
    assert.equal(events.filter(event => event.phase === 'attempt:start').length, 1);
    assert.equal(events.filter(event => event.phase === 'request:end').length, 1);
  }
});

test('raw body events measure consumer ownership through EOF and cancellation', async () => {
  for (const outcome of ['complete', 'canceled', 'error']) {
    const events: any[] = [];
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const client = createHttpClient({ plugins: [{ onEvent: event => events.push(event) }],
      adapter: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })),
    });
    const response = await client.get<Response>('https://example.test/body', { responseType: 'response' });
    await new Promise(resolve => setTimeout(resolve, 20));
    if (outcome === 'canceled') await response.body!.cancel();
    else if (outcome === 'error') {
      body.error(new Error('body read failed'));
      await assert.rejects(response.arrayBuffer(), /body read failed/);
    } else { body.enqueue(new Uint8Array([1])); body.close(); await response.arrayBuffer(); }
    await client.close();
    const observed = events.filter(event => event.phase.startsWith('body:'));
    assert.deepEqual(observed.map(event => event.phase), ['body:start', 'body:end']);
    assert.equal(observed[1].bodyOutcome, outcome);
    assert(observed[1].duration >= 10, `body duration ${observed[1].duration}`);
    assert.equal(events.at(-1).phase, 'request:end');
  }
});
