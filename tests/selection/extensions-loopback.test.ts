import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../dist/core/client.js';
import { array, createSelectionClient, defineSelectionPlan, defineSelectionResource, leaf, object, SelectionError } from '../../dist/selection/index.js';
import { createSelectionHandler, implementSelection, paginateSelection } from '../../dist/selection/server/index.js';

const string = { '~standard': { validate(value: unknown) { return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] }; } } };
const boolean = { '~standard': { validate(value: unknown) { return typeof value === 'boolean' ? { value } : { issues: [{ message: 'boolean required' }] }; } } };
const args = { '~standard': { validate(value: unknown) { return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
  ? { value: { id: value.id } } : { issues: [{ message: 'id required' }] }; } } };
const limits = { maxRequestBytes: 2048, maxDepth: 3, maxFields: 5, maxCost: 10, maxArrayLength: 2 };

test('registered plan sends its id, executes fixed fields, and emits safe observations', async () => {
  const contract = defineSelectionResource({ resource: 'users.byId.v1', args, fields: {
    id: leaf(string), name: leaf(string), secret: leaf(string),
  } });
  const plan = defineSelectionPlan('users.summary.v1', contract, { id: true, name: true });
  const seen: string[] = [];
  const observations: unknown[] = [];
  const resource = implementSelection(contract, { authorizeResource: () => true, load: ({ args: input }) => ({ id: input.id }), fields: {
    id: { resolve: ({ parent }) => { seen.push('id'); return parent.id; } },
    name: { resolve: () => { seen.push('name'); return 'Ada'; } },
    secret: { resolve: () => { seen.push('secret'); return 'private'; } },
  } });
  const handler = createSelectionHandler({ resources: [resource], plans: [plan], allowDynamic: false, limits,
    observe: (event) => { observations.push(event); throw new Error('telemetry unavailable'); } });
  const posted: unknown[] = [];
  const http = createHttpClient({ adapter: async (config) => {
    const body = JSON.parse(String(config.body));
    posted.push(body);
    return handler(new Request(config.url, { method: config.method, headers: config.headers, body: config.body, signal: config.signal }), {});
  } });
  try {
    const client = createSelectionClient(http, { endpoint: 'https://loopback.test/__axnexus/select' });
    assert.deepEqual(await client.execute(plan, { args: { id: '42' } }), { id: '42', name: 'Ada' });
    assert.deepEqual(posted[0], { protocol: 'axnexus.selection', version: 1, plan: 'users.summary.v1', args: { id: '42' } });
    assert.deepEqual(seen, ['id', 'name']);
    await assert.rejects(client.select(contract, { args: { id: '42' }, select: { id: true } }),
      (error: unknown) => error instanceof SelectionError && error.code === 'DYNAMIC_SELECTION_DISABLED');
    assert.equal(seen.length, 2);
    assert.deepEqual((observations[0] as any).mode, 'registered');
    assert.equal((observations[0] as any).estimatedCost, 2);
    assert.equal((observations[0] as any).status, 200);
    assert.ok((observations[0] as any).requestBytes > 0);
    assert.doesNotMatch(JSON.stringify(observations), /Ada|private|"args"|"id":"42"/);
  } finally { await http.close(); }
});

test('unknown plans are rejected and not copied to observation metadata', async () => {
  const contract = defineSelectionResource({ resource: 'users.byId.v1', args, fields: { id: leaf(string) } });
  const plan = defineSelectionPlan('users.summary.v1', contract, { id: true });
  const resource = implementSelection(contract, { authorizeResource: () => true, load: () => ({}), fields: { id: { resolve: () => '42' } } });
  const events: unknown[] = [];
  const handler = createSelectionHandler({ resources: [resource], plans: [plan], limits, observe: (event) => { events.push(event); } });
  const response = await handler(new Request('https://loopback.test/__axnexus/select', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'axnexus.selection', version: 1, plan: 'users.evil.v1', args: { id: '42' } }) }), {});
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'UNKNOWN_PLAN');
  assert.equal((events[0] as any).mode, 'registered');
  assert.equal((events[0] as any).plan, undefined);
  assert.equal((events[0] as any).resource, undefined);
});

test('resource-level cursor page works with selected items and page info', async () => {
  const pageArgs = { '~standard': { validate(value: unknown) { return value && typeof value === 'object' && 'first' in value && typeof value.first === 'number'
    ? { value } : { issues: [{ message: 'first required' }] }; } } };
  const contract = defineSelectionResource({ resource: 'users.list.v1', args: pageArgs, fields: {
    items: array(object({ id: leaf(string), name: leaf(string) })),
    pageInfo: object({ endCursor: leaf(string, { nullable: true }), hasNextPage: leaf(boolean) }),
  } });
  const ids = ['a', 'b', 'c'];
  const resource = implementSelection(contract, { authorizeResource: () => true,
    load: ({ args: input, signal }) => paginateSelection(input, { maxPageSize: 2, signal,
      decodeCursor: (token) => { if (!token.startsWith('token:')) throw new Error('bad cursor'); return token.slice(6); },
      encodeCursor: (row: { id: string }) => `token:${row.id}`,
      load: ({ after, limit }) => ids.filter((id) => after === null || id > after).slice(0, limit).map((id) => ({ id })),
    }),
    fields: {
      items: { resolve: ({ parent }) => parent.items, fields: {
        id: { resolve: ({ parent }) => parent.id }, name: { resolve: ({ parent }) => `name-${parent.id}` },
      } },
      pageInfo: { resolve: ({ parent }) => parent.pageInfo, fields: {
        endCursor: { resolve: ({ parent }) => parent.endCursor }, hasNextPage: { resolve: ({ parent }) => parent.hasNextPage },
      } },
    },
  });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const select = { items: { id: true }, pageInfo: { endCursor: true, hasNextPage: true } };
  const request = (first: number, after?: string) => new Request('https://loopback.test/__axnexus/select', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'axnexus.selection', version: 1,
      resource: contract.resource, args: { first, after }, select }) });
  assert.deepEqual(await (await handler(request(2), {})).json(), { data: { items: [{ id: 'a' }, { id: 'b' }],
    pageInfo: { endCursor: 'token:b', hasNextPage: true } } });
  assert.deepEqual(await (await handler(request(2, 'token:b'), {})).json(), { data: { items: [{ id: 'c' }],
    pageInfo: { endCursor: 'token:c', hasNextPage: false } } });
  const invalid = await handler(request(3), {});
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error.code, 'INVALID_PAGE');
});
