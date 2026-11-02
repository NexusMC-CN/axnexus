import { defineSelectionResource, leaf } from '@nexusmc-cn/axnexus/selection';
import { createSelectionHandler, implementSelection } from '@nexusmc-cn/axnexus/selection/server';

const schema = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] };
} } };
const args = { '~standard': { validate(value: unknown) {
  return value !== null && typeof value === 'object' ? { value: {} } : { issues: [{ message: 'object required' }] };
} } };
const contract = defineSelectionResource({
  resource: 'session.current.v1', args, fields: { actor: leaf(schema) },
});
const resource = implementSelection(contract, {
  authorizeResource: ({ context }) => context.actor !== null,
  load: ({ context }) => ({ actor: context.actor }),
  fields: { actor: { resolve: ({ parent }) => parent.actor } },
});
export const selectionHandler = createSelectionHandler({
  resources: [resource],
  endpoint: '/api/__axnexus/select',
  limits: { maxRequestBytes: 1024, maxDepth: 2, maxFields: 2, maxCost: 2, maxArrayLength: 2 },
});

export function actorFromCookie(cookie: string | null): string | null {
  return /(?:^|;\s*)session=(alice|bob)(?:;|$)/.exec(cookie ?? '')?.[1] ?? null;
}
