import type { StandardSchema } from '../../src/core/schema.js';
import { array, defineSelectionResource, leaf, object } from '../../src/selection/index.js';
import type { SelectionFor, SelectionResult } from '../../src/selection/index.js';

declare const stringSchema: StandardSchema<string>;
declare const argsSchema: StandardSchema<{ id: string }, { id: number }>;
const contract = defineSelectionResource({ resource: 'users.byId.v1', args: argsSchema, nullable: true, fields: {
  id: leaf(stringSchema),
  profile: object({ avatar: leaf(stringSchema) }, { nullable: true }),
  teams: array(object({ name: leaf(stringSchema), secret: leaf(stringSchema) })),
} });
const selected = { id: true, profile: { avatar: true }, teams: { name: true } } as const;
declare const result: SelectionResult<typeof contract, typeof selected>;
const exact: { id: string; profile: { avatar: string } | null; teams: { name: string }[] } | null = result;
void exact;
if (result) {
  result.id satisfies string;
  // @ts-expect-error unselected field must not be present
  result.teams[0]!.secret;
}
const dynamic: SelectionFor<typeof contract.fields> = JSON.parse('{}') as SelectionFor<typeof contract.fields>;
declare const dynamicResult: SelectionResult<typeof contract, typeof dynamic>;
// @ts-expect-error runtime selection cannot promise id exists
const unsafeId: string = dynamicResult!.id;
void unsafeId;
// @ts-expect-error unknown public field
const bad: SelectionFor<typeof contract.fields> = { missing: true };
void bad;
