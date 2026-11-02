import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { defineSelectionResource, leaf } from '../../dist/selection/index.js';
import { implementSelection } from '../../dist/selection/server/index.js';
import { createFastifySelectionPlugin, sendWebResponse, toWebRequest } from '../../dist/integrations/fastify.js';

const string = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] };
} } };
const args = { '~standard': { validate(value: unknown) {
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    ? { value: { id: value.id } } : { issues: [{ message: 'id required' }] };
} } };
const contract = defineSelectionResource({ resource: 'users.byId.v1', args,
  fields: { id: leaf(string), name: leaf(string) } });
const limits = { maxRequestBytes: 512, maxDepth: 2, maxFields: 2, maxCost: 2, maxArrayLength: 2 };
const payload = (select: unknown = { id: true }) => JSON.stringify({
  protocol: 'axnexus.selection', version: 1, resource: contract.resource, args: { id: '42' }, select,
});

test('Fastify plugin preserves prefix, hooks, auth, protocol errors and unrelated JSON routes', async () => {
  const app = Fastify();
  let loads = 0;
  app.addHook('preHandler', async (request) => { (request as any).actor = request.headers['x-actor']; });
  app.post('/ordinary', async (request) => ({ body: request.body }));
  app.post('/ordinary-text', { schema: { body: { type: 'string' } } }, async (request) => ({ body: request.body }));
  const resource = implementSelection(contract, {
    authorizeResource: ({ context }) => context.actor === 'member',
    load: ({ args: input }) => { loads++; return { id: input.id }; },
    fields: {
      id: { resolve: ({ parent }) => parent.id },
      name: { resolve: () => 'Ada' },
    },
  });
  try {
    await app.register(createFastifySelectionPlugin({ resources: [resource], limits,
      getContext: (request) => ({ actor: (request as any).actor }) }), { prefix: '/api' });
    await app.ready();
    const headers = { 'content-type': 'application/json', 'x-actor': 'member' };
    const selected = await app.inject({ method: 'POST', url: '/api/__axnexus/select', headers, payload: payload({ id: true, name: true }) });
    assert.equal(selected.statusCode, 200);
    assert.deepEqual(selected.json(), { data: { id: '42', name: 'Ada' } });
    assert.equal(selected.headers['cache-control'], 'no-store');
    assert.equal(loads, 1);

    const denied = await app.inject({ method: 'POST', url: '/api/__axnexus/select',
      headers: { 'content-type': 'application/json', 'x-actor': 'guest' }, payload: payload() });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'FORBIDDEN');
    assert.equal(loads, 1);

    const malformed = await app.inject({ method: 'POST', url: '/api/__axnexus/select', headers, payload: '{broken' });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, 'INVALID_REQUEST');
    const wrongType = await app.inject({ method: 'POST', url: '/api/__axnexus/select',
      headers: { 'content-type': 'text/plain', 'x-actor': 'member' }, payload: payload() });
    assert.equal(wrongType.statusCode, 400);
    assert.equal(wrongType.json().error.code, 'INVALID_REQUEST');
    const oversized = await app.inject({ method: 'POST', url: '/api/__axnexus/select', headers,
      payload: JSON.stringify({ ...JSON.parse(payload()), padding: 'x'.repeat(600) }) });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error.code, 'REQUEST_TOO_LARGE');
    assert.equal(loads, 1);

    const ordinary = await app.inject({ method: 'POST', url: '/ordinary',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ id: 'normal' }) });
    assert.equal(ordinary.statusCode, 200);
    assert.deepEqual(ordinary.json(), { body: { id: 'normal' } });
    const text = await app.inject({ method: 'POST', url: '/ordinary-text',
      headers: { 'content-type': 'text/plain' }, payload: 'hello' });
    assert.equal(text.statusCode, 200);
    assert.deepEqual(text.json(), { body: 'hello' });
  } finally { await app.close(); }
});

test('Fastify plugin honors a custom Selection endpoint inside a prefix', async () => {
  const app = Fastify();
  const resource = implementSelection(contract, { authorizeResource: () => true,
    load: ({ args: input }) => ({ id: input.id }), fields: {
      id: { resolve: ({ parent }) => parent.id }, name: { resolve: () => 'Ada' },
    } });
  try {
    await app.register(createFastifySelectionPlugin({ resources: [resource], limits,
      endpoint: '/select/v1', getContext: () => ({}) }), { prefix: '/api' });
    await app.ready();
    const result = await app.inject({ method: 'POST', url: '/api/select/v1',
      headers: { 'content-type': 'application/json' }, payload: payload() });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { data: { id: '42' } });
    assert.equal((await app.inject({ method: 'POST', url: '/api/__axnexus/select',
      headers: { 'content-type': 'application/json' }, payload: payload() })).statusCode, 404);
  } finally { await app.close(); }
});

test('toWebRequest preserves raw request bytes and rejects implicit parsed-object serialization', async () => {
  const app = Fastify();
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.post('/raw', async (request) => {
    const web = toWebRequest(request, { origin: 'https://example.test' });
    return { url: web.url, method: web.method, contentType: web.headers.get('content-type'),
      bytes: [...new Uint8Array(await web.arrayBuffer())] };
  });
  app.post('/parsed', async (request) => {
    let rejected = false;
    try { toWebRequest(request); }
    catch (error) { rejected = error instanceof TypeError; }
    const explicit = toWebRequest(request, { origin: 'https://example.test', body: JSON.stringify(request.body) });
    return { rejected, explicit: await explicit.json() };
  });
  try {
    await app.ready();
    const raw = await app.inject({ method: 'POST', url: '/raw?a=1',
      headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from([0, 255, 1]) });
    assert.equal(raw.statusCode, 200);
    assert.deepEqual(raw.json(), { url: 'https://example.test/raw?a=1', method: 'POST',
      contentType: 'application/octet-stream', bytes: [0, 255, 1] });
    const parsed = await app.inject({ method: 'POST', url: '/parsed',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ id: '42' }) });
    assert.deepEqual(parsed.json(), { rejected: true, explicit: { id: '42' } });
  } finally { await app.close(); }
});

test('sendWebResponse exposes status and headers to Fastify hooks and streams its body', async () => {
  const app = Fastify();
  const seen: unknown[] = [];
  app.addHook('onSend', async (_request, reply, body) => {
    seen.push({ status: reply.statusCode, bridge: reply.getHeader('x-bridge') });
    return body;
  });
  app.get('/web', async (_request, reply) => {
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'x-bridge': 'yes' });
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      controller.enqueue(new TextEncoder().encode('second'));
      controller.close();
    } });
    return sendWebResponse(reply, new Response(body, { status: 202, headers }));
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/web' });
    assert.equal(response.statusCode, 202);
    assert.equal(response.body, 'firstsecond');
    assert.equal(response.headers['x-bridge'], 'yes');
    assert.deepEqual(response.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
    assert.deepEqual(seen, [{ status: 202, bridge: 'yes' }]);
  } finally { await app.close(); }
});

test('Web request path cannot escape a trusted origin', async () => {
  const app = Fastify();
  app.get('/probe', async (request) => {
    assert.throws(() => toWebRequest(request, { origin: 'https://trusted.test', path: '/\\attacker.test/' }), TypeError);
    return { ok: true };
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/probe' });
    assert.deepEqual(response.json(), { ok: true });
  } finally { await app.close(); }
});

test('host error handler remains authoritative for context failures', async () => {
  const app = Fastify();
  app.setErrorHandler((_error, _request, reply) => reply.code(418).send({ host: true }));
  const resource = implementSelection(contract, { authorizeResource: () => true, load: () => ({}), fields: {
    id: { resolve: () => '42' }, name: { resolve: () => 'Ada' },
  } });
  try {
    await app.register(createFastifySelectionPlugin({ resources: [resource], limits,
      getContext: () => { throw new Error('secret context failure'); } }));
    const response = await app.inject({ method: 'POST', url: '/__axnexus/select',
      headers: { 'content-type': 'application/json' }, payload: payload() });
    assert.equal(response.statusCode, 418);
    assert.deepEqual(response.json(), { host: true });
    assert.doesNotMatch(response.body, /secret context failure/);
  } finally { await app.close(); }
});

test('explicit bodies require raw bytes and preserve matching multipart headers', async () => {
  const request = { method: 'POST', raw: { url: '/upload', rawHeaders: [
    'content-type', 'multipart/form-data; boundary=original', 'content-length', '10',
  ] }, body: {}, signal: new AbortController().signal } as never;
  const form = new FormData();
  form.set('name', 'Ada');
  assert.throws(() => toWebRequest(request, { body: form as never }), TypeError);
  assert.throws(() => toWebRequest(request, { body: new URLSearchParams('name=Ada') as never }), TypeError);
  assert.throws(() => toWebRequest(request, { body: new Blob(['Ada']) as never }), TypeError);
  const raw = new TextEncoder().encode('--original\r\nContent-Disposition: form-data; name="name"\r\n\r\nAda\r\n--original--\r\n');
  const web = toWebRequest(request, { body: raw });
  assert.equal((await web.formData()).get('name'), 'Ada');
  assert.equal(web.headers.get('content-type'), 'multipart/form-data; boundary=original');
  assert.equal(web.headers.get('content-length'), null);
});
