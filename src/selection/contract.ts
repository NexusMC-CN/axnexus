import type { InferSchemaInput, InferSchemaOutput, StandardSchema } from '../core/schema.js';

type Schema = StandardSchema<any, any>;

export interface FieldOptions<Nullable extends boolean = boolean> {
  readonly nullable?: Nullable;
  readonly cost?: number;
}
export interface LeafOptions<Output, Nullable extends boolean = boolean> extends FieldOptions<Nullable> {
  /** Validates the serialized value after the resolver schema has transformed it. */
  readonly wireSchema?: StandardSchema<Output>;
}

export interface LeafField<S extends Schema = Schema, N extends boolean = boolean> {
  readonly kind: 'leaf';
  readonly schema: S;
  readonly wireSchema?: StandardSchema<InferSchemaOutput<S>>;
  readonly nullable: N;
  readonly cost: number;
}
export interface ObjectField<F extends FieldMap = FieldMap, N extends boolean = boolean> {
  readonly kind: 'object';
  readonly fields: F;
  readonly nullable: N;
  readonly cost: number;
}
export interface ArrayField<E extends ObjectField<any, any> = ObjectField<any, any>, N extends boolean = boolean> {
  readonly kind: 'array';
  readonly element: E;
  readonly nullable: N;
  readonly cost: number;
}
export type Field = LeafField | ObjectField<any, any> | ArrayField<any, any>;
export type FieldMap = Record<string, Field>;

export interface SelectionResource<Name extends string = string, Args extends Schema = Schema,
  F extends FieldMap = FieldMap, N extends boolean = boolean> {
  readonly resource: Name;
  readonly args: Args;
  readonly fields: F;
  readonly nullable: N;
}

function costOf(value: unknown): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError('Field cost must be a positive safe integer');
  return value as number;
}

function schemaOf(value: unknown): asserts value is Schema {
  if (!value || typeof value !== 'object' || !('~standard' in value)
    || typeof (value as Schema)['~standard']?.validate !== 'function') {
    throw new TypeError('Field or args schema must implement Standard Schema');
  }
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function checkFields(fields: FieldMap, seen: Set<object>): void {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || seen.has(fields)) {
    throw new TypeError('Invalid or recursive field map');
  }
  seen.add(fields);
  if (Object.keys(fields).length === 0) throw new TypeError('Field map must not be empty');
  for (const [name, field] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || forbidden.has(name)) throw new TypeError(`Invalid field name: ${name}`);
    if (!field || typeof field !== 'object') throw new TypeError(`Invalid field: ${name}`);
    costOf(field.cost);
    if (field.kind === 'leaf') schemaOf(field.schema);
    else if (field.kind === 'object') checkFields(field.fields, seen);
    else if (field.kind === 'array') {
      if (field.element?.kind !== 'object') throw new TypeError(`Array field ${name} requires an object element`);
      checkFields(field.element.fields, seen);
    } else throw new TypeError(`Invalid field kind: ${name}`);
  }
  seen.delete(fields);
}

export function leaf<S extends Schema>(schema: S): LeafField<S, false>;
export function leaf<S extends Schema, const N extends boolean>(schema: S, options: LeafOptions<InferSchemaOutput<S>, N>): LeafField<S, N>;
export function leaf<S extends Schema>(schema: S, options: LeafOptions<InferSchemaOutput<S>> = {}): LeafField<S> {
  options ??= {};
  schemaOf(schema);
  if (options.wireSchema !== undefined) schemaOf(options.wireSchema);
  return { kind: 'leaf', schema, wireSchema: options.wireSchema, nullable: options.nullable ?? false, cost: costOf(options.cost) };
}
export function object<const F extends FieldMap>(fields: F): ObjectField<F, false>;
export function object<const F extends FieldMap, const N extends boolean>(fields: F, options: FieldOptions<N>): ObjectField<F, N>;
export function object<const F extends FieldMap>(fields: F, options: FieldOptions = {}): ObjectField<F> {
  options ??= {};
  costOf(options.cost);
  checkFields(fields, new Set());
  return { kind: 'object', fields, nullable: options.nullable ?? false, cost: costOf(options.cost) };
}
export function array<const E extends ObjectField<any, any>>(element: E): ArrayField<E, false>;
export function array<const E extends ObjectField<any, any>, const N extends boolean>(element: E, options: FieldOptions<N>): ArrayField<E, N>;
export function array<const E extends ObjectField<any, any>>(element: E, options: FieldOptions = {}): ArrayField<E> {
  options ??= {};
  if (element?.kind !== 'object') throw new TypeError('Array elements must be objects');
  return { kind: 'array', element, nullable: options.nullable ?? false, cost: costOf(options.cost) };
}
export function defineSelectionResource<const Name extends string, Args extends Schema, const F extends FieldMap,
  const N extends boolean = false>(definition: { resource: Name; args: Args; fields: F; nullable?: N }): SelectionResource<Name, Args, F, N> {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*\.v[1-9][0-9]*$/.test(definition.resource)) {
    throw new TypeError('Resource name must be versioned (for example users.byId.v1)');
  }
  schemaOf(definition.args);
  checkFields(definition.fields, new Set());
  return { ...definition, nullable: (definition.nullable ?? false) as N };
}

export type SelectionFor<F extends FieldMap> = {
  readonly [K in keyof F]?: F[K] extends LeafField<any, any> ? true
    : F[K] extends ObjectField<infer Nested, any> ? SelectionFor<Nested>
    : F[K] extends ArrayField<infer Element, any> ? SelectionFor<Element['fields']> : never;
};
export type ExactSelection<F extends FieldMap, S> = {
  [K in keyof S]: K extends keyof F
    ? F[K] extends LeafField<any, any> ? S[K] extends true | undefined ? S[K] : never
      : F[K] extends ObjectField<infer Nested, any> ? S[K] extends object ? ExactSelection<Nested, S[K]> : S[K]
        : F[K] extends ArrayField<infer Element, any> ? S[K] extends object ? ExactSelection<Element['fields'], S[K]> : S[K]
          : never
    : never;
};
type NullableValue<T, N extends boolean> = true extends N ? T | null : T;
type SelectionAt<S, K extends PropertyKey> = K extends keyof S ? NonNullable<S[K]> : never;
type ProjectField<F, S> = F extends LeafField<infer SchemaType, infer N> ? NullableValue<InferSchemaOutput<SchemaType>, N>
  : F extends ObjectField<infer Nested, infer N> ? NullableValue<ProjectFields<Nested, S>, N>
  : F extends ArrayField<infer Element, infer N> ? NullableValue<ProjectFields<Element['fields'], S>[], N> : never;
type SelectedKeys<F, S> = keyof F & keyof S;
type RequiredKeys<F, S> = { [K in SelectedKeys<F, S>]: undefined extends S[K] ? never : K }[SelectedKeys<F, S>];
export type ProjectFields<F extends FieldMap, S> =
  { [K in RequiredKeys<F, S>]: ProjectField<F[K], SelectionAt<S, K>> }
  & { [K in Exclude<SelectedKeys<F, S>, RequiredKeys<F, S>>]?: ProjectField<F[K], SelectionAt<S, K>> };
export type SelectionResult<R extends SelectionResource, S extends SelectionFor<R['fields']>> =
  NullableValue<ProjectFields<R['fields'], S>, R['nullable']>;
export type SelectionArgs<R extends SelectionResource> = InferSchemaInput<R['args']>;
