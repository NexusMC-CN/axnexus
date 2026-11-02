import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/core/client.js';
import { HttpError } from '../../dist/core/errors.js';
import { AxiosHeaders } from '../../dist/headers/headers.js';
import { array, defineSelectionResource, leaf, object } from '../../dist/selection/contract.js';
import { createSelectionClient } from '../../dist/selection/client.js';
import { SelectionError } from '../../dist/selection/errors.js';

const stringSchema = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected string' }] };
} } };
const argsSchema = { '~standard': { validate(value: unknown) { return { value }; } } };
const userResource = defineSelectionResource({
  resource: 'users.byId.v1', args: argsSchema, nullable: true,
  fields: {
    id: leaf(stringSchema),
    email: leaf(stringSchema, { nullable: true }),
    profile: object({ avatar: leaf(stringSchema) }, { nullable: true }),
    teams: array(object({ name: leaf(stringSchema) })),
  },
});
const selected = { id: true, profile: { avatar: true }, teams: { name: true } } as const;
const projected = { id: '42', profile: { avatar: 'pic' }, teams: [{ name: 'core' }] };
const endpoint = 'https://selection.example.test/__axnexus/select';

test('selection client sends versioned POST and returns selected data', async () => {
  const requests: Array<{ url: string; method: string; body: unknown; contentType: string | null }> = [];
  const http = createHttpClient({ adapter: async (config) => {
    requests.push({ url: config.url, method: config.method, body: JSON.parse(String(config.body)),
      contentType: config.headers.get('Content-Type') });
    return Response.json({ data: projected });
  } });
  const client = createSelectionClient(http, { endpoint });
  assert.deepEqual(await client.select(userResource, { args: { id: '42' }, select: selected }), projected);
  assert.deepEqual(requests, [{
    url: endpoint, method: 'POST', contentType: 'application/json',
    body: { protocol: 'axnexus.selection', version: 1, resource: 'users.byId.v1',
      args: { id: '42' }, select: selected },
  }]);
});

test('selection client accepts a nullable root and nullable selected field', async () => {
  let result: unknown = { data: null };
  const http = createHttpClient({ adapter: async () => Response.json(result) });
  const client = createSelectionClient(http, { endpoint });
  assert.equal(await client.select(userResource, { args: {}, select: { email: true } }), null);
  result = { data: { email: null } };
  assert.deepEqual(await client.select(userResource, { args: {}, select: { email: true } }), { email: null });
});

test('selection client rejects unknown selection before sending a request', async () => {
  let calls = 0;
  const http = createHttpClient({ adapter: async () => { calls += 1; return Response.json({ data: projected }); } });
  const client = createSelectionClient(http, { endpoint });
  await assert.rejects(client.select(userResource, { args: {}, select: { secret: true } as never }), SelectionError);
  assert.equal(calls, 0);
});

test('selection client rejects malformed success envelopes', async () => {
  let payload: unknown;
  const http = createHttpClient({ adapter: async () => Response.json(payload) });
  const client = createSelectionClient(http, { endpoint });
  for (payload of [projected, { data: projected, extra: true }, { data: projected, error: {} }, null, []]) {
    await assert.rejects(client.select(userResource, { args: {}, select: selected }),
      (error: unknown) => error instanceof SelectionError && error.code === 'INVALID_RESPONSE');
  }
});

test('selection client requires HTTP 200 for a success envelope', async () => {
  const http = createHttpClient({ adapter: async () => Response.json({ data: { id: '42' } }, { status: 201 }) });
  const client = createSelectionClient(http, { endpoint });
  await assert.rejects(client.select(userResource, { args: {}, select: { id: true } }),
    (error: unknown) => error instanceof SelectionError && error.code === 'INVALID_RESPONSE');
});

test('selection client rejects missing, extra and invalid selected fields', async () => {
  let payload: unknown;
  const http = createHttpClient({ adapter: async () => Response.json({ data: payload }) });
  const client = createSelectionClient(http, { endpoint });
  for (payload of [
    { id: '42', teams: [] },
    { ...projected, email: 'unrequested' },
    { ...projected, profile: { avatar: 'pic', hidden: true } },
    { ...projected, teams: [{ name: 42 }] },
    { ...projected, teams: [null] },
  ]) {
    await assert.rejects(client.select(userResource, { args: {}, select: selected }),
      (error: unknown) => error instanceof SelectionError && error.code === 'INVALID_RESPONSE');
  }
});

test('selection client maps valid protocol errors and preserves unrelated HTTP errors', async () => {
  let payload: unknown = { error: { code: 'FORBIDDEN', message: 'Not allowed' } };
  const http = createHttpClient({ adapter: async () => Response.json(payload, { status: 403 }) });
  const client = createSelectionClient(http, { endpoint });
  await assert.rejects(client.select(userResource, { args: {}, select: { id: true } }),
    (error: unknown) => error instanceof SelectionError && error.code === 'FORBIDDEN'
      && error.status === 403 && error.message === 'Not allowed');
  payload = { error: { code: 1, message: 'bad' } };
  await assert.rejects(client.select(userResource, { args: {}, select: { id: true } }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_BAD_RESPONSE' && error.status === 403);
});

test('selection client overrides default schema, transformations, retry and cache', async () => {
  let calls = 0;
  const http = createHttpClient({
    schema: { '~standard': { validate: () => ({ issues: [{ message: 'default response schema' }] }) } },
    transformRequest: () => ({ wrong: 'request' }),
    transformResponse: () => ({ wrong: 'response' }),
    stringifyJson: () => 'wrong-json',
    retry: { limit: 3, methods: ['POST'], statusCodes: [500], delay: 0 },
    cache: { ttl: 60_000 },
    validateStatus: () => false,
    adapter: async () => { calls += 1; return Response.json({ data: { id: '42' } }); },
  });
  const client = createSelectionClient(http, { endpoint });
  assert.deepEqual(await client.select(userResource, { args: {}, select: { id: true } }), { id: '42' });
  assert.deepEqual(await client.select(userResource, { args: {}, select: { id: true } }), { id: '42' });
  assert.equal(calls, 2);
});

test('selection client overrides default Content-Type for protocol JSON', async () => {
  let contentType = '';
  const http = createHttpClient({ headers: { 'Content-Type': 'text/plain' }, adapter: async (config) => {
    contentType = config.headers.get('Content-Type') ?? '';
    return Response.json({ data: { id: '42' } });
  } });
  const client = createSelectionClient(http, { endpoint });
  assert.deepEqual(await client.select(userResource, { args: {}, select: { id: true } }), { id: '42' });
  assert.equal(contentType, 'application/json');
});

test('selection client preserves caller headers while setting protocol Content-Type', async () => {
  const supplied = new AxiosHeaders({ 'Content-Type': 'text/plain', 'X-Tenant': 'blue' });
  let sentType = '';
  let sentTenant = '';
  const http = createHttpClient({ adapter: async (config) => {
    sentType = config.headers.get('Content-Type') ?? '';
    sentTenant = config.headers.get('X-Tenant') ?? '';
    return Response.json({ data: { id: '42' } });
  } });
  const client = createSelectionClient(http, { endpoint });
  await client.select(userResource, { args: {}, select: { id: true } }, { headers: supplied });
  assert.equal(sentType, 'application/json');
  assert.equal(sentTenant, 'blue');
  assert.equal(supplied.get('Content-Type'), 'text/plain');
});

test('selection client does not retry a failed protocol POST', async () => {
  let calls = 0;
  const http = createHttpClient({ retry: { limit: 3, methods: ['POST'], delay: 0 },
    adapter: async () => { calls += 1; return Response.json({ error: { code: 'FAIL', message: 'failure' } }, { status: 503 }); } });
  const client = createSelectionClient(http, { endpoint });
  await assert.rejects(client.select(userResource, { args: {}, select: { id: true } }), SelectionError);
  assert.equal(calls, 1);
});

test('selection client preserves cancellation as HttpError', async () => {
  const controller = new AbortController();
  const http = createHttpClient({ adapter: async () => {
    controller.abort();
    return new Promise<Response>(() => {});
  } });
  const client = createSelectionClient(http, { endpoint });
  await assert.rejects(client.select(userResource, { args: {}, select: { id: true } }, { signal: controller.signal }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED');
});

test('selection totalTimeout also covers asynchronous selected-field validation', async () => {
  const blockedSchema = { '~standard': { validate: () => new Promise<never>(() => {}) } };
  const resource = defineSelectionResource({ resource: 'users.blocked.v1', args: argsSchema,
    fields: { id: leaf(blockedSchema) } });
  const http = createHttpClient({ adapter: async () => Response.json({ data: { id: '42' } }) });
  const client = createSelectionClient(http, { endpoint });
  await assert.rejects(client.select(resource, { args: {}, select: { id: true } }, { totalTimeout: 20 }),
    (error: unknown) => error instanceof HttpError && error.code === 'ETIMEDOUT');
});

test('selection cancellation also interrupts asynchronous argument validation', async () => {
  const controller = new AbortController();
  const blockedArgs = { '~standard': { validate: () => new Promise<never>(() => {}) } };
  const resource = defineSelectionResource({ resource: 'users.blockedArgs.v1', args: blockedArgs,
    fields: { id: leaf(stringSchema) } });
  let calls = 0;
  const http = createHttpClient({ adapter: async () => { calls += 1; return Response.json({ data: { id: '42' } }); } });
  const client = createSelectionClient(http, { endpoint });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(client.select(resource, { args: {}, select: { id: true } }, { signal: controller.signal }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED');
  assert.equal(calls, 0);
});

test('selection client does not invoke argument validation after pre-abort', async () => {
  let validates = 0;
  const resource = defineSelectionResource({ resource: 'users.preAborted.v1',
    args: { '~standard': { validate(value: unknown) { validates += 1; return { value }; } } },
    fields: { id: leaf(stringSchema) } });
  const controller = new AbortController();
  controller.abort();
  const http = createHttpClient({ adapter: async () => Response.json({ data: { id: '42' } }) });
  const client = createSelectionClient(http, { endpoint });
  await assert.rejects(client.select(resource, { args: {}, select: { id: true } }, { signal: controller.signal }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_CANCELED');
  assert.equal(validates, 0);
});
