import type { StandardSchema } from '../../src/core/schema.js';
import { array, defineSelectionResource, leaf, object } from '../../src/selection/contract.js';
import { createSelectionBatchLoader } from '../../src/selection/server/batch-loader.js';
import { createSelectionHandler, withSelectionLoaders } from '../../src/selection/server/index.js';

declare const stringSchema: StandardSchema<string>;
const argsSchema = stringSchema;
const contract = defineSelectionResource({ resource: 'users.list.v1', args: argsSchema,
  fields: { users: array(object({ name: leaf(stringSchema) })) } });
const scope = withSelectionLoaders(({ context, signal }: { context: { prefix: string }; signal: AbortSignal }) => ({
  names: createSelectionBatchLoader<string, string>(async (keys) => keys.map((key) => context.prefix + key), { signal }),
}));
const resource = scope.implement(contract, { authorizeResource: () => true, load: () => ({}), fields: {
  users: { resolve: () => [{ id: 'a' }], fields: {
    name: { resolve: ({ parent, loaders }) => loaders.names.load(parent.id) },
  } },
} });
createSelectionHandler({ resources: [resource], createLoaders: scope.createLoaders,
  limits: { maxRequestBytes: 1024, maxDepth: 2, maxFields: 2, maxCost: 4, maxArrayLength: 2 } });
