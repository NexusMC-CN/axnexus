import type { HttpClient } from '../../src/core/types.js';
import type { StandardSchema } from '../../src/core/schema.js';
import { createHttpClient } from '../../src/core/client.js';
import { connectSSE, parseNDJSON, parseSSE } from '../../src/stream/index.js';
import type { SSEEvent } from '../../src/stream/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Item<T> = T extends AsyncIterable<infer Value> ? Value : never;

declare const response: Response;
declare const client: HttpClient;
declare const schema: StandardSchema<{ id: number }, string>;

const raw = parseSSE(response);
type Raw = Assert<Equal<Item<typeof raw>, SSEEvent<string>>>;
const unknownJSON = parseNDJSON(response);
type UnknownJSON = Assert<Equal<Item<typeof unknownJSON>, unknown>>;
const validatedSSE = parseSSE(response, { schema, parseJson: JSON.parse });
type ValidatedSSE = Assert<Equal<Item<typeof validatedSSE>, SSEEvent<{ id: number }>>>;
const validatedNDJSON = parseNDJSON(response, { schema });
type ValidatedNDJSON = Assert<Equal<Item<typeof validatedNDJSON>, { id: number }>>;
const parsed = parseSSE(response, { parseJson: async (text) => ({ text }) });
type Parsed = Assert<Equal<Item<typeof parsed>, SSEEvent<{ text: string }>>>;
const resumed = connectSSE(client, '/events', { schema, reconnect: { maxAttempts: 2 } });
type Resumed = Assert<Equal<Item<typeof resumed>, SSEEvent<{ id: number }>>>;
connectSSE(client, '/events', { schema, isComplete: (event) => event.data.id === 1 });

const contextualClient = createHttpClient<{ traceId: string }>();
connectSSE(contextualClient, '/events', { request: { context: { traceId: 'typed' } } });
connectSSE(contextualClient, '/events', { schema, request: { context: { traceId: 'validated' } } });
connectSSE(contextualClient, '/events', { parseJson: () => 1, request: { context: { traceId: 'parsed' } } });
// @ts-expect-error The raw stream preserves its client's request context type.
connectSSE(contextualClient, '/events', { request: { context: { traceId: 1 } } });
// @ts-expect-error Schema stream options preserve request context too.
connectSSE(contextualClient, '/events', { schema, request: { context: { traceId: 1 } } });
// @ts-expect-error A typed parser cannot widen request context.
connectSSE(contextualClient, '/events', { parseJson: () => 1, request: { context: { traceId: 1 } } });
const defaultSchemaClient = createHttpClient({ schema });
const overriddenDefault = connectSSE(defaultSchemaClient, '/events');
type OverriddenDefault = Assert<Equal<Item<typeof overriddenDefault>, SSEEvent<string>>>;
const defaultTransformClient = createHttpClient({ schema, transformResponse: () => 1 });
connectSSE(defaultTransformClient, '/events', { schema });

// @ts-expect-error A schema output cannot be contradicted by a manual generic.
parseSSE<number>(response, { schema });
// @ts-expect-error Raw SSE cannot promise an unchecked output type.
parseSSE<number>(response);
// @ts-expect-error Unvalidated default JSON remains unknown.
parseNDJSON<{ id: number }>(response);
// @ts-expect-error A JSON parser output cannot be contradicted by a manual generic.
parseNDJSON<number>(response, { parseJson: () => 'text' });
// @ts-expect-error A streaming connection schema also determines its data type.
connectSSE<number>(client, '/events', { schema });
