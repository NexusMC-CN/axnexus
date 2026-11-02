import type { FieldMap, SelectionResource } from './contract.js';
import { validateSelectionTree } from './validation.js';
import type { SelectionLimits, SelectionTree } from './validation.js';

export interface SelectionFieldDescription {
  readonly kind: 'leaf' | 'object' | 'array';
  readonly nullable: boolean;
  readonly cost: number;
  readonly fields?: Readonly<Record<string, SelectionFieldDescription>>;
  readonly element?: {
    readonly nullable: boolean;
    readonly cost: number;
    readonly fields: Readonly<Record<string, SelectionFieldDescription>>;
  };
}

export interface SelectionResourceDescription {
  readonly resource: string;
  readonly nullable: boolean;
  readonly fields: Readonly<Record<string, SelectionFieldDescription>>;
}

/** Developer-facing contract metadata. Never includes validation schemas or runtime data. */
export function describeSelectionResource(contract: SelectionResource): SelectionResourceDescription {
  const describeFields = (fields: FieldMap): Record<string, SelectionFieldDescription> => {
    const description: Record<string, SelectionFieldDescription> = {};
    for (const [name, field] of Object.entries(fields)) {
      const base = { kind: field.kind, nullable: field.nullable, cost: field.cost };
      description[name] = field.kind === 'leaf' ? base
        : field.kind === 'object' ? { ...base, fields: describeFields(field.fields) }
          : { ...base, element: { nullable: field.element.nullable, cost: field.element.cost, fields: describeFields(field.element.fields) } };
    }
    return description;
  };
  return { resource: contract.resource, nullable: contract.nullable, fields: describeFields(contract.fields) };
}

export interface SelectionMetrics {
  readonly fieldCount: number;
  readonly depth: number;
  readonly cost: number;
  readonly paths: readonly string[];
}

export interface SelectionInspection {
  readonly select: SelectionTree;
  readonly metrics: SelectionMetrics;
}

/** Applies the protocol validator first, then explains the same conservative cost budget. */
export function inspectSelection(contract: SelectionResource, select: unknown,
  limits: Pick<SelectionLimits, 'maxDepth' | 'maxFields' | 'maxCost' | 'maxArrayLength'>): SelectionInspection {
  const normalized = validateSelectionTree(contract.fields, select, limits);
  const paths: string[] = [];
  let depth = 0;
  let cost = 0;
  const walk = (fields: FieldMap, selection: SelectionTree, level: number, factor: number, prefix: string): void => {
    depth = Math.max(depth, level);
    for (const [name, nested] of Object.entries(selection)) {
      const field = fields[name]!;
      paths.push(prefix + name);
      cost += field.cost * factor;
      if (field.kind === 'object') walk(field.fields, nested as SelectionTree, level + 1, factor, prefix + name + '.');
      else if (field.kind === 'array') {
        const nextFactor = factor * limits.maxArrayLength;
        cost += (field.element.cost - 1) * nextFactor;
        walk(field.element.fields, nested as SelectionTree, level + 1, nextFactor, prefix + name + '.');
      }
    }
  };
  walk(contract.fields, normalized, 1, 1, '');
  return { select: normalized, metrics: { fieldCount: paths.length, depth, cost, paths } };
}

/** One completed request. Do not include arguments, selected values, or user identifiers. */
export interface SelectionObservation {
  readonly mode: 'dynamic' | 'registered' | 'invalid';
  readonly resource?: string;
  readonly plan?: string;
  readonly status: number;
  readonly code?: string;
  readonly durationMs: number;
  readonly requestBytes?: number;
  readonly fieldCount?: number;
  readonly depth?: number;
  readonly estimatedCost?: number;
}

export type SelectionObserver = (observation: Readonly<SelectionObservation>) => void | Promise<void>;
