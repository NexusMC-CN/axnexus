import test from 'node:test';
import assert from 'node:assert/strict';
import { array, defineSelectionResource, leaf, object } from '../../dist/selection/index.js';
import { createSelectionHandler, implementSelection } from '../../dist/selection/server/index.js';

const string = { '~standard': { validate(value: unknown) { return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] }; } } };
const number = { '~standard': { validate(value: unknown) { return typeof value === 'number' ? { value } : { issues: [{ message: 'number required' }] }; } } };
const args = { '~standard': { validate(value: unknown) { return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? { value: { id: value.id } } : { issues: [{ message: 'id required' }] }; } } };
const contract = defineSelectionResource({ resource: 'users.byId.v1', args, nullable: true, fields: { id: leaf(string), name: leaf(string), email: leaf(string), profile: object({ avatar: leaf(string) }, { nullable: true }), teams: array(object({ name: leaf(string) })) } });
const limits = { maxRequestBytes: 1024, maxDepth: 3, maxFields: 8, maxCost: 7, maxArrayLength: 2 };
function setup(options: { allowEmail?: boolean; missing?: boolean; badOutput?: boolean; oversizedTeams?: boolean } = {}) {
  const seen: string[] = [];
  const resource = implementSelection(contract, {
    authorizeResource: () => { seen.push('resourceAuth'); return true; },
    load: ({ args: input }) => { seen.push('load'); return options.missing || input.id === 'missing' ? null : { id: input.id }; },
    fields: {
      id: { resolve: ({ parent }) => { seen.push('id'); return parent.id; } },
      name: { resolve: () => { seen.push('name'); return options.badOutput ? 5 : 'Ada'; } },
      email: { authorize: () => { seen.push('emailAuth'); return options.allowEmail ?? false; }, resolve: () => { seen.push('email'); return 'private@example.test'; } },
      profile: { resolve: () => { seen.push('profile'); return { avatar: 'avatar.png' }; }, fields: { avatar: { resolve: ({ parent }) => { seen.push('avatar'); return parent.avatar; } } } },
      teams: { resolve: () => { seen.push('teams'); return options.oversizedTeams ? [{ name: 'a' }, { name: 'b' }, { name: 'c' }] : [{ name: 'a' }]; }, fields: { name: { resolve: ({ parent }) => { seen.push('teamName'); return parent.name; } } } },
    },
  });
  return { seen, handler: createSelectionHandler({ resources: [resource], limits }) };
}
function request(select: unknown, overrides: Record<string, unknown> = {}) {
  return new Request('https://test.example/__axnexus/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'axnexus.selection', version: 1, resource: contract.resource, args: { id: '42' }, select, ...overrides }) });
}

test('handler returns only selected fields and executes only their resolvers', async () => {
  const { seen, handler } = setup();
  const response = await handler(request({ id: true, profile: { avatar: true }, teams: { name: true } }), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { id: '42', profile: { avatar: 'avatar.png' }, teams: [{ name: 'a' }] } });
  assert.deepEqual(seen, ['resourceAuth', 'load', 'id', 'profile', 'avatar', 'teams', 'teamName']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('validation and cost rejects invalid selections before loading', async () => {
  const { seen, handler } = setup();
  for (const [selection, status] of [[{ missing: true }, 400], [{ profile: true }, 400], [{}, 400], [{ id: false }, 400], [{ id: true, name: true, email: true, profile: { avatar: true }, teams: { name: true } }, 413]] as const) {
    const result = await handler(request(selection), {});
    assert.equal(result.status, status);
  }
  assert.deepEqual(seen, []);
});

test('unknown resource, protocol version and invalid args have stable status', async () => {
  const { seen, handler } = setup();
  assert.equal((await handler(request({ id: true }, { resource: 'other.v1' }), {})).status, 404);
  assert.equal((await handler(request({ id: true }, { version: 2 }), {})).status, 400);
  assert.equal((await handler(request({ id: true }, { args: {} }), {})).status, 422);
  assert.deepEqual(seen, []);
});

test('field authorization precedes sensitive resolver and rejects whole response', async () => {
  const { seen, handler } = setup();
  const response = await handler(request({ email: true }), {});
  assert.equal(response.status, 403);
  assert.deepEqual(seen, ['resourceAuth', 'load', 'emailAuth']);
  assert.deepEqual((await response.json()).error.code, 'FORBIDDEN');
});

test('missing root returns null without field work', async () => {
  const { seen, handler } = setup({ missing: true });
  const response = await handler(request({ id: true }), {});
  assert.deepEqual(await response.json(), { data: null });
  assert.deepEqual(seen, ['resourceAuth', 'load']);
});

test('invalid resolver output is safe 500 and array overflow stops child work', async () => {
  const broken = setup({ badOutput: true });
  const response = await broken.handler(request({ name: true }), {});
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /number required/);
  const long = setup({ oversizedTeams: true });
  assert.equal((await long.handler(request({ teams: { name: true } }), {})).status, 413);
  assert.deepEqual(long.seen, ['resourceAuth', 'load', 'teams']);
});

test('handler checks byte limit while reading and does not run resources', async () => {
  const { seen, handler } = setup();
  const response = await handler(request({ id: true }, { args: { id: 'a'.repeat(1024) } }), {});
  assert.equal(response.status, 413);
  assert.deepEqual(seen, []);
});

test('aborted asynchronous authorization stops before root loading', async () => {
  let loads = 0;
  const simple = defineSelectionResource({ resource: 'simple.byId.v1', args, fields: { id: leaf(string) } });
  const resource = implementSelection(simple, { authorizeResource: () => new Promise<boolean>(() => {}), load: () => { loads++; return { id: '42' }; }, fields: { id: { resolve: ({ parent }) => parent.id } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const controller = new AbortController();
  const work = handler(new Request('https://test.example/__axnexus/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'axnexus.selection', version: 1, resource: simple.resource, args: { id: '42' }, select: { id: true } }), signal: controller.signal }), {});
  setTimeout(() => controller.abort(), 5);
  const response = await work;
  assert.equal(response.status, 400);
  assert.equal(loads, 0);
});

test('nested field authorization happens after parent resolution and before child resolution', async () => {
  const seen: string[] = [];
  const child = defineSelectionResource({ resource: 'nested.byId.v1', args, fields: { profile: object({ secret: leaf(string) }) } });
  const implementation = implementSelection(child, { authorizeResource: () => true, load: () => ({ id: '42' }), fields: {
    profile: { authorize: () => { seen.push('profileAuth'); return true; }, resolve: () => { seen.push('profileResolve'); return { secret: 'private' }; }, fields: {
      secret: { authorize: () => { seen.push('secretAuth'); return false; }, resolve: () => { seen.push('secretResolve'); return 'private'; } },
    } },
  } });
  const handler = createSelectionHandler({ resources: [implementation], limits });
  const response = await handler(request({ profile: { secret: true } }, { resource: child.resource }), {});
  assert.equal(response.status, 403);
  assert.deepEqual(seen, ['profileAuth', 'profileResolve', 'secretAuth']);
});

test('handler rejects unsupported route and duplicate resources at setup', async () => {
  const { handler } = setup();
  assert.equal((await handler(new Request('https://test.example/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), {})).status, 400);
  const resource = implementSelection(contract, { authorizeResource: () => true, load: () => null, fields: {
    id: { resolve: () => 'x' }, name: { resolve: () => 'x' }, email: { resolve: () => 'x' },
    profile: { resolve: () => null, fields: { avatar: { resolve: () => 'x' } } },
    teams: { resolve: () => [], fields: { name: { resolve: () => 'x' } } },
  } });
  assert.throws(() => createSelectionHandler({ resources: [resource, resource], limits }), /duplicate/i);
});

test('resource refusal prevents root load and all field work', async () => {
  let loads = 0;
  const simple = defineSelectionResource({ resource: 'simple.byId.v1', args, fields: { id: leaf(string) } });
  const resource = implementSelection(simple, { authorizeResource: () => false, load: () => { loads++; return { id: '42' }; }, fields: { id: { resolve: () => '42' } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const response = await handler(request({ id: true }, { resource: simple.resource }), {});
  assert.equal(response.status, 403);
  assert.equal(loads, 0);
});

test('resolver exception is sanitized and no partial data escapes', async () => {
  const simple = defineSelectionResource({ resource: 'simple.byId.v1', args, fields: { id: leaf(string) } });
  const resource = implementSelection(simple, { authorizeResource: () => true, load: () => ({ id: '42' }), fields: { id: { resolve: () => { throw new Error('secret SQL token'); } } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const response = await handler(request({ id: true }, { resource: simple.resource }), {});
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR', message: 'Selection execution failed' } });
});

test('server keeps array element runtime shape and rejects null rows', async () => {
  const simple = defineSelectionResource({ resource: 'teams.all.v1', args, fields: { teams: array(object({ name: leaf(string) })) } });
  const resource = implementSelection(simple, { authorizeResource: () => true, load: () => ({}), fields: {
    teams: { resolve: () => [null], fields: { name: { resolve: ({ parent }) => parent.name } } },
  } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const response = await handler(request({ teams: { name: true } }, { resource: simple.resource }), {});
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'INTERNAL_ERROR');
});

test('every handler budget limit is mandatory at runtime', () => {
  assert.throws(() => createSelectionHandler({ resources: [], limits: { maxRequestBytes: 1024 } as never }), /maxDepth/);
});

test('selected leaf schema cannot serialize undefined as a missing field', async () => {
  const undefinedSchema = { '~standard': { validate: () => ({ value: undefined }) } };
  const undefinedContract = defineSelectionResource({ resource: 'missing.leaf.v1', args, fields: { id: leaf(undefinedSchema) } });
  const resource = implementSelection(undefinedContract, { authorizeResource: () => true, load: () => ({}), fields: { id: { resolve: () => '42' } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const result = await handler(request({ id: true }, { resource: undefinedContract.resource }), {});
  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { error: { code: 'INTERNAL_ERROR', message: 'Selection execution failed' } });
});

test('body over limit returns promptly when stream cancellation stalls', async () => {
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(20)); },
    cancel() { canceled++; return new Promise<void>(() => {}); },
  });
  const handler = createSelectionHandler({ resources: [], limits: { ...limits, maxRequestBytes: 10 } });
  const request = new Request('https://test.example/__axnexus/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  const result = await Promise.race([handler(request, {}), new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 100))]);
  assert.notEqual(result, 'stalled');
  if (result !== 'stalled') assert.equal(result.status, 413);
  assert.equal(canceled, 1);
});

test('scalar resource args follow their declared Standard Schema', async () => {
  const scalar = defineSelectionResource({ resource: 'lookup.byKey.v1', args: string, fields: { id: leaf(string) } });
  const resource = implementSelection(scalar, { authorizeResource: () => true, load: ({ args: key }) => ({ id: key }), fields: { id: { resolve: ({ parent }) => parent.id } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const result = await handler(request({ id: true }, { resource: scalar.resource, args: '42' }), {});
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { data: { id: '42' } });
});

test('leaf fields reject object values that would bypass explicit object selection', async () => {
  const objectSchema = { '~standard': { validate: () => ({ value: { hidden: 'secret' } }) } };
  const objectContract = defineSelectionResource({ resource: 'unsafe.leaf.v1', args, fields: { detail: leaf(objectSchema) } });
  const resource = implementSelection(objectContract, { authorizeResource: () => true, load: () => ({}), fields: { detail: { resolve: () => ({ hidden: 'secret' }) } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const result = await handler(request({ detail: true }, { resource: objectContract.resource }), {});
  assert.equal(result.status, 500);
});

test('non-null leaf schemas cannot turn a value into null', async () => {
  const nullSchema = { '~standard': { validate: () => ({ value: null }) } };
  const nullContract = defineSelectionResource({ resource: 'unsafe.null.v1', args, fields: { id: leaf(nullSchema) } });
  const resource = implementSelection(nullContract, { authorizeResource: () => true, load: () => ({}), fields: { id: { resolve: () => '42' } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  assert.equal((await handler(request({ id: true }, { resource: nullContract.resource }), {})).status, 500);
});

test('non-finite leaf numbers cannot serialize as null', async () => {
  const numberSchema = { '~standard': { validate: () => ({ value: Number.POSITIVE_INFINITY }) } };
  const numericContract = defineSelectionResource({ resource: 'unsafe.number.v1', args, fields: { count: leaf(numberSchema) } });
  const resource = implementSelection(numericContract, { authorizeResource: () => true, load: () => ({}), fields: { count: { resolve: () => 1 } } });
  const handler = createSelectionHandler({ resources: [resource], limits });
  const result = await handler(request({ count: true }, { resource: numericContract.resource }), {});
  assert.equal(result.status, 500);
});

test('depth and field count budgets reject before resource authorization', async () => {
  const depth = setup();
  const restrictedDepth = createSelectionHandler({ resources: [implementSelection(contract, { authorizeResource: () => { depth.seen.push('resourceAuth'); return true; }, load: () => null, fields: {
    id: { resolve: () => 'x' }, name: { resolve: () => 'x' }, email: { resolve: () => 'x' },
    profile: { resolve: () => null, fields: { avatar: { resolve: () => 'x' } } },
    teams: { resolve: () => [], fields: { name: { resolve: () => 'x' } } },
  } })], limits: { ...limits, maxDepth: 1 } });
  assert.equal((await restrictedDepth(request({ profile: { avatar: true } }), {})).status, 413);
  const count = setup();
  const narrow = createSelectionHandler({ resources: [implementSelection(contract, { authorizeResource: () => { count.seen.push('resourceAuth'); return true; }, load: () => null, fields: {
    id: { resolve: () => 'x' }, name: { resolve: () => 'x' }, email: { resolve: () => 'x' },
    profile: { resolve: () => null, fields: { avatar: { resolve: () => 'x' } } },
    teams: { resolve: () => [], fields: { name: { resolve: () => 'x' } } },
  } })], limits: { ...limits, maxFields: 1 } });
  assert.equal((await narrow(request({ id: true, name: true }), {})).status, 413);
  assert.deepEqual(depth.seen, []);
  assert.deepEqual(count.seen, []);
});
