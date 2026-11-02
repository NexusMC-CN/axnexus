import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StandardSchema } from '../../src/core/schema.js';
import { defineSelectionResource, leaf } from '../../src/selection/index.js';
import { implementSelection } from '../../src/selection/server/index.js';
import { createFastifySelectionPlugin, sendWebResponse, toWebRequest } from '../../src/integrations/fastify.js';

declare const stringSchema: StandardSchema<string, string>;
const contract = defineSelectionResource({ resource: 'users.byId.v1', args: stringSchema,
  fields: { id: leaf(stringSchema) } });
const resource = implementSelection(contract, { authorizeResource: () => true,
  load: ({ args }) => ({ id: args }), fields: { id: { resolve: ({ parent }) => parent.id } } });
const app = Fastify();
app.register(createFastifySelectionPlugin({ resources: [resource],
  limits: { maxRequestBytes: 1024, maxDepth: 2, maxFields: 2, maxCost: 2, maxArrayLength: 2 },
  endpoint: '/select', getContext: async () => ({ actor: 'member' }) }), { prefix: '/api' });
declare const request: FastifyRequest;
declare const reply: FastifyReply;
toWebRequest(request, { origin: 'https://example.test', body: 'raw JSON' }) satisfies Request;
// @ts-expect-error Generated multipart bodies must be supplied as original raw bytes.
toWebRequest(request, { body: new FormData() });
sendWebResponse(reply, new Response('ok')) satisfies FastifyReply;
