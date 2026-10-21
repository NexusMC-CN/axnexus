import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachRequestLogger,
  createHttpClient,
  createRequestLogger,
  createRequestLoggerPlugin,
  type RequestEvent,
  type RequestLogRecord,
} from '../../dist/index.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function terminal(records: RequestLogRecord[], path: string): RequestLogRecord {
  const matches = records.filter(record => record.phase !== 'start' && record.url?.includes(path));
  assert.equal(matches.length, 1, `one terminal record for ${path}`);
  return matches[0];
}

test('automatic metrics add every completed phase and isolate interleaved requests', () => {
  const records: RequestLogRecord[] = [];
  const plugin = createRequestLoggerPlugin(createRequestLogger(record => records.push(record))).create!();
  const emit = (requestId: string, phase: RequestEvent['phase'], details: Partial<RequestEvent> = {}) => {
    plugin.onEvent!({ requestId, phase, config: { url: `/${requestId}` }, context: undefined, ...details });
  };
  emit('a', 'request:start');
  emit('b', 'request:start');
  emit('a', 'attempt:start');
  emit('a', 'queue:end', { duration: 2 });
  emit('b', 'attempt:start');
  emit('b', 'queue:end', { duration: 19 });
  emit('a', 'retry:end', { duration: 7 });
  emit('a', 'attempt:start');
  emit('a', 'queue:end', { duration: 3 });
  emit('a', 'retry:end', { duration: 11 });
  emit('a', 'attempt:start');
  emit('a', 'queue:end', { duration: 5 });
  emit('a', 'body:end', { duration: 13, bodyOutcome: 'complete' });
  emit('a', 'request:end', { duration: 50 });
  emit('a', 'request:end', { duration: 51 });
  emit('b', 'cache:dedupe');
  emit('b', 'request:end', { duration: 23 });

  assert.deepEqual(terminal(records, '/a').timings, { queue: 10, retry: 18, body: 13 });
  assert.equal(terminal(records, '/a').attempts, 3);
  assert.equal(terminal(records, '/a').duration, 50);
  assert.deepEqual(terminal(records, '/b').timings, { queue: 19, retry: 0 });
  assert.equal(terminal(records, '/b').attempts, 1);
  assert.equal(terminal(records, '/b').cache, 'dedupe');
});

test('automatic logs measure real queue waits and accumulate retry delays', async () => {
  const records: RequestLogRecord[] = [];
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    retry: { limit: 2, delay: 20 },
    adapter: async config => {
      if (config.url.endsWith('/hold')) {
        entered.resolve();
        await release.promise;
        return Response.json({ held: true });
      }
      return Response.json({ attempt: ++attempts }, { status: attempts < 3 ? 503 : 200 });
    },
  });
  attachRequestLogger(client, createRequestLogger(record => records.push(record)));
  try {
    const holding = client.get('https://example.test/hold');
    await entered.promise;
    const queued = client.get('https://example.test/retry');
    await pause(20);
    release.resolve();
    await Promise.all([holding, queued]);

    const retried = terminal(records, '/retry');
    assert.equal(retried.attempts, 3);
    assert(retried.timings && retried.timings.queue >= 10);
    assert(retried.timings.retry >= 30);
    assert.equal(retried.cache, undefined);
    assert.equal(terminal(records, '/hold').attempts, 1);
    assert.equal(terminal(records, '/hold').timings?.retry, 0);
  } finally {
    release.resolve();
    await client.close();
  }
});

for (const outcome of ['EOF', 'cancel'] as const) {
  test(`raw ${outcome} logs one terminal record with body lifetime`, async () => {
    const records: RequestLogRecord[] = [];
    const client = createHttpClient({ adapter: async () => new Response('body-value') });
    attachRequestLogger(client, createRequestLogger(record => records.push(record)));
    try {
      const response = await client.get<Response>(`https://example.test/${outcome}`, { responseType: 'response' });
      assert.deepEqual(records.map(record => record.phase), ['start']);
      await pause(20);
      if (outcome === 'EOF') assert.equal(await response.text(), 'body-value');
      else await response.body!.cancel();

      const record = terminal(records, `/${outcome}`);
      assert.equal(record.phase, outcome === 'EOF' ? 'complete' : 'error');
      assert.equal(record.attempts, 1);
      assert(record.timings && record.timings.body !== undefined && record.timings.body >= 10);
      assert.equal(record.timings.retry, 0);
      assert(Number.isFinite(record.timings.queue) && record.timings.queue >= 0);
    } finally {
      await client.close();
    }
  });
}

test('cache hits and in-flight deduplication remain separate per logical request', async () => {
  const records: RequestLogRecord[] = [];
  let loads = 0;
  const client = createHttpClient({
    credentials: 'omit', cache: { ttl: 1000 },
    adapter: async () => {
      loads++;
      await pause(20);
      return Response.json({ value: 1 });
    },
  });
  attachRequestLogger(client, createRequestLogger(record => records.push(record)));
  try {
    const values = await Promise.all([client.get('/cached'), client.get('/cached')]);
    assert.deepEqual(values, [{ value: 1 }, { value: 1 }]);
    assert.deepEqual(await client.get('/cached'), { value: 1 });
    assert.equal(loads, 1);
    const finished = records.filter(record => record.phase !== 'start');
    assert.equal(finished.length, 3);
    assert.deepEqual(finished.map(record => record.cache ?? 'miss').sort(), ['dedupe', 'hit', 'miss']);
    assert(finished.every(record => record.attempts === 1));
    assert(finished.every(record => record.timings?.retry === 0));
    assert(finished.every(record => Number.isFinite(record.timings?.queue)));
  } finally {
    await client.close();
  }
});

test('detaching a shared plugin closes only its client and retains completed metrics', async () => {
  const records: RequestLogRecord[] = [];
  const plugin = createRequestLoggerPlugin(createRequestLogger(record => records.push(record)));
  let attempts = 0;
  const a = createHttpClient({
    retry: { limit: 1, delay: 20 },
    adapter: async () => new Response('value', { status: ++attempts === 1 ? 503 : 200 }),
  });
  const b = createHttpClient({ adapter: async () => new Response('other') });
  const detach = a.use(plugin);
  b.use(plugin);
  try {
    const rawA = await a.get<Response>('/detached', { responseType: 'response' });
    const rawB = await b.get<Response>('/remaining', { responseType: 'response' });
    await detach();
    const detached = terminal(records, '/detached');
    assert.equal(detached.phase, 'error');
    assert.equal(detached.attempts, 2);
    assert(detached.timings && detached.timings.retry >= 10);
    assert(Number.isFinite(detached.timings.queue) && detached.timings.queue >= 0);
    assert.equal(records.filter(record => record.phase !== 'start' && record.url === '/remaining').length, 0);
    assert.equal(await rawA.text(), 'value');
    assert.equal(await rawB.text(), 'other');
    assert.equal(terminal(records, '/remaining').phase, 'complete');
    assert.equal(terminal(records, '/remaining').attempts, 1);
    assert.equal(terminal(records, '/remaining').timings?.retry, 0);
    terminal(records, '/detached');
  } finally {
    await a.close();
    await b.close();
  }
});

test('automatic failure metrics retain redaction and omit context and payloads', async () => {
  const records: RequestLogRecord[] = [];
  const client = createHttpClient({
    context: { secret: 'private-context' },
    headers: { Authorization: 'private-authorization', Cookie: 'private-cookie' },
    adapter: async () => Response.json({ secret: 'private-response' }, { status: 503 }),
  });
  attachRequestLogger(client, createRequestLogger(record => records.push(record)));
  try {
    await assert.rejects(client.post('https://example.test/failure?token=private-query&sort=asc', {
      secret: 'private-request',
    }));
    const record = terminal(records, '/failure');
    assert.equal(record.phase, 'error');
    assert.equal(record.status, 503);
    assert.equal(record.attempts, 1);
    assert(record.timings && record.timings.retry === 0 && record.timings.queue >= 0);
    assert(record.url?.includes('sort=asc'));
    const output = JSON.stringify(records);
    for (const secret of ['private-context', 'private-authorization', 'private-cookie', 'private-response', 'private-query', 'private-request']) {
      assert(!output.includes(secret), `${secret} must remain private`);
    }
    assert(!('context' in record));
    assert(!('data' in record));
    assert(!('body' in record));
  } finally {
    await client.close();
  }
});
