import { raceWithSignal } from '../../core/control.js';
import { validateStandardSchema } from '../../core/schema.js';
import type { FieldMap, SelectionResource } from '../contract.js';
import { isRecord, SelectionFault, validLimits } from '../validation.js';
import type { SelectionLimits, SelectionTree } from '../validation.js';
import { inspectSelection } from '../inspector.js';
import type { SelectionMetrics, SelectionObserver, SelectionObservation } from '../inspector.js';
import { validateRegisteredSelectionPlans } from '../plans.js';
import type { SelectionPlan } from '../plans.js';
export { paginateSelection } from './pagination.js';
export type { SelectionPageRequest, SelectionPage, SelectionPageOptions } from './pagination.js';
export { createSelectionBatchLoader } from './batch-loader.js';
export type { SelectionBatchLoader, SelectionBatchOptions } from './batch-loader.js';

type MaybePromise<T> = T | Promise<T>;
export interface ResolveInput<Parent, Context, Loaders = unknown> {
  readonly parent: Parent; readonly context: Context; readonly signal: AbortSignal; readonly loaders: Loaders;
}
export interface FieldImplementation<Parent = any, Context = any, Loaders = unknown> {
  readonly authorize?: (input: ResolveInput<Parent, Context, Loaders>) => MaybePromise<boolean>;
  readonly resolve: (input: ResolveInput<Parent, Context, Loaders>) => MaybePromise<unknown>;
  readonly fields?: Record<string, FieldImplementation<any, Context, Loaders>>;
}
export interface SelectionImplementation<R extends SelectionResource = SelectionResource, Root = any, Context = any, Loaders = unknown> {
  readonly contract: R;
  readonly authorizeResource: (input: { context: Context; signal: AbortSignal }) => MaybePromise<boolean>;
  /** Load only the minimum identity needed for field authorization; no selection is passed. */
  readonly load: (input: { args: any; context: Context; signal: AbortSignal; loaders: Loaders }) => MaybePromise<Root | null>;
  readonly fields: Record<string, FieldImplementation<any, Context, Loaders>>;
}
export function implementSelection<R extends SelectionResource, Root, Context, Loaders = unknown>(contract: R,
  implementation: Omit<SelectionImplementation<R, Root, Context, Loaders>, 'contract'>): SelectionImplementation<R, Root, Context, Loaders> {
  if (!implementation || typeof implementation.authorizeResource !== 'function' || typeof implementation.load !== 'function') {
    throw new TypeError('Selection implementation needs authorization and root loader');
  }
  checkImplementation(contract.fields, implementation.fields);
  return { contract, ...implementation };
}

/** Bind a request-local loader factory before implementing fields, so resolver loaders are inferred. */
export function withSelectionLoaders<Context, Loaders>(
  createLoaders: (input: { context: Context; signal: AbortSignal }) => MaybePromise<Loaders>,
) {
  if (typeof createLoaders !== 'function') throw new TypeError('Selection loader factory required');
  return {
    createLoaders,
    implement<R extends SelectionResource, Root>(contract: R,
      implementation: Omit<SelectionImplementation<R, Root, Context, Loaders>, 'contract'>) {
      return implementSelection<R, Root, Context, Loaders>(contract, implementation);
    },
  };
}
function checkImplementation(fields: FieldMap, implementation: Record<string, FieldImplementation<any, any, any>>): void {
  if (!isRecord(implementation)) throw new TypeError('Selection field implementations required');
  for (const [name, field] of Object.entries(fields)) {
    const resolved = Object.hasOwn(implementation, name) ? implementation[name] : undefined;
    if (!resolved || typeof resolved.resolve !== 'function') throw new TypeError(`Missing resolver: ${name}`);
    if (resolved.authorize !== undefined && typeof resolved.authorize !== 'function') throw new TypeError(`Invalid authorization: ${name}`);
    if (field.kind !== 'leaf') checkImplementation(field.kind === 'object' ? field.fields : field.element.fields, resolved.fields ?? {});
  }
}

async function readBody(request: Request, maxBytes: number): Promise<{ value: unknown; bytes: number }> {
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) throw new SelectionFault(413, 'REQUEST_TOO_LARGE', 'Request body exceeded limit');
  if (!request.body) throw new SelectionFault(400, 'INVALID_REQUEST', 'JSON body required');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await raceWithSignal(reader.read(), request.signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new SelectionFault(413, 'REQUEST_TOO_LARGE', 'Request body exceeded limit');
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(concat(chunks, size)); }
  catch { throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid UTF-8 body'); }
  try { return { value: JSON.parse(text), bytes: size }; }
  catch { throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid JSON body'); }
}
function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function response(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' } });
}
async function executeMany(fields: FieldMap, implementations: Record<string, FieldImplementation<any, any, any>>, selection: SelectionTree,
  parents: readonly unknown[], context: unknown, loaders: unknown, signal: AbortSignal, maxArrayLength: number): Promise<Record<string, unknown>[]> {
  const data: Record<string, unknown>[] = parents.map(() => Object.create(null));
  for (const [name, nested] of Object.entries(selection)) {
    const field = fields[name]!;
    const implementation = implementations[name]!;
    if (field.kind !== 'leaf' && parents.some((parent) => !isRecord(parent))) {
      throw new TypeError('Nested parent object required');
    }
    // Check this field for every row before starting any of its resolver reads.
    for (const parent of parents) {
      if (implementation.authorize && !await raceWithSignal(implementation.authorize({ parent, context, loaders, signal }), signal)) {
        throw new SelectionFault(403, 'FORBIDDEN', 'Field access denied');
      }
    }
    const values = await Promise.all(parents.map((parent) =>
      raceWithSignal(implementation.resolve({ parent, context, loaders, signal }), signal)));
    const present: { index: number; value: unknown }[] = [];
    values.forEach((value, index) => {
      if (value === null) {
        if (!field.nullable) throw new TypeError('Non-null resolver result');
        data[index]![name] = null;
      } else present.push({ index, value });
    });
    if (field.kind === 'leaf') {
      for (const { index, value } of present) {
        const validated = await raceWithSignal(validateStandardSchema(value, field.schema), signal);
        if (validated === undefined) throw new TypeError('Selected field must have a defined value');
        if (validated === null && !field.nullable) throw new TypeError('Non-null field is null');
        if (typeof validated === 'object' && validated !== null) throw new TypeError('Leaf field must be a scalar');
        if (typeof validated === 'number' && !Number.isFinite(validated)) throw new TypeError('Leaf number must be finite');
        data[index]![name] = validated;
      }
    } else if (field.kind === 'object') {
      if (present.some(({ value }) => !isRecord(value))) throw new TypeError('Object resolver result required');
      const nestedData = await executeMany(field.fields, implementation.fields!, nested as SelectionTree,
        present.map(({ value }) => value), context, loaders, signal, maxArrayLength);
      present.forEach(({ index }, position) => { data[index]![name] = nestedData[position]; });
    }
    else {
      const flat: unknown[] = [];
      const offsets: { index: number; start: number; length: number }[] = [];
      for (const { index, value } of present) {
        if (!Array.isArray(value)) throw new TypeError('Array resolver result required');
        if (value.length > maxArrayLength) throw new SelectionFault(413, 'SELECTION_LIMIT', 'Array element limit exceeded');
        if (!value.every(isRecord)) throw new TypeError('Array element must be an object');
        offsets.push({ index, start: flat.length, length: value.length });
        for (const item of value) flat.push(item);
      }
      const rows: Record<string, unknown>[] = [];
      for (let index = 0; index < flat.length; index += 100) {
        rows.push(...await executeMany(field.element.fields, implementation.fields!, nested as SelectionTree,
          flat.slice(index, index + 100), context, loaders, signal, maxArrayLength));
      }
      for (const offset of offsets) data[offset.index]![name] = rows.slice(offset.start, offset.start + offset.length);
    }
  }
  return data;
}

export function createSelectionHandler<Context, Loaders = unknown>(options: {
  resources: readonly SelectionImplementation<any, any, Context, Loaders>[];
  limits: SelectionLimits;
  plans?: readonly SelectionPlan[];
  /** Require a registered plan id on the wire when false. Defaults to true. */
  allowDynamic?: boolean;
  /** Called once after resource authorization for each request; do not return a shared loader. */
  createLoaders?: (input: { context: Context; signal: AbortSignal }) => MaybePromise<Loaders>;
  /** Receives safe request metadata once per response; observer failures do not change responses. */
  observe?: SelectionObserver;
}) {
  validLimits(options.limits);
  if (options.allowDynamic === false && !options.plans?.length) throw new TypeError('Registered plans required when dynamic selection is disabled');
  const resources = new Map<string, SelectionImplementation<any, any, Context, Loaders>>();
  for (const resource of options.resources) {
    if (resources.has(resource.contract.resource)) throw new TypeError(`Duplicate resource: ${resource.contract.resource}`);
    resources.set(resource.contract.resource, resource);
  }
  const plans = validateRegisteredSelectionPlans(options.plans ?? [], options.resources.map((resource) => resource.contract), options.limits);
  const planMetrics = new Map<string, SelectionMetrics>();
  for (const [id, plan] of plans) planMetrics.set(id, inspectSelection(plan.contract, plan.select, options.limits).metrics);
  return async (request: Request, context: Context): Promise<Response> => {
    const started = performance.now();
    let mode: SelectionObservation['mode'] = 'invalid';
    let observedResource: string | undefined;
    let observedPlan: string | undefined;
    let requestBytes: number | undefined;
    let metrics: SelectionMetrics | undefined;
    let status = 500;
    let code: string | undefined;
    try {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/__axnexus/select') throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid selection route');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new SelectionFault(400, 'INVALID_REQUEST', 'JSON content type required');
      const body = await readBody(request, options.limits.maxRequestBytes);
      const payload = body.value;
      requestBytes = body.bytes;
      if (!isRecord(payload) || payload.protocol !== 'axnexus.selection' || payload.version !== 1
        || !Object.hasOwn(payload, 'args')) {
        throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid selection protocol request');
      }
      const dynamic = typeof payload.resource === 'string' && isRecord(payload.select)
        && Object.keys(payload).every((key) => ['protocol', 'version', 'resource', 'args', 'select'].includes(key));
      const registered = typeof payload.plan === 'string'
        && Object.keys(payload).every((key) => ['protocol', 'version', 'plan', 'args'].includes(key));
      if (!dynamic && !registered) throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid selection protocol request');
      mode = dynamic ? 'dynamic' : 'registered';
      if (dynamic && options.allowDynamic === false) throw new SelectionFault(403, 'DYNAMIC_SELECTION_DISABLED', 'Dynamic selection is disabled');
      const plan = registered ? plans.get(payload.plan as string) : undefined;
      if (registered && !plan) throw new SelectionFault(404, 'UNKNOWN_PLAN', 'Unknown selection plan');
      observedPlan = plan?.id;
      const resourceName = dynamic ? payload.resource as string : plan!.contract.resource;
      const implementation = resources.get(resourceName);
      if (!implementation) throw new SelectionFault(404, 'UNKNOWN_RESOURCE', 'Unknown selection resource');
      observedResource = implementation.contract.resource;
      const inspection = dynamic ? inspectSelection(implementation.contract, payload.select, options.limits) : undefined;
      const selection = inspection?.select ?? plan!.select as SelectionTree;
      metrics = inspection?.metrics ?? planMetrics.get(plan!.id);
      let args: unknown;
      try { args = await raceWithSignal(validateStandardSchema(payload.args, implementation.contract.args), request.signal); }
      catch (error) { if (request.signal.aborted) throw error; throw new SelectionFault(422, 'INVALID_ARGS', 'Invalid resource arguments'); }
      if (!await raceWithSignal(implementation.authorizeResource({ context, signal: request.signal }), request.signal)) {
        throw new SelectionFault(403, 'FORBIDDEN', 'Resource access denied');
      }
      const loaders = options.createLoaders
        ? await raceWithSignal(options.createLoaders({ context, signal: request.signal }), request.signal)
        : undefined as Loaders;
      const root = await raceWithSignal(implementation.load({ args, context, loaders, signal: request.signal }), request.signal);
      if (root === null) {
        if (!implementation.contract.nullable) throw new TypeError('Non-null root is missing');
        status = 200;
        return response({ data: null }, 200);
      }
      const data = (await executeMany(implementation.contract.fields, implementation.fields, selection, [root], context, loaders, request.signal, options.limits.maxArrayLength))[0]!;
      status = 200;
      return response({ data }, 200);
    } catch (error) {
      const fault = error instanceof SelectionFault ? error
        : request.signal.aborted ? new SelectionFault(400, 'CANCELED', 'Selection request canceled')
          : new SelectionFault(500, 'INTERNAL_ERROR', 'Selection execution failed');
      status = fault.status;
      code = fault.code;
      return response({ error: { code: fault.code, message: fault.message } }, fault.status);
    } finally {
      if (options.observe) {
        const observation: SelectionObservation = {
          mode, resource: observedResource, plan: observedPlan, status, code,
          durationMs: Math.max(0, performance.now() - started), requestBytes,
          fieldCount: metrics?.fieldCount, depth: metrics?.depth, estimatedCost: metrics?.cost,
        };
        try { void Promise.resolve(options.observe(observation)).catch(() => undefined); }
        catch { /* Observability must not affect the protocol response. */ }
      }
    }
  };
}
