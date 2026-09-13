import type { ResolvedRequestConfig, HttpResponse } from './types.js';

export type HttpErrorCode =
  | 'ERR_BAD_RESPONSE'
  | 'ERR_NETWORK'
  | 'ETIMEDOUT'
  | 'ERR_CANCELED'
  | 'ERR_BAD_PAYLOAD'
  | 'ERR_TRANSFORM_REQUEST'
  | 'ERR_TRANSFORM_RESPONSE'
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

export function toError(
  error: unknown,
  config: ResolvedRequestConfig,
  timeoutTriggered: boolean,
  canceled: boolean,
): HttpError {
  // The controller that timed out/canceled the attempt is authoritative even
  // when a custom adapter reports a generic HttpError of its own.
  if (timeoutTriggered) {
    return new HttpError('Request timed out', {
      code: 'ETIMEDOUT',
      config,
      isTimeout: true,
      retryable: true,
      cause: error,
    });
  }
  if (canceled) {
    return new HttpError('Request canceled', {
      code: 'ERR_CANCELED',
      config,
      isAbort: true,
      cause: error,
    });
  }
  if (error instanceof HttpError) {
    if (!error.config) {
      return new HttpError(error.message, {
        code: error.code,
        config,
        status: error.status,
        response: error.response,
        isAbort: error.isAbort,
        isTimeout: error.isTimeout,
        retryable: error.retryable,
        cause: error,
      });
    }
    return error;
  }
  return new HttpError('Network request failed', {
    code: 'ERR_NETWORK',
    config,
    retryable: true,
    cause: error,
  });
}

export function responseInterceptorError(error: unknown, config: ResolvedRequestConfig): HttpError {
  if (error instanceof HttpError) {
    return new HttpError(error.message, {
      code: error.code,
      status: error.status,
      config: error.config ?? config,
      response: error.response,
      isAbort: error.isAbort,
      isTimeout: error.isTimeout,
      retryable: false,
      cause: error,
    });
  }
  return new HttpError(error instanceof Error ? error.message : 'Response interceptor failed', {
    code: 'ERR_NETWORK',
    config,
    retryable: false,
    cause: error,
  });
}
