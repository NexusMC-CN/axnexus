import { createHttpClient } from '../../src/core/client.js';
import type { StandardSchema } from '../../src/core/schema.js';
import { array, defineSelectionResource, leaf, object, type SelectionFor } from '../../src/selection/contract.js';
import { createSelectionClient } from '../../src/selection/client.js';

declare const args: StandardSchema<{ id: string }, { id: number }>;
declare const string: StandardSchema<string>;
const resource = defineSelectionResource({ resource: 'users.byId.v1', args, nullable: true,
  fields: { id: leaf(string), email: leaf(string, { nullable: true }),
    profile: object({ avatar: leaf(string) }, { nullable: true }),
    teams: array(object({ name: leaf(string) })) } });

const client = createSelectionClient(createHttpClient<{ tenant: string }>({ baseURL: 'https://example.test' }),
  { endpoint: '/__axnexus/select' });
const picked = client.select(resource, { args: { id: 42 }, select: { id: true, profile: { avatar: true }, teams: { name: true } } },
  { context: { tenant: 'a' } });
const exact: Promise<{ id: string; profile: { avatar: string } | null; teams: { name: string }[] } | null> = picked;
void exact;
// @ts-expect-error selected output must not contain unselected email
picked.then(user => user?.email);
// @ts-expect-error unknown selection field is rejected
client.select(resource, { args: { id: 42 }, select: { secret: true } });
// @ts-expect-error argument input is numeric, not its schema output
client.select(resource, { args: { id: '42' }, select: { id: true } });
// @ts-expect-error preserve bound client context type
client.select(resource, { args: { id: 42 }, select: { id: true } }, { context: { tenant: 42 } });
// @ts-expect-error callers cannot replace protocol output validation
client.select(resource, { args: { id: 42 }, select: { id: true } }, { schema: string });
// @ts-expect-error callers cannot enable retries on selection POST
client.select(resource, { args: { id: 42 }, select: { id: true } }, { retry: 2 });

declare const dynamic: SelectionFor<typeof resource.fields>;
const conservative = client.select(resource, { args: { id: 42 }, select: dynamic });
conservative.then(user => {
  if (!user) return;
  const maybeId: string | undefined = user.id;
  void maybeId;
});
