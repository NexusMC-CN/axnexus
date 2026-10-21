import { createHttpClient } from '../../src/core/client.js';
import type { HttpClient, HttpClientConfig, HttpResponse, RequestConfig } from '../../src/core/types.js';
import { fetchJson, fetchJsonResult } from '../../src/server/json.js';
import { isSchemaValidationError } from '../../src/core/schema.js';
import type { StandardSchema, StandardSchemaResult, InferSchemaInput, InferSchemaOutput } from '../../src/core/schema.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const schema: StandardSchema<{ id: number }, string> = {
  '~standard': {
    version: 1,
    vendor: 'type-fixture',
    types: undefined as unknown as { input: string; output: { id: number } },
    validate: async (value) => ({ value: { id: Number(value) } }),
  },
};
type Input = Assert<Equal<InferSchemaInput<typeof schema>, string>>;
type Output = Assert<Equal<InferSchemaOutput<typeof schema>, { id: number }>>;
// @ts-expect-error Standard Schema must return success or failure, never an empty result.
const invalid: StandardSchemaResult<string> = {};
const legacy: StandardSchema<number> = { '~standard': { validate: () => ({ value: 1 }) } };
const client = createHttpClient();
const data = client.get('/schema', { schema });
type Data = Assert<Equal<Awaited<typeof data>, { id: number } | null>>;
const response = client.getResponse('/schema', { schema });
type Full = Assert<Equal<Awaited<typeof response>, HttpResponse<{ id: number } | null>>>;
const converted = client.get('/schema', { schema, transformResponse: () => 'changed' });
type Converted = Assert<Equal<Awaited<typeof converted>, unknown>>;
// @ts-expect-error A manually supplied response generic cannot contradict schema output.
client.get<number>('/schema', { schema });
// @ts-expect-error The same rule applies to mutation methods.
client.post<number>('/schema', {}, { schema });
const raw = client.get<number>('/raw');
type Raw = Assert<Equal<Awaited<typeof raw>, number>>;
const json = fetchJson('/schema', { schema });
type Json = Assert<Equal<Awaited<typeof json>, { id: number } | null>>;
const result = fetchJsonResult('/schema', { schema });
type Result = Assert<Equal<Awaited<typeof result>['data'], { id: number } | null>>;
// @ts-expect-error JSON helper generics cannot contradict schema output.
fetchJson<number>('/schema', { schema });
// @ts-expect-error Full JSON helper generics cannot contradict schema output.
fetchJsonResult<number>('/schema', { schema });

declare const typedClient: HttpClient<{ traceId: string }>;
typedClient.get('/context', { context: { traceId: 'ok' }, schema });
// @ts-expect-error Schema inference must not weaken the client context type.
typedClient.get('/context', { context: { traceId: 1 }, schema });
declare const defaults: HttpClient<unknown, { schema: typeof schema }>;
const defaultSchemaOutput = defaults.get('/default');
type DefaultSchema = Assert<Equal<Awaited<typeof defaultSchemaOutput>, { id: number } | null>>;
// @ts-expect-error A default schema cannot be bypassed with an unrelated output generic.
defaults.get<number>('/default');
declare const transformedDefaults: HttpClient<unknown, { transformResponse: () => string }>;
const defaultTransform = transformedDefaults.get('/schema', { schema });
type DefaultTransform = Assert<Equal<Awaited<typeof defaultTransform>, unknown>>;
const resetTransform = transformedDefaults.get('/schema', { schema, transformResponse: [] });
type ResetTransform = Assert<Equal<Awaited<typeof resetTransform>, { id: number } | null>>;

// Every convenience method and both request signatures share the same schema contract.
for (const method of ['get', 'head', 'options', 'trace', 'connect', 'delete'] as const) {
  const output: Promise<{ id: number } | null> = client[method]('/schema', { schema });
  const full: Promise<HttpResponse<{ id: number } | null>> = client[`${method}Response`]('/schema', { schema });
  // @ts-expect-error Explicit output generics cannot bypass any method's schema.
  client[method]<number>('/schema', { schema });
  void [output, full];
}
for (const method of ['post', 'put', 'patch'] as const) {
  const output: Promise<{ id: number } | null> = client[method]('/schema', {}, { schema });
  const full: Promise<HttpResponse<{ id: number } | null>> = client[`${method}Response`]('/schema', {}, { schema });
  // @ts-expect-error Full response mutations reject schema/output conflicts too.
  client[`${method}Response`]<number>('/schema', {}, { schema });
  void [output, full];
}
const configOutput: Promise<{ id: number } | null> = client.request({ url: '/schema', schema });
const urlOutput: Promise<{ id: number } | null> = client.request('/schema', { schema });
const configFull: Promise<HttpResponse<{ id: number } | null>> = client.requestResponse({ url: '/schema', schema });
const urlFull: Promise<HttpResponse<{ id: number } | null>> = client.requestResponse('/schema', { schema });

const factoryDefault = createHttpClient({ schema });
const factoryOutput = factoryDefault.get('/default');
type FactoryDefault = Assert<Equal<Awaited<typeof factoryOutput>, { id: number } | null>>;
const factoryTransformed = createHttpClient({ transformResponse: () => 'changed' });
const factoryChanged = factoryTransformed.get('/schema', { schema });
type FactoryChanged = Assert<Equal<Awaited<typeof factoryChanged>, unknown>>;
// With one explicit generic TS cannot infer later default generics; preserve a
// conservative result rather than silently losing the default schema/transform.
const explicitContext = createHttpClient<{ traceId: string }>({ schema });
const conservative = explicitContext.get('/default', { context: { traceId: 'ok' } });
type Conservative = Assert<Equal<Awaited<typeof conservative>, unknown>>;
const explicitTransformed = createHttpClient<{ traceId: string }>({ transformResponse: () => 'changed' });
const conservativeTransform = explicitTransformed.get('/schema', { schema });
type ConservativeTransform = Assert<Equal<Awaited<typeof conservativeTransform>, unknown>>;
declare const wideDefaults: HttpClientConfig;
const wideClient = createHttpClient(wideDefaults);
const wideResult = wideClient.get('/schema', { schema });
type WideResult = Assert<Equal<Awaited<typeof wideResult>, unknown>>;
// @ts-expect-error Widened defaults might contain a schema; never accept a conflicting assertion.
wideClient.get<number>('/default');
declare const wideRequest: RequestConfig;
const wideRequestResult = client.get('/schema', wideRequest);
type WideRequestResult = Assert<Equal<Awaited<typeof wideRequestResult>, unknown>>;
// @ts-expect-error A widened config may carry an incompatible schema.
client.get<number>('/schema', wideRequest);
const removedDefault = defaults.get('/default', { schema: undefined });
type RemovedDefault = Assert<Equal<Awaited<typeof removedDefault>, unknown>>;
const inlineLegacy = client.get('/legacy', { schema: { '~standard': { validate: () => ({ value: 42 }) } } });
type InlineLegacy = Assert<Equal<Awaited<typeof inlineLegacy>, number | null>>;

declare const maybeDefaultSchema: { schema: typeof schema } | {};
const maybeSchemaClient = createHttpClient(maybeDefaultSchema);
// @ts-expect-error A union of defaults can still install a schema at runtime.
maybeSchemaClient.get<number>('/default');
declare const maybeDefaultTransform: { transformResponse: () => string } | {};
const maybeTransformClient = createHttpClient(maybeDefaultTransform);
const maybeTransformed = maybeTransformClient.get('/schema', { schema });
type MaybeTransformed = Assert<Equal<Awaited<typeof maybeTransformed>, unknown>>;

void [configOutput, urlOutput, configFull, urlFull];

declare const caught: unknown;
if (isSchemaValidationError(caught)) {
  const message: string | undefined = caught.issues[0]?.message;
  const path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined = caught.issues[0]?.path;
  void [message, path];
}
void [legacy, invalid];
