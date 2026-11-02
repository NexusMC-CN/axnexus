import test from 'node:test';
import assert from 'node:assert/strict';
import { array, defineSelectionResource, leaf, object } from '../../dist/selection/index.js';
import { createSelectionBatchLoader, createSelectionHandler, implementSelection } from '../../dist/selection/server/index.js';

const string = { '~standard': { validate(value: unknown) { return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] }; } } };
const args = { '~standard': { validate: () => ({ value: {} }) } };
const contract = defineSelectionResource({ resource: 'members.list.v1', args, fields: {
  members: array(object({ id: leaf(string), accountName: leaf(string) })),
} });
const limits = { maxRequestBytes: 1024, maxDepth: 3, maxFields: 3, maxCost: 10, maxArrayLength: 3 };
const request = () => new Request('https://test.example/__axnexus/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  protocol: 'axnexus.selection', version: 1, resource: contract.resource, args: {}, select: { members: { id: true, accountName: true } },
}) });

test('handler batches array child reads within each request and isolates caches', async () => {
  const batches: string[][] = [];
  let factories = 0;
  const resource = implementSelection(contract, {
    authorizeResource: () => true,
    load: () => ({}),
    fields: { members: { resolve: () => [{ id: 'a' }, { id: 'b' }, { id: 'a' }], fields: {
      id: { resolve: ({ parent }) => parent.id },
      accountName: { resolve: ({ parent, loaders }) => loaders.accounts.load(parent.id) },
    } } },
  });
  const handler = createSelectionHandler({ resources: [resource], limits, createLoaders: ({ signal }) => {
    factories++;
    return { accounts: createSelectionBatchLoader<string, string>(async (ids) => {
      batches.push([...ids]);
      return ids.map((id) => `name-${id}`);
    }, { signal }) };
  } });
  const expected = { data: { members: [
    { id: 'a', accountName: 'name-a' }, { id: 'b', accountName: 'name-b' }, { id: 'a', accountName: 'name-a' },
  ] } };
  assert.deepEqual(await (await handler(request(), {})).json(), expected);
  assert.deepEqual(await (await handler(request(), {})).json(), expected);
  assert.equal(factories, 2);
  assert.deepEqual(batches, [['a', 'b'], ['a', 'b']]);
});

test('invalid or denied requests do not create request loaders', async () => {
  let factories = 0;
  const resource = implementSelection(contract, { authorizeResource: () => false, load: () => ({}), fields: {
    members: { resolve: () => [], fields: { id: { resolve: () => '' }, accountName: { resolve: () => '' } } },
  } });
  const handler = createSelectionHandler({ resources: [resource], limits, createLoaders: () => { factories++; return {}; } });
  assert.equal((await handler(request(), {})).status, 403);
  assert.equal(factories, 0);
});

test('a denied array child field prevents reads for every row in that field', async () => {
  const reads: string[] = [];
  const resource = implementSelection(contract, { authorizeResource: () => true, load: () => ({}), fields: {
    members: { resolve: () => [{ id: 'a' }, { id: 'blocked' }], fields: {
      id: { resolve: ({ parent }) => parent.id },
      accountName: { authorize: ({ parent }) => parent.id !== 'blocked',
        resolve: ({ parent }) => { reads.push(parent.id); return 'private'; } },
    } },
  } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const response = await handler(request(), {});
  assert.equal(response.status, 403);
  assert.deepEqual(reads, []);
});
