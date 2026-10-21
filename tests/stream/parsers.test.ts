import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, parseNDJSON, connectSSE } from '../../dist/stream/index.js';
import { createHttpClient } from '../../dist/index.js';

const encoder = new TextEncoder();

test('connectSSE cancels non-2xx bodies before reconnecting independently of client retry policy', async () => {
  let attempts = 0;
  let canceled = 0;
  const client = createHttpClient({ retryOn: [], adapter: async () => {
    attempts++;
    if (attempts === 1) return new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 503 });
    return new Response('data: recovered\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const received = [];
    for await (const event of connectSSE(client, 'https://example.test/events', {
      signal: controller.signal, idleTimeout: 10, reconnect: { maxAttempts: 2, delay: 0 },
    })) received.push(event.data);
    assert.deepEqual(received, ['recovered']);
    assert.equal(attempts, 2);
    assert.equal(canceled, 1);
  } finally { clearTimeout(timer); await client.close(); }
});
const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

function source(chunks: Uint8Array[], close = true) {
  let pulls = 0;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else if (close) controller.close();
    },
    cancel() { cancels += 1; },
  }, { highWaterMark: 0 });
  return { response: new Response(body), body, pulls: () => pulls, cancels: () => cancels };
}

test('SSE preserves UTF-8, CRLF, multiline data and metadata at every byte boundary', async () => {
  const bytes = encoder.encode('\uFEFF:comment\r\nid: 42\r\nretry: 12\r\nevent: update\r\ndata: 中文😀\r\ndata: next\r\n\r\ndata: done\n\n');
  for (let offset = 0; offset <= bytes.length; offset += 1) {
    const { response } = source([bytes.slice(0, offset), bytes.slice(offset)]);
    assert.deepEqual(await collect(parseSSE(response)), [
      { data: '中文😀\nnext', event: 'update', id: '42', retry: 12 },
      { data: 'done', event: 'message', id: '42', retry: 12 },
    ], `split ${offset}`);
  }
});

test('SSE handles bare CR, empty data, invalid controls, id reset, and discards EOF residual frames', async () => {
  const { response } = source([encoder.encode('id: first\rdata:\r\rid: bad\0id\nretry: nope\ndata: x\n\nid:\ndata: y\n\ndata: unfinished\n')]);
  assert.deepEqual(await collect(parseSSE(response)), [
    { data: '', event: 'message', id: 'first' },
    { data: 'x', event: 'message', id: 'first' },
    { data: 'y', event: 'message', id: '' },
  ]);
});

test('NDJSON decodes split UTF-8, multiple lines and an unterminated final record', async () => {
  const bytes = encoder.encode('\uFEFF{"x":"中文😀"}\r\n\n{"x":2}\n{"x":3}');
  const { response } = source(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  assert.deepEqual(await collect(parseNDJSON(response)), [{ x: '中文😀' }, { x: 2 }, { x: 3 }]);
});

test('SSE only parses JSON when requested and then validates each message', async () => {
  const schema = { '~standard': { validate(value: unknown) {
    return typeof value === 'object' && value !== null && 'x' in value
      ? { value: String((value as { x: unknown }).x) }
      : { issues: [{ message: 'x required', path: ['x'] }] };
  } } };
  const { response } = source([encoder.encode('data: {"x":2}\n\n')]);
  assert.deepEqual(await collect(parseSSE(response, { parseJson: JSON.parse, schema })), [{ data: '2', event: 'message', id: '' }]);
});

test('each complete message has its own byte budget including SSE metadata and comments', async () => {
  assert.equal((await collect(parseSSE(new Response('data: x\n\ndata: y\n\n'), { maxMessageSize: 7 }))).length, 2);
  for (const input of ['event: very-long-name\ndata: x\n\n', ':long-comment\n\n', 'data: 中文\n\n']) {
    const tracked = source([encoder.encode(input)], false);
    await assert.rejects(collect(parseSSE(tracked.response, { maxMessageSize: 10 })), { code: 'ERR_MAX_BODY_SIZE' });
    assert.equal(tracked.cancels(), 1);
    assert.equal(tracked.body.locked, false);
  }
  await assert.rejects(collect(parseNDJSON(new Response('"中文"'), { maxMessageSize: 7 })), { code: 'ERR_MAX_BODY_SIZE' });
  assert.deepEqual(await collect(parseNDJSON(new Response('\n'), { maxMessageSize: 0 })), []);
});

test('SSE enforces the remaining frame budget before another newline or EOF', async () => {
  const tracked = source([encoder.encode('id: 123\ndata: x')], false);
  await assert.rejects(collect(parseSSE(tracked.response, { maxMessageSize: 12, signal: AbortSignal.timeout(50) })), { code: 'ERR_MAX_BODY_SIZE' });
  assert.equal(tracked.pulls(), 1);
  assert.equal(tracked.cancels(), 1);
});

test('default message budget rejects an unterminated oversized record', async () => {
  const tracked = source([new Uint8Array(1_048_577).fill(120)], false);
  await assert.rejects(collect(parseNDJSON(tracked.response)), { code: 'ERR_MAX_BODY_SIZE' });
  assert.equal(tracked.cancels(), 1);
});

test('invalid stream limits fail as configuration errors before reading', async () => {
  for (const maxMessageSize of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const tracked = source([], false);
    await assert.rejects(async () => collect(parseNDJSON(tracked.response, { maxMessageSize })), { code: 'ERR_INVALID_CONFIG' });
    assert.equal(tracked.pulls(), 0);
  }
  for (const idleTimeout of [-1, NaN, Infinity]) {
    await assert.rejects(async () => collect(parseSSE(new Response(''), { idleTimeout })), { code: 'ERR_INVALID_CONFIG' });
  }
});

test('break cancels and unlocks without reading the next source chunk', async () => {
  const tracked = source([encoder.encode('data: one\n\n'), encoder.encode('data: two\n\n')], false);
  for await (const event of parseSSE(tracked.response)) {
    assert.equal(event.data, 'one');
    break;
  }
  assert.equal(tracked.pulls(), 1);
  assert.equal(tracked.cancels(), 1);
  assert.equal(tracked.body.locked, false);
});

test('slow consumers do not pre-read or pre-parse messages from a source chunk', async () => {
  let parsed = 0;
  const tracked = source([encoder.encode('1\n2\n3\n'), encoder.encode('4\n')], false);
  const iterator = parseNDJSON(tracked.response, { parseJson(text) { parsed += 1; return JSON.parse(text); } })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tracked.pulls(), 1);
  assert.equal(parsed, 1);
  await iterator.return?.();
  assert.equal(tracked.cancels(), 1);
});

test('return cancels an outstanding next call and releases its lock', async () => {
  const tracked = source([], false);
  const iterator = parseNDJSON(tracked.response)[Symbol.asyncIterator]();
  const pending = iterator.next();
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await iterator.return?.();
  await rejection;
  assert.equal(tracked.cancels(), 1);
  assert.equal(tracked.body.locked, false);
});

test('abort cancels idle and suspended iterators immediately', async () => {
  for (const suspended of [false, true]) {
    const controller = new AbortController();
    const tracked = source(suspended ? [encoder.encode('data: first\n\n')] : [], false);
    const iterator = parseSSE(tracked.response, { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    if (suspended) await pending;
    controller.abort();
    await assert.rejects(suspended ? iterator.next() : pending, { name: 'AbortError' });
    assert.equal(tracked.cancels(), 1);
    assert.equal(tracked.body.locked, false);
  }
});

test('idle timeout cancels a stalled read and releases the lock', async () => {
  const tracked = source([], false);
  await assert.rejects(collect(parseSSE(tracked.response, { idleTimeout: 5 })), { code: 'ETIMEDOUT' });
  assert.equal(tracked.cancels(), 1);
  assert.equal(tracked.body.locked, false);
});

test('a long idle timeout does not overflow into an immediate timeout', async () => {
  const controller = new AbortController();
  const tracked = source([], false);
  const pending = collect(parseNDJSON(tracked.response, { signal: controller.signal, idleTimeout: 2_147_483_648 }));
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tracked.cancels(), 0);
  controller.abort();
  await rejection;
});

test('parse and schema failures cancel the source without consuming later messages', async () => {
  for (const schemaFailure of [false, true]) {
    const tracked = source([encoder.encode(schemaFailure ? '{}\n' : '{bad}\n'), encoder.encode('{}\n')], false);
    const schema = schemaFailure ? { '~standard': { validate: () => ({ issues: [{ message: 'bad value' }] }) } } : undefined;
    await assert.rejects(collect(parseNDJSON(tracked.response, { schema })), { code: schemaFailure ? 'ERR_SCHEMA_VALIDATION' : 'ERR_BAD_PAYLOAD' });
    assert.equal(tracked.pulls(), 1);
    assert.equal(tracked.cancels(), 1);
    assert.equal(tracked.body.locked, false);
  }
});

test('abort interrupts a parser or validator that never resolves', async () => {
  for (const validation of [false, true]) {
    const controller = new AbortController();
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const pendingWork = () => { started(); return new Promise<never>(() => {}); };
    const tracked = source([encoder.encode('{}\n')], false);
    const options = validation ? { schema: { '~standard': { validate: pendingWork } } } : { parseJson: pendingWork };
    const pending = collect(parseNDJSON(tracked.response, { ...options, signal: controller.signal }));
    await began;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(tracked.cancels(), 1);
    assert.equal(tracked.body.locked, false);
  }
});

test('EOF releases the reader without canceling an already closed source', async () => {
  const tracked = source([encoder.encode('1\n')]);
  assert.deepEqual(await collect(parseNDJSON(tracked.response)), [1]);
  assert.equal(tracked.cancels(), 0);
  assert.equal(tracked.body.locked, false);
});

test('SSE reconnect uses the latest event id and bounded attempts after a read error', async () => {
  const requests: Array<{ headers: Headers; retry: unknown; cache: unknown }> = [];
  let attempts = 0;
  const client = { async request(_url: string, config: any) {
    requests.push({ headers: new Headers(config.headers), retry: config.retry, cache: config.cache });
    attempts += 1;
    if (attempts === 1) {
      let reads = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(encoder.encode('id: 42\nretry: 0\ndata: one\n\n'));
        else controller.error(new Error('disconnected'));
      } }, { highWaterMark: 0 }));
    }
    return new Response('data: two\n\n');
  } };
  const result = await collect(connectSSE(client as any, '/events', { reconnect: { maxAttempts: 2, delay: 0 } }));
  assert.deepEqual(result.map((event) => event.data), ['one', 'two']);
  assert.equal(requests[1].headers.get('last-event-id'), '42');
  assert.equal(requests[0].retry, 0);
  assert.equal(requests[0].cache, false);
  assert.equal(attempts, 2);
});

test('connectSSE consumes a real raw client incrementally and owns break cancellation', async () => {
  const tracked = source([encoder.encode('data: first\n\n'), encoder.encode('data: second\n\n')], false);
  const client = createHttpClient({ adapter: async () => tracked.response });
  for await (const event of connectSSE(client, '/events')) {
    assert.equal(event.data, 'first');
    break;
  }
  assert.equal(tracked.cancels(), 1);
  assert.equal(tracked.body.locked, false);
  assert.ok(tracked.pulls() <= 2);
  await client.close();
});

test('connectSSE forwards typed context and overrides client schema and response transforms', async () => {
  const contexts: Array<{ traceId: string } | undefined> = [];
  let defaultValidations = 0;
  let defaultTransforms = 0;
  const client = createHttpClient<{ traceId: string }>({
    schema: { '~standard': { validate() { defaultValidations += 1; return { value: 999 }; } } },
    transformResponse: () => { defaultTransforms += 1; return 999; },
    adapter: async () => new Response('data: {"id":7}\n\n'),
  });
  client.interceptors.request.use((config) => {
    contexts.push(config.context);
    return config;
  });
  const raw = await collect(connectSSE(client, '/events', { request: { context: { traceId: 'raw' } } }));
  assert.deepEqual(raw, [{ data: '{"id":7}', event: 'message', id: '' }]);
  const validated = await collect(connectSSE(client, '/events', {
    request: { context: { traceId: 'validated' } }, parseJson: JSON.parse,
    schema: { '~standard': { validate(value: unknown) {
      return { value: String((value as { id: number }).id) };
    } } },
  }));
  assert.deepEqual(validated, [{ data: '7', event: 'message', id: '' }]);
  assert.deepEqual(contexts, [{ traceId: 'raw' }, { traceId: 'validated' }]);
  assert.equal(defaultValidations, 0);
  assert.equal(defaultTransforms, 0);
  await client.close();
});

test('connectSSE accepts a client with an inferred default schema and owns event validation', async () => {
  let validations = 0;
  const client = createHttpClient({
    schema: { '~standard': { validate() { validations += 1; return { value: 999 }; } } },
    adapter: async () => new Response('data: text\n\n'),
  });
  assert.deepEqual(await collect(connectSSE(client, '/events')), [{ data: 'text', event: 'message', id: '' }]);
  assert.equal(validations, 0);
  await client.close();
});

test('id-only frames update the resume id, and an unfinished EOF frame does not', async () => {
  const seen: Array<string | null> = [];
  let attempts = 0;
  const client = { request: async (_url: string, config: any) => {
    seen.push(new Headers(config.headers).get('last-event-id'));
    attempts += 1;
    if (attempts === 1) return new Response('id: committed\n\nid: unfinished\n');
    return new Response('data: ok\n\n');
  } };
  await collect(connectSSE(client as any, '/events', { reconnect: { maxAttempts: 2, retryOnEOF: true, delay: 0 } }));
  assert.deepEqual(seen, [null, 'committed']);
});

test('id reset removes Last-Event-ID and server delay is capped', async () => {
  let attempts = 0;
  const seen: Array<string | null> = [];
  const client = { request: async (_url: string, config: any) => {
    seen.push(new Headers(config.headers).get('last-event-id'));
    attempts += 1;
    return new Response(attempts === 1 ? 'id:\nretry: 999999999\n\ndata: first\n\n' : 'data: second\n\n');
  } };
  const result = await collect(connectSSE(client as any, '/events', {
    request: { headers: { 'Last-Event-ID': 'initial' } },
    reconnect: { maxAttempts: 2, retryOnEOF: true, delay: 1000, maxDelay: 0 },
  }));
  assert.equal(result.length, 2);
  assert.deepEqual(seen, ['initial', null]);
});

test('normal EOF ends by default; explicit EOF reconnect remains finite', async () => {
  let attempts = 0;
  const client = { request: async () => { attempts += 1; return new Response('data: one\n\n'); } };
  assert.equal((await collect(connectSSE(client as any, '/events', { reconnect: { maxAttempts: 3, delay: 0 } }))).length, 1);
  attempts = 0;
  assert.equal((await collect(connectSSE(client as any, '/events', { reconnect: { maxAttempts: 3, delay: 0, retryOnEOF: true } }))).length, 3);
  assert.equal(attempts, 3);
});

test('application completion is opt-in and stops without reconnecting', async () => {
  const tracked = source([encoder.encode('data: [DONE]\n\ndata: more\n\n')], false);
  let attempts = 0;
  const client = { request: async () => { attempts += 1; return tracked.response; } };
  const result = await collect(connectSSE(client as any, '/events', {
    reconnect: { maxAttempts: 3, retryOnEOF: true, delay: 0 },
    isComplete: (event: { data: string }) => event.data === '[DONE]',
  }));
  assert.deepEqual(result, []);
  assert.equal(attempts, 1);
  assert.equal(tracked.cancels(), 1);
});

test('reconnect waits cancel without opening another connection', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = { request: async () => { attempts += 1; return new Response('data: one\n\n'); } };
  const iterator = connectSSE(client as any, '/events', { signal: controller.signal, reconnect: { maxAttempts: 3, retryOnEOF: true, delay: 1000 } })[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(attempts, 1);
});

test('return interrupts a long reconnect wait without another connection', async () => {
  let attempts = 0;
  const client = { request: async () => { attempts += 1; return new Response('data: one\n\n'); } };
  const iterator = connectSSE(client as any, '/events', { reconnect: { maxAttempts: 3, retryOnEOF: true, delay: 2_147_483_648, maxDelay: 2_147_483_648 } })[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(attempts, 1);
  await iterator.return?.();
  await rejection;
});

test('204 stops an EOF reconnect policy', async () => {
  let attempts = 0;
  const client = { request: async () => { attempts += 1; return new Response(null, { status: 204 }); } };
  assert.deepEqual(await collect(connectSSE(client as any, '/events', { reconnect: { maxAttempts: 3, retryOnEOF: true, delay: 0 } })), []);
  assert.equal(attempts, 1);
});

test('invalid reconnect bounds fail without sending a request', async () => {
  let attempts = 0;
  const client = { request: async () => { attempts += 1; return new Response(''); } };
  for (const reconnect of [
    { maxAttempts: 0 }, { maxAttempts: Infinity }, { maxAttempts: 1.5 },
    { maxAttempts: 2, delay: -1 }, { maxAttempts: 2, maxDelay: Infinity },
  ]) {
    await assert.rejects(async () => collect(connectSSE(client as any, '/events', { reconnect })), { code: 'ERR_INVALID_CONFIG' });
  }
  assert.equal(attempts, 0);
});

test('reconnect never retries schema errors or implicitly replays POST', async () => {
  let attempts = 0;
  const client = { request: async () => { attempts += 1; return new Response('data: {}\n\n'); } };
  await assert.rejects(async () => collect(connectSSE(client as any, '/events', { request: { method: 'POST', body: '{}' }, reconnect: { maxAttempts: 2 } })), { code: 'ERR_INVALID_CONFIG' });
  assert.equal(attempts, 0);
  const schema = { '~standard': { validate: () => ({ issues: [{ message: 'no' }] }) } };
  await assert.rejects(collect(connectSSE(client as any, '/events', { parseJson: JSON.parse, schema, reconnect: { maxAttempts: 3, delay: 0 } })), { code: 'ERR_SCHEMA_VALIDATION' });
  assert.equal(attempts, 1);
});
