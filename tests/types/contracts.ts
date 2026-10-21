import { createHttpClient } from '../../src/core/client.js';
import type { StandardSchema } from '../../src/core/schema.js';
import { defineEndpoint } from '../../src/contracts/index.js';
import { createFetchHandler } from '../../src/bridges/index.js';

declare const query: StandardSchema<{ page: number }, { page: string }>;
declare const body: StandardSchema<{ count: number }, { count: string }>;
declare const output: StandardSchema<{ identifier: string }, unknown>;
declare const conflict: StandardSchema<{ reason: string }, unknown>;
declare const gone: StandardSchema<{ removedAt: Date }, unknown>;
const client = createHttpClient();
const endpoint = defineEndpoint({ method: 'POST', path: '/items/{id}', query, body, output,
  errors: { CONFLICT: { status: 409, schema: conflict }, GONE: { status: 410, schema: gone } },
});
const call = endpoint.bind(client);
const result: Promise<{ identifier: string }> = call.call({ params: { id: 'a/b' }, query: { page: '1' }, body: { count: '2' } });
void result;
// @ts-expect-error transformed query output cannot be used as its input
call.call({ params: { id: 1 }, query: { page: 1 }, body: { count: '2' } });
// @ts-expect-error transformed body output cannot be used as its input
call.call({ params: { id: 1 }, query: { page: '1' }, body: { count: 2 } });
// @ts-expect-error path parameters are required
call.call({ query: { page: '1' }, body: { count: '2' } });
// @ts-expect-error path keys are checked
call.call({ params: { other: '1' }, query: { page: '1' }, body: { count: '2' } });
// @ts-expect-error result is schema output
const wrong: Promise<number> = result;
void wrong;
async function checkResults() {
  const safe = await call.safeCall({ params: { id: 1 }, query: { page: '1' }, body: { count: '2' } });
  if (safe.kind === 'success') {
    safe.data.identifier satisfies string;
    // @ts-expect-error no unrelated output field
    safe.data.missing;
  } else if (safe.kind === 'domain') {
    if (safe.error.code === 'CONFLICT') {
      safe.error.data.reason satisfies string;
      // @ts-expect-error business data narrows by business code
      safe.error.data.removedAt;
    } else {
      safe.error.data.removedAt satisfies Date;
    }
  } else if (safe.kind === 'http' || safe.kind === 'transport') {
    // @ts-expect-error business codes are not HttpErrorCode
    safe.error.code satisfies 'CONFLICT';
  }
}
void checkResults;
defineEndpoint({ method: 'GET', path: '/health', output }).call(client);
const defaultSchemaClient = createHttpClient({ schema: output });
defineEndpoint({ method: 'GET', path: '/health', output }).bind(defaultSchemaClient);
const contextualClient = createHttpClient<{ traceId: string }>();
const contextualEndpoint = defineEndpoint({ method: 'GET', path: '/health', output }).bind(contextualClient);
contextualEndpoint.call({}, { context: { traceId: 'test' } });
// @ts-expect-error endpoint config keeps its bound client's context type
contextualEndpoint.call({}, { context: { traceId: 123 } });
// @ts-expect-error unbound endpoint also keeps the client's context type
defineEndpoint({ method: 'GET', path: '/health', output }).call(contextualClient, {}, { context: { traceId: 123 } });
const fetch: typeof globalThis.fetch = createFetchHandler();
void fetch;
// @ts-expect-error Fetch bridge cannot accept response-consuming transforms
createFetchHandler({ transformResponse: (data: unknown) => data });
// @ts-expect-error Fetch bridge cannot accept schemas that consume raw responses
createFetchHandler({ schema: output });
