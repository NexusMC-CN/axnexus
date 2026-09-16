export interface StandardSchemaIssue {
  message: string;
  path?: readonly (PropertyKey | { key: PropertyKey })[];
}

export interface StandardSchemaResult<T = unknown> {
  value?: T;
  issues?: readonly StandardSchemaIssue[];
}

export interface StandardSchema<T = unknown> {
  '~standard': {
    validate(value: unknown): StandardSchemaResult<T> | Promise<StandardSchemaResult<T>>;
  };
}

export async function validateStandardSchema<T>(value: unknown, schema: StandardSchema<T>): Promise<T> {
  const result = await schema['~standard'].validate(value);
  // Standard Schema reports failure by the *presence* of `issues`; a failure
  // result is allowed to carry an empty array. Only a result without `issues`
  // is a success, so an empty-issues failure must still throw rather than
  // handing `undefined` back to the caller as valid data.
  if (!result || !('issues' in result) || result.issues === undefined || result.issues === null) {
    return (result as StandardSchemaResult<T> | undefined)?.value as T;
  }
  const issues = Array.isArray(result.issues) ? result.issues : [];
  const message = issues.map((issue) => issue?.message).filter(Boolean).join('; ') || 'Response schema validation failed';
  const error = new Error(message);
  (error as Error & { issues?: readonly StandardSchemaIssue[] }).issues = issues;
  throw error;
}
