import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/core/client.js';
import { createSelectionClient, defineSelectionResource, leaf, SelectionError } from '../../dist/selection/index.js';
import { createSelectionHandler, implementSelection } from '../../dist/selection/server/index.js';

const string = { '~standard': { validate(value: unknown) { return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] }; } } };
const args = { '~standard': { validate(value: unknown) { return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? { value: { id: value.id } } : { issues: [{ message: 'id required' }] }; } } };
const contract = defineSelectionResource({ resource: 'users.byId.v1', args, nullable: true, fields: { id: leaf(string), email: leaf(string) } });
const limits = { maxRequestBytes: 1024, maxDepth: 2, maxFields: 2, maxCost: 2, maxArrayLength: 2 };

test('public client and Web handler round trip selected fields and protocol errors', async () => {
  const seen: string[] = [];
  const resource = implementSelection(contract, {
    authorizeResource: () => true, load: ({ args: input }) => input.id === 'missing' ? null : ({ id: input.id }),
    fields: {
      id: { resolve: ({ parent }) => { seen.push('id'); return parent.id; } },
      email: { authorize: () => false, resolve: () => { seen.push('email'); return 'secret'; } },
    },
  });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const http = createHttpClient({ baseURL: 'https://loopback.test', adapter: async (config) => {
    const request = new Request(config.url, { method: config.method, headers: config.headers, body: config.body, signal: config.signal });
    return handler(request, {});
  } });
  const client = createSelectionClient(http, { endpoint: '/__axnexus/select' });
  try {
    assert.deepEqual(await client.select(contract, { args: { id: '42' }, select: { id: true } }), { id: '42' });
    assert.deepEqual(seen, ['id']);
    assert.equal(await client.select(contract, { args: { id: 'missing' }, select: { id: true } }), null);
    await assert.rejects(client.select(contract, { args: { id: '42' }, select: { email: true } }),
      (error: unknown) => error instanceof SelectionError && error.code === 'FORBIDDEN' && error.status === 403);
    assert.deepEqual(seen, ['id']);
    await assert.rejects(client.select(contract, { args: {} as never, select: { id: true } }),
      (error: unknown) => error instanceof SelectionError && error.code === 'INVALID_ARGS');
  } finally { await http.close(); }
});
