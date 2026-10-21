import type { HttpResponse } from '../core/types.js';
import type { InferSchemaOutput, StandardSchema } from '../core/schema.js';

export interface EndpointErrorDefinition {
  readonly status: number;
  readonly schema: StandardSchema<any, any>;
}

export type EndpointErrorMap = Readonly<Record<string, EndpointErrorDefinition>>;

/** A business code is independent of the client's transport HttpErrorCode. */
export class DomainError<Code extends string = string, Data = unknown> extends Error {
  readonly code: Code;
  readonly status: number;
  readonly data: Data;
  readonly response: HttpResponse<unknown>;

  constructor(code: Code, data: Data, response: HttpResponse<unknown>) {
    super(`Endpoint returned ${code} (HTTP ${response.status})`);
    this.name = 'DomainError';
    this.code = code;
    this.status = response.status;
    this.data = data;
    this.response = response;
  }
}

export type EndpointDomainError<Errors extends EndpointErrorMap> = {
  [Code in keyof Errors & string]: DomainError<Code, InferSchemaOutput<Errors[Code]['schema']>>
}[keyof Errors & string];
