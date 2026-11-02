import { raceWithSignal } from '../../core/control.js';
import { validateStandardSchema } from '../../core/schema.js';
import type { FieldMap, SelectionResource } from '../contract.js';
import { isRecord, SelectionFault, validateSelectionTree, validLimits } from '../validation.js';
import type { SelectionLimits, SelectionTree } from '../validation.js';

type MaybePromise<T> = T | Promise<T>;
export interface ResolveInput<Parent, Context> { readonly parent: Parent; readonly context: Context; readonly signal: AbortSignal; }
export interface FieldImplementation<Parent = any, Context = any> {
  readonly authorize?: (input: ResolveInput<Parent, Context>) => MaybePromise<boolean>;
  readonly resolve: (input: ResolveInput<Parent, Context>) => MaybePromise<unknown>;
  readonly fields?: Record<string, FieldImplementation<any, Context>>;
}
export interface SelectionImplementation<R extends SelectionResource = SelectionResource, Root = any, Context = any> {
  readonly contract: R;
  readonly authorizeResource: (input: { context: Context; signal: AbortSignal }) => MaybePromise<boolean>;
  /** Load only the minimum identity needed for field authorization; no selection is passed. */
  readonly load: (input: { args: any; context: Context; signal: AbortSignal }) => MaybePromise<Root | null>;
  readonly fields: Record<string, FieldImplementation<any, Context>>;
}
export function implementSelection<R extends SelectionResource, Root, Context>(contract: R,
  implementation: Omit<SelectionImplementation<R, Root, Context>, 'contract'>): SelectionImplementation<R, Root, Context> {
  if (!implementation || typeof implementation.authorizeResource !== 'function' || typeof implementation.load !== 'function') {
    throw new TypeError('Selection implementation needs authorization and root loader');
  }
  checkImplementation(contract.fields, implementation.fields);
  return { contract, ...implementation };
}
function checkImplementation(fields: FieldMap, implementation: Record<string, FieldImplementation<any, any>>): void {
  if (!isRecord(implementation)) throw new TypeError('Selection field implementations required');
  for (const [name, field] of Object.entries(fields)) {
    const resolved = Object.hasOwn(implementation, name) ? implementation[name] : undefined;
    if (!resolved || typeof resolved.resolve !== 'function') throw new TypeError(`Missing resolver: ${name}`);
    if (resolved.authorize !== undefined && typeof resolved.authorize !== 'function') throw new TypeError(`Invalid authorization: ${name}`);
    if (field.kind !== 'leaf') checkImplementation(field.kind === 'object' ? field.fields : field.element.fields, resolved.fields ?? {});
  }
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
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
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(concat(chunks, size)); }
  catch { throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid UTF-8 body'); }
  try { return JSON.parse(text); }
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
async function execute(fields: FieldMap, implementations: Record<string, FieldImplementation>, selection: SelectionTree,
  parent: unknown, context: unknown, signal: AbortSignal, maxArrayLength: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = Object.create(null);
  for (const [name, nested] of Object.entries(selection)) {
    const field = fields[name]!;
    const implementation = implementations[name]!;
    if (implementation.authorize && !await raceWithSignal(implementation.authorize({ parent, context, signal }), signal)) {
      throw new SelectionFault(403, 'FORBIDDEN', 'Field access denied');
    }
    if (field.kind !== 'leaf' && (!parent || typeof parent !== 'object' || Array.isArray(parent))) {
      throw new TypeError('Nested parent object required');
    }
    const value = await raceWithSignal(implementation.resolve({ parent, context, signal }), signal);
    if (value === null) {
      if (!field.nullable) throw new TypeError('Non-null resolver result');
      data[name] = null;
    } else if (field.kind === 'leaf') data[name] = await raceWithSignal(validateStandardSchema(value, field.schema), signal);
    else if (field.kind === 'object') {
      if (!isRecord(value)) throw new TypeError('Object resolver result required');
      data[name] = await execute(field.fields, implementation.fields!, nested as SelectionTree, value, context, signal, maxArrayLength);
    }
    else {
      if (!Array.isArray(value)) throw new TypeError('Array resolver result required');
      if (value.length > maxArrayLength) throw new SelectionFault(413, 'SELECTION_LIMIT', 'Array element limit exceeded');
      const rows = [];
      for (const item of value) {
        if (!isRecord(item)) throw new TypeError('Array element must be an object');
        rows.push(await execute(field.element.fields, implementation.fields!, nested as SelectionTree, item, context, signal, maxArrayLength));
      }
      data[name] = rows;
    }
  }
  return data;
}

export function createSelectionHandler<Context>(options: { resources: readonly SelectionImplementation<any, any, Context>[]; limits: SelectionLimits }) {
  validLimits(options.limits);
  const resources = new Map<string, SelectionImplementation<any, any, Context>>();
  for (const resource of options.resources) {
    if (resources.has(resource.contract.resource)) throw new TypeError(`Duplicate resource: ${resource.contract.resource}`);
    resources.set(resource.contract.resource, resource);
  }
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/__axnexus/select') throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid selection route');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new SelectionFault(400, 'INVALID_REQUEST', 'JSON content type required');
      const payload = await readBody(request, options.limits.maxRequestBytes);
      if (!isRecord(payload) || payload.protocol !== 'axnexus.selection' || payload.version !== 1
        || typeof payload.resource !== 'string' || !isRecord(payload.args) || !isRecord(payload.select)
        || Object.keys(payload).some((key) => !['protocol', 'version', 'resource', 'args', 'select'].includes(key))) {
        throw new SelectionFault(400, 'INVALID_REQUEST', 'Invalid selection protocol request');
      }
      const implementation = resources.get(payload.resource);
      if (!implementation) throw new SelectionFault(404, 'UNKNOWN_RESOURCE', 'Unknown selection resource');
      const selection = validateSelectionTree(implementation.contract.fields, payload.select, options.limits);
      let args: unknown;
      try { args = await raceWithSignal(validateStandardSchema(payload.args, implementation.contract.args), request.signal); }
      catch (error) { if (request.signal.aborted) throw error; throw new SelectionFault(422, 'INVALID_ARGS', 'Invalid resource arguments'); }
      if (!await raceWithSignal(implementation.authorizeResource({ context, signal: request.signal }), request.signal)) {
        throw new SelectionFault(403, 'FORBIDDEN', 'Resource access denied');
      }
      const root = await raceWithSignal(implementation.load({ args, context, signal: request.signal }), request.signal);
      if (root === null) {
        if (!implementation.contract.nullable) throw new TypeError('Non-null root is missing');
        return response({ data: null }, 200);
      }
      const data = await execute(implementation.contract.fields, implementation.fields, selection, root, context, request.signal, options.limits.maxArrayLength);
      return response({ data }, 200);
    } catch (error) {
      const fault = error instanceof SelectionFault ? error
        : request.signal.aborted ? new SelectionFault(400, 'CANCELED', 'Selection request canceled')
          : new SelectionFault(500, 'INTERNAL_ERROR', 'Selection execution failed');
      return response({ error: { code: fault.code, message: fault.message } }, fault.status);
    }
  };
}
