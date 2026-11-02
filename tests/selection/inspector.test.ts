import test from 'node:test';
import assert from 'node:assert/strict';
import { array, defineSelectionResource, leaf, object } from '../../dist/selection/index.js';
import { describeSelectionResource, inspectSelection } from '../../dist/selection/inspector.js';

const stringSchema = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] };
} } };
const contract = defineSelectionResource({
  resource: 'users.byId.v1', args: stringSchema, nullable: true,
  fields: {
    id: leaf(stringSchema, { cost: 2 }),
    profile: object({ avatar: leaf(stringSchema, { cost: 5 }) }, { nullable: true, cost: 3 }),
    teams: array(object({ name: leaf(stringSchema, { cost: 2 }) }, { cost: 2 }), { cost: 4 }),
  },
});
const limits = { maxDepth: 4, maxFields: 8, maxCost: 100, maxArrayLength: 10 };

test('resource description exposes only safe field metadata', () => {
  const described = describeSelectionResource(contract);
  assert.deepEqual(JSON.parse(JSON.stringify(described)), {
    resource: 'users.byId.v1', nullable: true,
    fields: {
      id: { kind: 'leaf', nullable: false, cost: 2 },
      profile: { kind: 'object', nullable: true, cost: 3, fields: { avatar: { kind: 'leaf', nullable: false, cost: 5 } } },
      teams: { kind: 'array', nullable: false, cost: 4, element: { nullable: false, cost: 2, fields: { name: { kind: 'leaf', nullable: false, cost: 2 } } } },
    },
  });
  assert.equal(JSON.stringify(described).includes('~standard'), false);
  assert.equal(JSON.stringify(described).includes('validate'), false);
});

test('inspection reports the same bounded cost as protocol validation', () => {
  const result = inspectSelection(contract, { id: true, profile: { avatar: true }, teams: { name: true } }, limits);
  assert.deepEqual(result.metrics, { fieldCount: 5, depth: 2, cost: 44, paths: ['id', 'profile', 'profile.avatar', 'teams', 'teams.name'] });
  assert.deepEqual(JSON.parse(JSON.stringify(result.select)), { id: true, profile: { avatar: true }, teams: { name: true } });
  assert.throws(() => inspectSelection(contract, { teams: { name: true } }, { ...limits, maxCost: 33 }),
    (error: any) => error.code === 'SELECTION_LIMIT' && error.status === 413);
});

test('inspection rejects unknown fields without exposing schema internals', () => {
  assert.throws(() => inspectSelection(contract, { secret: true }, limits),
    (error: any) => error.code === 'INVALID_SELECTION' && error.status === 400);
});
