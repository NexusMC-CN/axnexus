import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSelectionResource, leaf, object } from '../../dist/selection/contract.js';
import { defineSelectionPlan, validateRegisteredSelectionPlans } from '../../dist/selection/plans.js';

const string = { '~standard': { validate(value: unknown) { return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] }; } } };
const resource = defineSelectionResource({ resource: 'users.byId.v1', args: string, fields: { id: leaf(string), profile: object({ name: leaf(string) }) } });
const limits = { maxRequestBytes: 1024, maxDepth: 2, maxFields: 3, maxCost: 3, maxArrayLength: 2 };

test('plan copies and freezes a valid selection', () => {
  const select = { id: true, profile: { name: true } } as const;
  const plan = defineSelectionPlan('users.summary.v1', resource, select);
  assert.equal(plan.id, 'users.summary.v1');
  assert.strictEqual(plan.contract, resource);
  assert.equal(JSON.stringify(plan.select), JSON.stringify(select));
  assert.notStrictEqual(plan.select, select);
  assert.equal(Object.isFrozen(plan.select), true);
  assert.equal(Object.isFrozen(plan.select.profile), true);
  const registered = validateRegisteredSelectionPlans([plan], [resource], limits).get(plan.id)!;
  assert.notStrictEqual(registered, plan);
  assert.equal(JSON.stringify(registered.select), JSON.stringify(plan.select));
  assert.equal(Object.isFrozen(registered.select), true);
});

test('plan rejects invalid identifiers and malformed selections', () => {
  assert.throws(() => defineSelectionPlan('summary', resource, { id: true }), /plan id/i);
  assert.throws(() => defineSelectionPlan('users.summary-v1', resource, { id: true }), /plan id/i);
  assert.throws(() => defineSelectionPlan('__proto__.v1', resource, { id: true }), /plan id/i);
  assert.throws(() => defineSelectionPlan('users.empty.v1', resource, {}), /selection/i);
  assert.throws(() => defineSelectionPlan('users.unknown.v1', resource, { missing: true } as never), /field/i);
  assert.throws(() => defineSelectionPlan('users.badleaf.v1', resource, { id: { name: true } } as never), /leaf/i);
});

test('registration rejects duplicate IDs, mismatched contracts, and overbudget plans', () => {
  const plan = defineSelectionPlan('users.summary.v1', resource, { id: true, profile: { name: true } });
  assert.throws(() => validateRegisteredSelectionPlans([plan, plan], [resource], limits), /duplicate plan/i);
  const sameNameDifferentContract = defineSelectionResource({ resource: resource.resource, args: string, fields: { id: leaf(string) } });
  assert.throws(() => validateRegisteredSelectionPlans([plan], [sameNameDifferentContract], limits), /contract/i);
  assert.throws(() => validateRegisteredSelectionPlans([plan], [], limits), /resource/i);
  assert.throws(() => validateRegisteredSelectionPlans([plan], [resource], { ...limits, maxFields: 2 }), /field count exceeded/i);
});
