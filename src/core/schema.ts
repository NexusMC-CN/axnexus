/** Standard Schema v1 issue, including symbol keys and structured path segments. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export interface StandardSchemaSuccessResult<T = unknown> {
  readonly value: T;
  readonly issues?: undefined;
}

export interface StandardSchemaFailureResult {
  readonly issues: readonly StandardSchemaIssue[];
}

export type StandardSchemaResult<T = unknown> = StandardSchemaSuccessResult<T> | StandardSchemaFailureResult;

/**
 * Structural Standard Schema v1 compatibility. Metadata remains optional for
 * existing hand-written validators. The first generic remains output, as in
 * the original StandardSchema<T> API.
 */
export interface StandardSchema<TOutput = unknown, TInput = unknown> {
  readonly '~standard': {
    readonly version?: 1;
    readonly vendor?: string;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
    readonly validate: (value: unknown) => StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
  };
}

export type InferSchemaInput<TSchema extends StandardSchema> = NonNullable<TSchema['~standard']['types']>['input'];
export type InferSchemaOutput<TSchema extends StandardSchema> = TSchema extends StandardSchema<infer TOutput, unknown> ? TOutput : never;

let schemaErrorPrototypes: WeakSet<object>;

export class SchemaValidationError extends Error {
  readonly issues: readonly StandardSchemaIssue[];

  static {
    const key = Symbol.for('@nexusmc-cn/axnexus@0.2.0/SchemaValidationError/prototypes');
    const registry = globalThis as typeof globalThis & { [key: symbol]: unknown };
    schemaErrorPrototypes = (registry[key] ??= new WeakSet<object>()) as WeakSet<object>;
    schemaErrorPrototypes.add(SchemaValidationError.prototype);
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== SchemaValidationError) return super[Symbol.hasInstance](value);
    if (super[Symbol.hasInstance](value)) return true;
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    for (let prototype = Object.getPrototypeOf(value); prototype; prototype = Object.getPrototypeOf(prototype)) {
      if (schemaErrorPrototypes.has(prototype)) return true;
    }
    return false;
  }

  constructor(issues: readonly StandardSchemaIssue[], options: { message?: string; cause?: unknown } = {}) {
    const message = options.message ?? (issues.map((issue) => issue.message).filter(Boolean).join('; ') || 'Response schema validation failed');
    super(message, { cause: options.cause });
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
}

export function isSchemaValidationError(value: unknown): value is SchemaValidationError {
  return value instanceof SchemaValidationError;
}

function invalidResult(): SchemaValidationError {
  return new SchemaValidationError([{ message: 'Schema validator returned an invalid result' }]);
}

export async function validateStandardSchema<T>(value: unknown, schema: StandardSchema<T>): Promise<T> {
  const result = await schema['~standard'].validate(value);
  if (!result || typeof result !== 'object') throw invalidResult();
  // Presence of issues denotes failure, including an empty array. Malformed
  // results must not silently turn into successful undefined payloads.
  if ('issues' in result && result.issues !== undefined) {
    if (!Array.isArray(result.issues) || result.issues.some((issue) => !issue || typeof issue !== 'object' || typeof issue.message !== 'string')) {
      throw invalidResult();
    }
    throw new SchemaValidationError(result.issues);
  }
  if (!('value' in result)) throw invalidResult();
  return result.value;
}
