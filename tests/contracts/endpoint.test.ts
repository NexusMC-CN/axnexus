import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/core/client.js';
import { HttpError } from '../../dist/core/errors.js';
import { SchemaValidationError } from '../../dist/core/schema.js';
import { defineEndpoint, DomainError } from '../../dist/contracts/index.js';

const numberInput = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' && /^\d+$/.test(value)
    ? { value: { page: Number(value), tag: ['a&b', '中文'] } }
    : { issues: [{ message: 'page must be digits' }] };
} } };
const output = { '~standard': { validate(value: unknown) {
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'number'
    ? { value: { identifier: String(value.id) } }
    : { issues: [{ message: 'id must be a number' }] };
} } };
const conflict = { '~standard': { validate(value: unknown) {
  return value && typeof value === 'object' && 'reason' in value && typeof value.reason === 'string'
    ? { value: { reason: value.reason.toUpperCase() } }
    : { issues: [{ message: 'reason required' }] };
} } };

test('endpoint validates and transforms query, body and output with encoded path segments', async () => {
  const seen: unknown[] = [];
  const client = createHttpClient({ baseURL: 'https://contracts.example.test', adapter: async (config) => {
    seen.push({ url: config.url, method: config.method, body: config.body });
    return Response.json({ id: 7 });
  } });
  const endpoint = defineEndpoint({ method: 'POST', path: '/items/{id}', query: numberInput,
    body: { '~standard': { async validate(value: unknown) { return { value: { wrapped: value } }; } } }, output });
  assert.deepEqual(await endpoint.bind(client).call({ params: { id: 'a/b?c#d' }, query: '2', body: 'hello' }), { identifier: '7' });
  assert.deepEqual(seen, [{
    url: 'https://contracts.example.test/items/a%2Fb%3Fc%23d?page=2&tag=a%26b&tag=%E4%B8%AD%E6%96%87',
    method: 'POST', body: '{"wrapped":"hello"}',
  }]);
});

test('invalid endpoint input fails before adapter I/O', async () => {
  let calls = 0;
  const client = createHttpClient({ adapter: async () => { calls++; return Response.json({ id: 1 }); } });
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', query: numberInput });
  await assert.rejects(endpoint.call(client, { query: 'bad' }), SchemaValidationError);
  const result = await endpoint.safeCall(client, { query: 'bad' });
  assert.equal(result.kind, 'unexpected');
  assert.equal(calls, 0);
});

test('endpoint business errors require both their declared status and schema', async () => {
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', errors: { CONFLICT: { status: 409, schema: conflict } } });
  const client = createHttpClient({ adapter: async () => Response.json({ reason: 'duplicate' }, { status: 409 }) });
  await assert.rejects(endpoint.call(client), (error: unknown) =>
    error instanceof DomainError && error.code === 'CONFLICT' && error.status === 409 && error.data.reason === 'DUPLICATE');
  const result = await endpoint.bind(client).safeCall();
  assert.equal(result.kind, 'domain');
  if (result.kind === 'domain') {
    assert.equal(result.error.code, 'CONFLICT');
    assert.deepEqual(result.error.data, { reason: 'DUPLICATE' });
  }
});

test('matching status with invalid error payload falls back to HTTP error', async () => {
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', errors: { CONFLICT: { status: 409, schema: conflict } } });
  const client = createHttpClient({ adapter: async () => Response.json({ unknown: true }, { status: 409 }) });
  const result = await endpoint.safeCall(client);
  assert.equal(result.kind, 'http');
  if (result.kind === 'http') {
    assert.equal(result.error.code, 'ERR_BAD_RESPONSE');
    assert.equal(result.error.status, 409);
    assert.deepEqual(result.error.response?.data, { unknown: true });
  }
});

test('matching error schema on an undeclared status remains an HTTP error', async () => {
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', errors: { CONFLICT: { status: 409, schema: conflict } } });
  const client = createHttpClient({ adapter: async () => Response.json({ reason: 'duplicate' }, { status: 403 }) });
  assert.equal((await endpoint.safeCall(client)).kind, 'http');
});

test('non-JSON HTTP errors keep their HTTP classification', async () => {
  const client = createHttpClient({ adapter: async () => new Response('upstream unavailable', { status: 502 }) });
  const endpoint = defineEndpoint({ method: 'GET', path: '/items' });
  const result = await endpoint.safeCall(client);
  assert.equal(result.kind, 'http');
  if (result.kind === 'http') assert.equal(result.error.response?.data, 'upstream unavailable');
});

test('safe endpoint results distinguish success, network, timeout and unexpected schema failures', async () => {
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', output });
  const success = createHttpClient({ adapter: async () => Response.json({ id: 3 }) });
  assert.deepEqual(await endpoint.safeCall(success), { kind: 'success', data: { identifier: '3' } });
  const network = createHttpClient({ adapter: async () => { throw new Error('offline'); } });
  const networkResult = await endpoint.safeCall(network);
  assert.equal(networkResult.kind, 'transport');
  if (networkResult.kind === 'transport') assert.equal(networkResult.error.code, 'ERR_NETWORK');
  const timeout = createHttpClient({ timeout: 5, adapter: async () => new Promise(() => {}) });
  const timeoutResult = await endpoint.safeCall(timeout);
  assert.equal(timeoutResult.kind, 'transport');
  if (timeoutResult.kind === 'transport') assert.equal(timeoutResult.error.code, 'ETIMEDOUT');
  const invalid = createHttpClient({ adapter: async () => Response.json({ id: 'wrong' }) });
  const invalidResult = await endpoint.safeCall(invalid);
  assert.equal(invalidResult.kind, 'unexpected');
  if (invalidResult.kind === 'unexpected') assert.ok(invalidResult.error instanceof SchemaValidationError);
});

test('endpoint own schema verifies output after client transforms and handles null explicitly', async () => {
  const client = createHttpClient({ adapter: async () => Response.json({ id: 8 }),
    transformResponse: () => 'unsafe default', schema: { '~standard': { validate: () => ({ issues: [{ message: 'unsafe default' }] }) } } });
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', output });
  assert.deepEqual(await endpoint.call(client), { identifier: '8' });
  const nullEndpoint = defineEndpoint({ method: 'GET', path: '/empty', output: {
    '~standard': { validate(value: unknown) { return value === null ? { value: 'empty' } : { issues: [{ message: 'null required' }] }; } },
  } });
  const empty = createHttpClient({ adapter: async () => new Response(null, { status: 204 }) });
  assert.equal(await nullEndpoint.call(empty), 'empty');
});

test('unsafe or missing path segments are rejected before I/O', async () => {
  let calls = 0;
  const client = createHttpClient({ adapter: async () => { calls++; return Response.json(null); } });
  const endpoint = defineEndpoint({ method: 'GET', path: '/items/{id}' });
  for (const id of ['.', '..']) await assert.rejects(endpoint.call(client, { params: { id } }), TypeError);
  await assert.rejects(endpoint.call(client, {} as never), TypeError);
  for (const path of ['//evil.test/x', '/\\evil.test/x', 'https://evil.test/x', '/items?x=y', '/items/{bad']) {
    assert.throws(() => defineEndpoint({ method: 'GET', path }), TypeError);
  }
  assert.equal(calls, 0);
});

test('undeclared caller exceptions stay unexpected', async () => {
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', output: {
    '~standard': { validate() { throw new Error('validator bug'); } },
  } });
  const client = createHttpClient({ adapter: async () => Response.json({}) });
  const result = await endpoint.safeCall(client);
  assert.equal(result.kind, 'unexpected');
  if (result.kind === 'unexpected') assert.equal((result.error as Error).message, 'validator bug');
});

test('endpoint query serialization preserves prototype-like keys and rejects nested values before I/O', async () => {
  const urls: string[] = [];
  const client = createHttpClient({ adapter: async (config) => { urls.push(config.url); return Response.json(null); } });
  const query = { '~standard': { validate(value: unknown) { return { value }; } } };
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', query });
  await endpoint.call(client, { query: JSON.parse('{"__proto__":"literal","constructor":"value"}') });
  assert.deepEqual(urls, ['/items?__proto__=literal&constructor=value']);
  await assert.rejects(endpoint.call(client, { query: { nested: { unsafe: true } } }), TypeError);
  assert.equal(urls.length, 1);
});

test('same-status business error alternatives validate before narrowing to their own code', async () => {
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', errors: {
    INVALID: { status: 409, schema: { '~standard': { validate() { return { issues: [{ message: 'not this body' }] }; } } } },
    CONFLICT: { status: 409, schema: conflict },
  } });
  const client = createHttpClient({ adapter: async () => Response.json({ reason: 'duplicate' }, { status: 409 }) });
  const result = await endpoint.safeCall(client);
  assert.equal(result.kind, 'domain');
  if (result.kind === 'domain') assert.equal(result.error.code, 'CONFLICT');
});

async function settles<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Contract did not settle after cancellation')), 500);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const phase of ['query', 'body', 'output', 'error'] as const) {
  for (const deadline of ['timeout', 'totalTimeout'] as const) {
    test(`client default ${deadline} covers a hanging ${phase} contract validator`, async () => {
      let calls = 0;
      const hanging = { '~standard': { validate: () => new Promise<never>(() => {}) } };
      const client = createHttpClient({ [deadline]: 10, adapter: async () => {
        calls++;
        return Response.json({}, { status: phase === 'error' ? 409 : 200 });
      } });
      const endpoint = defineEndpoint({ method: 'POST', path: '/items',
        ...(phase === 'query' ? { query: hanging } : {}),
        ...(phase === 'body' ? { body: hanging } : {}),
        ...(phase === 'output' ? { output: hanging } : {}),
        ...(phase === 'error' ? { errors: { CONFLICT: { status: 409, schema: hanging } } } : {}),
      });
      const result = await settles(endpoint.safeCall(client, { query: {}, body: {} } as never));
      assert.equal(result.kind, 'transport');
      if (result.kind === 'transport') {
        assert.equal(result.error.code, 'ETIMEDOUT');
        assert.equal(result.error.isTimeout, true);
      }
      assert.equal(calls, phase === 'query' || phase === 'body' ? 0 : 1);
    });
  }

  for (const source of ['client', 'request'] as const) {
    test(`${source} signal cancels a hanging ${phase} contract validator`, async () => {
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const hanging = { '~standard': { validate() { started(); return new Promise<never>(() => {}); } } };
      const controller = new AbortController();
      let calls = 0;
      const client = createHttpClient({ ...(source === 'client' ? { signal: controller.signal } : {}), adapter: async () => {
        calls++;
        return Response.json({}, { status: phase === 'error' ? 409 : 200 });
      } });
      const endpoint = defineEndpoint({ method: 'POST', path: '/items',
        ...(phase === 'query' ? { query: hanging } : {}),
        ...(phase === 'body' ? { body: hanging } : {}),
        ...(phase === 'output' ? { output: hanging } : {}),
        ...(phase === 'error' ? { errors: { CONFLICT: { status: 409, schema: hanging } } } : {}),
      });
      const pending = endpoint.safeCall(client, { query: {}, body: {} } as never,
        source === 'request' ? { signal: controller.signal } : undefined);
      await entered;
      controller.abort('stop contract');
      const result = await settles(pending);
      assert.equal(result.kind, 'transport');
      if (result.kind === 'transport') {
        assert.equal(result.error.code, 'ERR_CANCELED');
        assert.equal(result.error.isAbort, true);
      }
      assert.equal(calls, phase === 'query' || phase === 'body' ? 0 : 1);
    });
  }
}

test('request deadlines cover contract validation and override the corresponding client defaults', async () => {
  const hanging = { '~standard': { validate: () => new Promise<never>(() => {}) } };
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', output: hanging });
  const client = createHttpClient({ timeout: 1000, totalTimeout: 1000, adapter: async () => Response.json({}) });
  for (const config of [{ timeout: 10 }, { totalTimeout: 10 }]) {
    const result = await settles(endpoint.safeCall(client, {}, config));
    assert.equal(result.kind, 'transport');
    if (result.kind === 'transport') assert.equal(result.error.code, 'ETIMEDOUT');
  }
});

test('canceling input validation prevents late validator completion from sending a request', async () => {
  let finish!: (result: { value: {} }) => void;
  let calls = 0;
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', query: {
    '~standard': { validate: () => new Promise<{ value: {} }>((resolve) => { finish = resolve; }) },
  } });
  const client = createHttpClient({ timeout: 10, adapter: async () => { calls++; return Response.json({}); } });
  const result = await settles(endpoint.safeCall(client, { query: {} }));
  assert.equal(result.kind, 'transport');
  finish({ value: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('already aborted client defaults skip contract validators and adapter I/O', async () => {
  const controller = new AbortController();
  controller.abort();
  let validators = 0;
  let calls = 0;
  const client = createHttpClient({ signal: controller.signal, adapter: async () => { calls++; return Response.json({}); } });
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', query: {
    '~standard': { validate() { validators++; return { value: {} }; } },
  } });
  const result = await endpoint.safeCall(client, { query: {} });
  assert.equal(result.kind, 'transport');
  assert.equal(validators, 0);
  assert.equal(calls, 0);
});

test('validator-thrown DomainError cannot enter the declared domain result branch', async () => {
  const client = createHttpClient({ adapter: async () => Response.json({}) });
  const response = await client.getResponse('/fixture');
  for (const code of ['UNDECLARED', 'CONFLICT']) {
    const injected = new DomainError(code, 42, response);
    const endpoint = defineEndpoint({ method: 'GET', path: '/items', output: {
      '~standard': { validate() { throw injected; } },
    }, errors: { CONFLICT: { status: 409, schema: conflict } } });
    const result = await endpoint.safeCall(client);
    assert.equal(result.kind, 'unexpected');
    if (result.kind === 'unexpected') assert.equal(result.error, injected);
  }
});

test('a genuine DomainError from an earlier invocation cannot impersonate the current invocation', async () => {
  const client = createHttpClient({ adapter: async () => Response.json({ reason: 'duplicate' }, { status: 409 }) });
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', errors: { CONFLICT: { status: 409, schema: conflict } } });
  let earlier: unknown;
  try { await endpoint.call(client); } catch (error) { earlier = error; }
  assert.ok(earlier instanceof DomainError);
  const forged = defineEndpoint({ method: 'GET', path: '/items', query: {
    '~standard': { validate() { throw earlier; } },
  }, errors: { CONFLICT: { status: 409, schema: conflict } } });
  const result = await forged.safeCall(client, { query: {} });
  assert.equal(result.kind, 'unexpected');
});

test('output validation does not claim nested HTTP errors as endpoint business errors', async () => {
  const nested = createHttpClient({ adapter: async () => Response.json({ reason: 'nested conflict' }, { status: 409 }) });
  const client = createHttpClient({ adapter: async () => Response.json({ id: 1 }) });
  let nestedError: unknown;
  const endpoint = defineEndpoint({ method: 'GET', path: '/items', output: {
    '~standard': { async validate(value: unknown) {
      try { await nested.get('/nested'); }
      catch (error) { nestedError = error; throw error; }
      return { value };
    } },
  }, errors: { CONFLICT: { status: 409, schema: conflict } } });
  try {
    const result = await endpoint.safeCall(client);
    assert.equal(result.kind, 'http');
    if (result.kind === 'http') {
      assert.equal(result.error, nestedError);
      assert.equal(result.error.code, 'ERR_BAD_RESPONSE');
      assert.equal(result.error.response?.config.url, '/nested');
    }
  } finally { await Promise.all([client.close(), nested.close()]); }
});
