import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHttpClient } from '../../dist/index.js';

test('returns full response metadata without changing data convenience methods', async () => {
  const client = createHttpClient({
    cache: { ttl: 1000 },
    adapter: async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
  });
  const response = await client.getResponse<{ ok: boolean }>('/status');
  assert.deepEqual(response.data, { ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('CONTENT-TYPE'), 'application/json');
  assert.equal(response.protocol, 'unknown');
  assert.equal(typeof response.timings.duration, 'number');
  assert.ok(response.raw instanceof Response);
  assert.deepEqual(await client.get('/status'), { ok: true });
});

test('provides full response methods for mutations', async () => {
  const client = createHttpClient({ adapter: async () => new Response('{"saved":true}') });
  const response = await client.postResponse('/save', { value: 1 });
  assert.deepEqual(response.data, { saved: true });
  assert.equal(response.config.method, 'POST');
});

test('responseType response remains raw for data convenience and bypasses cache', async () => {
  let calls = 0;
  const client = createHttpClient({ cache: { ttl: 1000 }, adapter: async () => { calls += 1; return new Response('raw'); } });
  const first = await client.get<Response>('/raw', { responseType: 'response' });
  const second = await client.get<Response>('/raw', { responseType: 'response' });
  assert.equal(first instanceof Response, true);
  assert.equal(second instanceof Response, true);
  assert.equal(calls, 2);
});
