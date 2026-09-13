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
  if (result.issues && result.issues.length > 0) {
    const message = result.issues.map((issue) => issue.message).filter(Boolean).join('; ') || 'Response schema validation failed';
    const error = new Error(message);
    (error as Error & { issues?: readonly StandardSchemaIssue[] }).issues = result.issues;
    throw error;
  }
  return result.value as T;
}
