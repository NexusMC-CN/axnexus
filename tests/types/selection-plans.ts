import type { StandardSchema } from '../../src/core/schema.js';
import { defineSelectionResource, leaf, object } from '../../src/selection/contract.js';
import { defineSelectionPlan } from '../../src/selection/plans.js';
import { createSelectionClient } from '../../src/selection/index.js';
import type { SelectionResult } from '../../src/selection/contract.js';

declare const stringSchema: StandardSchema<string, string>;
const resource = defineSelectionResource({ resource: 'users.byId.v1', args: stringSchema,
  fields: { id: leaf(stringSchema), profile: object({ name: leaf(stringSchema), secret: leaf(stringSchema) }) } });
const plan = defineSelectionPlan('users.summary.v1', resource, { id: true, profile: { name: true } });
declare const result: SelectionResult<typeof plan.contract, typeof plan.select>;
result.id satisfies string;
result.profile.name satisfies string;
// @ts-expect-error unselected field must not be present
result.profile.secret;
declare const client: ReturnType<typeof createSelectionClient>;
const executed = client.execute(plan, { args: '42' });
declare const executedResult: Awaited<typeof executed>;
executedResult.profile.name satisfies string;
// @ts-expect-error unselected field must not appear after executing a plan
executedResult.profile.secret;
// @ts-expect-error plan arguments follow the resource schema
client.execute(plan, { args: 42 });
// @ts-expect-error unknown field is rejected at compile time
defineSelectionPlan('users.bad.v1', resource, { unknown: true });
// @ts-expect-error leaf fields require true
defineSelectionPlan('users.bad2.v1', resource, { id: { name: true } });
