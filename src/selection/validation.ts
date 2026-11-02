import { raceWithSignal } from '../core/control.js';
import { validateStandardSchema } from '../core/schema.js';
import type { ArrayField, Field, FieldMap } from './contract.js';

export interface SelectionLimits {
  readonly maxRequestBytes: number;
  readonly maxDepth: number;
  readonly maxFields: number;
  readonly maxCost: number;
  readonly maxArrayLength: number;
}
export interface SelectionTree { [field: string]: true | SelectionTree; }
export class SelectionFault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'SelectionFault'; }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validLimits(limits: SelectionLimits): void {
  if (!isRecord(limits)) throw new TypeError('Selection limits are required');
  for (const name of ['maxRequestBytes', 'maxDepth', 'maxFields', 'maxCost', 'maxArrayLength'] as const) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  }
}
function fail(message: string): never { throw new SelectionFault(400, 'INVALID_SELECTION', message); }

/** Reject unknown/empty selections and budget them before any resource I/O. */
export function validateSelectionTree(fields: FieldMap, selection: unknown, limits: Pick<SelectionLimits, 'maxDepth' | 'maxFields' | 'maxCost' | 'maxArrayLength'>): SelectionTree {
  let count = 0;
  let cost = 0;
  const seen = new WeakSet<object>();
  const walk = (fieldMap: FieldMap, value: unknown, depth: number, factor: number): SelectionTree => {
    if (!isRecord(value) || Object.keys(value).length === 0) return fail('Selection must be a non-empty object');
    if (seen.has(value)) return fail('Recursive selection is invalid');
    seen.add(value);
    if (depth > limits.maxDepth) throw new SelectionFault(413, 'SELECTION_LIMIT', 'Selection depth exceeded');
    const result: SelectionTree = Object.create(null);
    for (const [name, nested] of Object.entries(value)) {
      if (!Object.hasOwn(fieldMap, name)) return fail(`Unknown field: ${name}`);
      const field = fieldMap[name]!;
      count++;
      if (count > limits.maxFields) throw new SelectionFault(413, 'SELECTION_LIMIT', 'Selection field count exceeded');
      cost += field.cost * factor;
      if (cost > limits.maxCost) throw new SelectionFault(413, 'SELECTION_LIMIT', 'Selection cost exceeded');
      if (field.kind === 'leaf') {
        if (nested !== true) return fail(`Leaf field ${name} requires true`);
        result[name] = true;
      } else if (field.kind === 'object') result[name] = walk(field.fields, nested, depth + 1, factor);
      else {
        const nextFactor = factor * limits.maxArrayLength;
        if (!Number.isSafeInteger(nextFactor)) throw new SelectionFault(413, 'SELECTION_LIMIT', 'Selection cost exceeded');
        cost += (field.element.cost - 1) * nextFactor;
        if (cost > limits.maxCost) throw new SelectionFault(413, 'SELECTION_LIMIT', 'Selection cost exceeded');
        result[name] = walk(field.element.fields, nested, depth + 1, nextFactor);
      }
    }
    seen.delete(value);
    return result;
  };
  return walk(fields, selection, 1, 1);
}

function exactKeys(data: Record<string, unknown>, selection: SelectionTree): void {
  const actual = Object.keys(data);
  const selected = Object.keys(selection);
  if (actual.length !== selected.length || actual.some((name) => !Object.hasOwn(selection, name))) {
    throw new TypeError('Selection response has missing or unexpected fields');
  }
}

/** Validate the exact selected response shape, without silently dropping extras. */
export async function validateSelectedData(fields: FieldMap, selection: SelectionTree, data: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!isRecord(data)) throw new TypeError('Selection response must be an object');
  exactKeys(data, selection);
  const output: Record<string, unknown> = {};
  for (const [name, nested] of Object.entries(selection)) {
    const field: Field | undefined = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (!field) throw new TypeError('Selection response field is not in contract');
    const value = data[name];
    if (value === null) {
      if (!field.nullable) throw new TypeError(`Non-null field ${name} is null`);
      output[name] = null;
      continue;
    }
    if (field.kind === 'leaf') {
      if (nested !== true) throw new TypeError('Invalid leaf selection');
      output[name] = await raceWithSignal(validateStandardSchema(value, field.wireSchema ?? field.schema), signal);
      if (output[name] === undefined) throw new TypeError(`Selected field ${name} is undefined`);
      if (output[name] === null && !field.nullable) throw new TypeError(`Non-null field ${name} is null`);
      if (typeof output[name] === 'object' && output[name] !== null) throw new TypeError(`Selected field ${name} is not scalar`);
    } else if (field.kind === 'object') output[name] = await validateSelectedData(field.fields, nested as SelectionTree, value, signal);
    else {
      if (!Array.isArray(value)) throw new TypeError(`Array field ${name} is not an array`);
      output[name] = await Promise.all(value.map((item) => validateSelectedData((field as ArrayField).element.fields, nested as SelectionTree, item, signal)));
    }
  }
  return output;
}
