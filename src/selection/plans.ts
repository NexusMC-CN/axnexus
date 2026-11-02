import type { ExactSelection, SelectionFor, SelectionResource } from './contract.js';
import { isRecord, validateSelectionTree } from './validation.js';
import type { SelectionLimits, SelectionTree } from './validation.js';

/** A named, immutable selection shared by client and server. */
export interface SelectionPlan<R extends SelectionResource = SelectionResource,
  S extends SelectionFor<R['fields']> = any> {
  readonly id: string;
  readonly contract: R;
  readonly select: S;
}

const planIdPattern = /^[A-Za-z][A-Za-z0-9_.-]*\.v[1-9][0-9]*$/;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);

function validPlanId(id: unknown): id is string {
  return typeof id === 'string' && planIdPattern.test(id)
    && !id.split(/[.-]/).some((segment) => reserved.has(segment));
}

function freezeSelection(tree: SelectionTree): SelectionTree {
  for (const value of Object.values(tree)) if (isRecord(value)) freezeSelection(value as SelectionTree);
  return Object.freeze(tree);
}

/** Define a versioned plan. The selection is copied so later caller mutations cannot change it. */
export function defineSelectionPlan<const R extends SelectionResource,
  const S extends SelectionFor<R['fields']>>(id: string, contract: R,
  select: S & ExactSelection<R['fields'], S>): SelectionPlan<R, S> {
  if (!validPlanId(id)) throw new TypeError('Plan id must be versioned (for example users.summary.v1)');
  if (!contract || typeof contract.resource !== 'string' || !isRecord(contract.fields)) throw new TypeError('Plan contract is invalid');
  const normalized = validateSelectionTree(contract.fields, select,
    { maxDepth: Number.MAX_SAFE_INTEGER, maxFields: Number.MAX_SAFE_INTEGER,
      maxCost: Number.MAX_SAFE_INTEGER, maxArrayLength: 1 });
  return Object.freeze({ id, contract, select: freezeSelection(normalized) as S });
}

/** Check all registered plans against the live resource catalog and execution budget at startup. */
export function validateRegisteredSelectionPlans(
  plans: readonly SelectionPlan[], resources: readonly SelectionResource[],
  limits: Pick<SelectionLimits, 'maxDepth' | 'maxFields' | 'maxCost' | 'maxArrayLength'>,
): ReadonlyMap<string, SelectionPlan> {
  const contracts = new Map(resources.map((resource) => [resource.resource, resource]));
  const registered = new Map<string, SelectionPlan>();
  for (const plan of plans) {
    if (!plan || !validPlanId(plan.id)) throw new TypeError('Invalid registered plan id');
    if (registered.has(plan.id)) throw new TypeError('Duplicate plan: ' + plan.id);
    const contract = contracts.get(plan.contract?.resource);
    if (!contract) throw new TypeError('Unknown plan resource: ' + plan.contract?.resource);
    if (contract !== plan.contract) throw new TypeError('Plan contract differs from registered resource: ' + plan.id);
    const normalized = validateSelectionTree(contract.fields, plan.select, limits);
    registered.set(plan.id, Object.freeze({ id: plan.id, contract, select: freezeSelection(normalized) }));
  }
  return registered;
}
