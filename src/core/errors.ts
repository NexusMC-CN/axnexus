import type { ResolvedRequestConfig, HttpResponse } from './types.js';

export type HttpErrorCode =
  | 'ERR_BAD_RESPONSE'
  | 'ERR_NETWORK'
  | 'ETIMEDOUT'
  | 'ERR_CANCELED'
  | 'ERR_BAD_PAYLOAD'
  | 'ERR_INVALID_HEADER'
  | 'ERR_RATE_LIMIT_QUEUE_TIMEOUT'
  | 'ERR_UNSUPPORTED_ADAPTER'
  | 'ERR_MAX_BODY_SIZE'
  | 'ERR_PROTOCOL_NEGOTIATION';

export class HttpError<T = unknown> extends Error {
  readonly code: HttpErrorCode;
  readonly status?: number;
  readonly config?: ResolvedRequestConfig;
  readonly response?: HttpResponse<T>;
  readonly isAbort: boolean;
  readonly isTimeout: boolean;
  readonly retryable: boolean;

  constructor(message: string, options: {
    code: HttpErrorCode;
    status?: number;
    config?: ResolvedRequestConfig;
    response?: HttpResponse<T>;
    isAbort?: boolean;
    isTimeout?: boolean;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = 'HttpError';
    this.code = options.code;
    this.status = options.status;
    this.config = options.config;
    this.response = options.response;
    this.isAbort = Boolean(options.isAbort);
    this.isTimeout = Boolean(options.isTimeout);
    this.retryable = Boolean(options.retryable);
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}
