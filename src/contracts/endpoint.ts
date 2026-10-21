import { HttpError, isHttpError } from '../core/errors.js';
import { combineSignals, raceWithSignal, signalReason, TIMEOUT_REASON } from '../core/control.js';
import { validateTimeout } from '../core/configuration/validation.js';
import { getClientLifecyclePolicy } from '../core/lifecycle/client-policy.js';
import { scheduleTimer } from '../core/lifecycle/timers.js';
import { SchemaValidationError, validateStandardSchema } from '../core/schema.js';
import type { InferSchemaInput, InferSchemaOutput, StandardSchema } from '../core/schema.js';
import type { HttpClient, HttpResponse, NoSchemaRequestConfig, QueryParams, QueryValue, RequestConfig } from '../core/types.js';
import { appendQuery } from '../utils/query.js';
import { DomainError } from './errors.js';
import type { EndpointDomainError, EndpointErrorMap } from './errors.js';

type Schema = StandardSchema<any, any>;
type MaybeSchema = Schema | undefined;

export type EndpointRequestConfig<TContext = unknown> = Omit<RequestConfig<TContext>,
  | 'url' | 'method' | 'params' | 'data' | 'body' | 'schema' | 'responseType'
  | 'transformRequest' | 'transformResponse' | 'validateStatus' | 'throwHttpErrors'
>;

/** The endpoint owns output validation and accepts clients with any default schema. */
export interface EndpointClient<TContext = unknown> {
  requestResponse(config: NoSchemaRequestConfig<TContext>): Promise<HttpResponse<unknown>>;
}

export type EndpointClientContext<Client> = Client extends HttpClient<infer TContext, any> ? TContext
  : Client extends EndpointClient<infer TContext> ? TContext : unknown;

export type EndpointPathKeys<Path extends string> =
  Path extends `${string}{${infer Key}}${infer Tail}` ? Key | EndpointPathKeys<Tail> : never;

export type EndpointInput<Path extends string, Query extends MaybeSchema, Body extends MaybeSchema> =
  ([EndpointPathKeys<Path>] extends [never] ? { params?: never }
    : { params: { [Key in EndpointPathKeys<Path>]: string | number | boolean } })
  & (Query extends Schema ? { query: InferSchemaInput<Query> } : { query?: never })
  & (Body extends Schema ? { body: InferSchemaInput<Body> } : { body?: never });

export type EndpointOutput<Output extends MaybeSchema> = Output extends Schema ? InferSchemaOutput<Output> : unknown;

export type EndpointResult<Output, Errors extends EndpointErrorMap> =
  | { kind: 'success'; data: Output }
  | { kind: 'domain'; error: EndpointDomainError<Errors> }
  | { kind: 'http'; error: HttpError }
  | { kind: 'transport'; error: HttpError }
  | { kind: 'unexpected'; error: unknown };

type CallArguments<Input, TContext = unknown> = {} extends Input
  ? [input?: Input, config?: EndpointRequestConfig<TContext>]
  : [input: Input, config?: EndpointRequestConfig<TContext>];

export interface BoundEndpoint<Input, Output, Errors extends EndpointErrorMap, TContext = unknown> {
  call(...args: CallArguments<Input, TContext>): Promise<Output>;
  safeCall(...args: CallArguments<Input, TContext>): Promise<EndpointResult<Output, Errors>>;
}

export interface Endpoint<Input, Output, Errors extends EndpointErrorMap> {
  call<Client extends EndpointClient<any>>(client: Client, ...args: CallArguments<Input, EndpointClientContext<Client>>): Promise<Output>;
  safeCall<Client extends EndpointClient<any>>(client: Client, ...args: CallArguments<Input, EndpointClientContext<Client>>): Promise<EndpointResult<Output, Errors>>;
  bind<Client extends EndpointClient<any>>(client: Client): BoundEndpoint<Input, Output, Errors, EndpointClientContext<Client>>;
}

export interface EndpointDefinition<Path extends string, Query extends MaybeSchema = undefined,
  Body extends MaybeSchema = undefined, Output extends MaybeSchema = undefined, Errors extends EndpointErrorMap = {}> {
  readonly method: string;
  /** Relative path, with optional {name} placeholders encoded as individual segments. */
  readonly path: Path;
  readonly query?: Query;
  readonly body?: Body;
  readonly output?: Output;
  readonly errors?: Errors;
}

function validatePath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\?#\x00-\x20\x7f]/.test(path)) {
    throw new TypeError('Endpoint path must be a relative absolute-path without query or fragment');
  }
  const literal = path.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'placeholder');
  if (/[{}]/.test(literal) || literal.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new TypeError('Endpoint path contains an invalid placeholder or dot segment');
  }
}

function interpolatePath(path: string, params: unknown): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_placeholder, key: string) => {
    if (!params || typeof params !== 'object' || !Object.prototype.hasOwnProperty.call(params, key)) {
      throw new TypeError(`Missing endpoint path parameter: ${key}`);
    }
    const value = (params as Record<string, unknown>)[key];
    if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      || (typeof value === 'number' && !Number.isFinite(value)) || value === '.' || value === '..') {
      throw new TypeError(`Invalid endpoint path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
}

function queryParams(value: unknown): QueryParams | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Endpoint query schema must produce a query object');
  const result: QueryParams = Object.create(null);
  const validValue = (entry: unknown): entry is QueryValue =>
    typeof entry === 'string' || typeof entry === 'boolean'
    || (typeof entry === 'number' && Number.isFinite(entry))
    || (entry instanceof Date && Number.isFinite(entry.getTime()));
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    if (Array.isArray(entry) ? entry.every(validValue) : validValue(entry)) result[key] = entry;
    else throw new TypeError(`Invalid endpoint query value: ${key}`);
  }
  return result;
}

const transportCodes = new Set(['ERR_NETWORK', 'ETIMEDOUT', 'ERR_CANCELED',
  'ERR_RATE_LIMIT_QUEUE_TIMEOUT', 'ERR_PROTOCOL_NEGOTIATION']);

/** Define an HTTP endpoint without requiring ordinary URL callers to use contracts. */
export function defineEndpoint<const Path extends string, Query extends MaybeSchema = undefined,
  Body extends MaybeSchema = undefined, Output extends MaybeSchema = undefined,
  const Errors extends EndpointErrorMap = {}>(definition: EndpointDefinition<Path, Query, Body, Output, Errors>):
  Endpoint<EndpointInput<Path, Query, Body>, EndpointOutput<Output>, Errors> {
  validatePath(definition.path);
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(definition.method)) throw new TypeError('Invalid endpoint method');
  for (const error of Object.values(definition.errors ?? {})) {
    if (!Number.isInteger(error.status) || error.status < 300 || error.status > 599) {
      throw new TypeError('Endpoint business error status must be an integer from 300 to 599');
    }
  }
  type Input = EndpointInput<Path, Query, Body>;
  type Result = EndpointOutput<Output>;
  const invoke = async <Client extends EndpointClient<any>>(ownedDomainErrors: WeakSet<DomainError>, client: Client,
    ...[input, config]: CallArguments<Input, EndpointClientContext<Client>>): Promise<Result> => {
    const defaults = getClientLifecyclePolicy(client);
    const timeout = validateTimeout(config?.timeout ?? defaults?.timeout, 'timeout');
    const totalTimeout = validateTimeout(config?.totalTimeout ?? defaults?.totalTimeout, 'totalTimeout');
    const deadlines = [timeout, totalTimeout].filter((value) => value > 0);
    const controller = deadlines.length ? new AbortController() : undefined;
    const combined = combineSignals([defaults?.signal, config?.signal, controller?.signal]);
    const signal = combined.signal;
    let timedOut = false;
    const cancelTimer = controller ? scheduleTimer(() => {
      timedOut = true;
      controller.abort(TIMEOUT_REASON);
    }, Math.min(...deadlines)) : undefined;
    const work = async (): Promise<Result> => {
      if (signal?.aborted) throw signalReason(signal);
      const fields = (input ?? {}) as { params?: unknown; query?: unknown; body?: unknown };
      const path = interpolatePath(definition.path, fields.params);
      const query = definition.query
        ? await raceWithSignal(validateStandardSchema(fields.query, definition.query), signal) : undefined;
      const data = definition.body
        ? await raceWithSignal(validateStandardSchema(fields.body, definition.body), signal) : undefined;
      const url = appendQuery(path, queryParams(query));
      let response: HttpResponse<unknown>;
      try {
        response = await client.requestResponse({
          ...config, signal, url, method: definition.method, data,
          // This layer validates before serialization and after response parsing.
          schema: undefined, transformRequest: [], transformResponse: [],
          responseType: 'json', validateStatus: (status) => status >= 200 && status < 300,
          throwHttpErrors: true,
        });
      } catch (error) {
        if (isHttpError(error) && error.code === 'ERR_BAD_RESPONSE' && error.response) {
          for (const [code, declared] of Object.entries(definition.errors ?? {})) {
            if (declared.status !== error.status) continue;
            let domainData: unknown;
            try {
              domainData = await raceWithSignal(validateStandardSchema(error.response.data, declared.schema), signal);
            } catch (validationError) {
              if (validationError instanceof SchemaValidationError) continue;
              throw validationError;
            }
            const domainError = new DomainError(code, domainData, error.response);
            ownedDomainErrors.add(domainError);
            throw domainError;
          }
        }
        throw error;
      }
      return (definition.output
        ? await raceWithSignal(validateStandardSchema(response.data, definition.output), signal)
        : response.data) as Result;
    };
    try {
      return await raceWithSignal(work(), signal);
    } catch (error) {
      if (signal?.aborted) {
        throw new HttpError(timedOut ? 'Endpoint call timed out' : 'Endpoint call canceled', {
          code: timedOut ? 'ETIMEDOUT' : 'ERR_CANCELED',
          isTimeout: timedOut, isAbort: !timedOut, retryable: false, cause: error,
          ...(isHttpError(error) ? { config: error.config, status: error.status, response: error.response } : {}),
        });
      }
      throw error;
    } finally {
      cancelTimer?.();
      combined.cleanup();
    }
  };
  const call = <Client extends EndpointClient<any>>(client: Client,
    ...args: CallArguments<Input, EndpointClientContext<Client>>): Promise<Result> => invoke(new WeakSet(), client, ...args);
  const safeCall = async <Client extends EndpointClient<any>>(client: Client,
    ...args: CallArguments<Input, EndpointClientContext<Client>>): Promise<EndpointResult<Result, Errors>> => {
    const ownedDomainErrors = new WeakSet<DomainError>();
    try { return { kind: 'success', data: await invoke(ownedDomainErrors, client, ...args) }; }
    catch (error) {
      if (error instanceof DomainError && ownedDomainErrors.has(error)) return { kind: 'domain', error: error as EndpointDomainError<Errors> };
      if (isHttpError(error)) {
        if (error.code === 'ERR_BAD_RESPONSE') return { kind: 'http', error };
        if (transportCodes.has(error.code)) return { kind: 'transport', error };
      }
      return { kind: 'unexpected', error };
    }
  };
  return { call, safeCall, bind: (client) => ({
    call: (...args) => call(client, ...args), safeCall: (...args) => safeCall(client, ...args),
  }) };
}
