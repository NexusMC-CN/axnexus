import test from 'node:test';
import assert from 'node:assert/strict';
import { array, defineSelectionResource, leaf, object } from '../../dist/selection/index.js';

const stringSchema = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] };
} } };

test('contract rejects reserved and malformed public field names', () => {
  const fields = Object.create(null) as Record<string, ReturnType<typeof leaf>>;
  fields.constructor = leaf(stringSchema);
  assert.throws(() => defineSelectionResource({ resource: 'users.v1', args: stringSchema, fields }), /field/i);
  delete fields.constructor;
  fields.__proto__ = leaf(stringSchema);
  assert.throws(() => defineSelectionResource({ resource: 'users.v1', args: stringSchema, fields }), /field/i);
  assert.throws(() => defineSelectionResource({ resource: '', args: stringSchema, fields: { id: leaf(stringSchema) } }), /resource/i);
});

test('contract rejects invalid costs and accepts nested object arrays', () => {
  assert.throws(() => leaf(stringSchema, { cost: 0 }), /cost/i);
  assert.throws(() => object({ name: leaf(stringSchema) }, { cost: -1 }), /cost/i);
  const contract = defineSelectionResource({ resource: 'users.byId.v1', args: stringSchema, nullable: true,
    fields: { id: leaf(stringSchema), profile: object({ avatar: leaf(stringSchema) }, { nullable: true }),
      teams: array(object({ name: leaf(stringSchema) })) } });
  assert.equal(contract.resource, 'users.byId.v1');
  assert.equal(contract.fields.teams.kind, 'array');
});
