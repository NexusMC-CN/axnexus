import { isHttpError } from '../core/errors.js';
import { AxiosHeaders, type HeaderInput } from '../headers/headers.js';

export interface RequestStartRecord {
  method: string;
  url: string;
  headers?: HeaderInput;
}

export interface RequestLogRecord {
  phase: 'start' | 'complete' | 'error';
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  status?: number;
  duration?: number;
  responseBytes?: number;
  error?: unknown;
}

/** Input schema accepted by `record`, `complete` and `error` before normalization. */
export type RequestLogInput = Omit<RequestLogRecord, 'headers'> & {
  headers?: HeaderInput;
};

export interface RequestLoggerOptions {
  /** Additional header names to redact in addition to the built-in set. */
  redactHeaders?: string[];
  /** Clock used for lifecycle duration measurements. Defaults to Date.now. */
  now?: () => number;
}

/** Fields accepted by a lifecycle handle after a request has started. */
export type RequestLifecycleInput = Omit<RequestLogInput, 'phase' | 'method' | 'url' | 'headers'>;

export interface RequestLogHandle {
  complete(input?: RequestLifecycleInput): void;
  error(input?: RequestLifecycleInput): void;
}

export interface RequestLogger {
  start(input: RequestStartRecord): RequestLogHandle;
  /** Emit one complete record after normalizing method, headers and errors. */
  record(input: RequestLogInput): void;
  /** Compatibility method for callers that emit a complete record themselves. */
  complete(input: Omit<RequestLogInput, 'phase'>): void;
  /** Compatibility method for callers that emit an error record themselves. */
  error(input: Omit<RequestLogInput, 'phase'>): void;
}

function normalizeHeaders(headers: HeaderInput | undefined, redact: Set<string>): Record<string, string> {
  const output: Record<string, string> = {};
  AxiosHeaders.from(headers).forEach((value, name) => {
    // Header names are case-insensitive and `AxiosHeaders.normalize(true)` can
    // re-case them to `Authorization`/`Cookie`; match on the lowercased name so
    // a formatted instance cannot bypass redaction.
    output[name] = redact.has(name.toLowerCase()) ? '[REDACTED]' : value;
  });
  return output;
}

function sanitizeError(error: unknown, redact: Set<string>): unknown {
  if (isHttpError(error)) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      isAbort: error.isAbort,
      isTimeout: error.isTimeout,
      retryable: error.retryable,
      ...(error.config ? {
        config: {
          method: error.config.method,
          url: error.config.url,
          headers: normalizeHeaders(error.config.headers, redact),
        },
      } : {}),
    };
  }

  // Generic errors can carry arbitrary enumerable fields (including request
  // configs). Keep the useful, stable fields and intentionally omit the rest.
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>;
    const output: Record<string, unknown> = {
      name: typeof source.name === 'string' ? source.name : 'Error',
    };
    if (typeof source.message === 'string') output.message = source.message;
    for (const key of ['code', 'status', 'isAbort', 'isTimeout', 'retryable']) {
      const value = source[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        output[key] = value;
      }
    }
    return output;
  }

  return error;
}

function sanitizeRecordError<T extends { error?: unknown }>(record: T, redact: Set<string>): T {
  if (record.error === undefined) return record;
  return { ...record, error: sanitizeError(record.error, redact) };
}

export function createRequestLogger(
  emit: (record: RequestLogRecord) => void,
  options: RequestLoggerOptions = {},
): RequestLogger {
  const redact = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    ...(options.redactHeaders ?? []),
  ].map((name) => name.toLowerCase()));
  const now = options.now ?? Date.now;

  const readNow = (): number => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  const normalizeRecord = (input: RequestLogInput): RequestLogRecord => {
    const sanitized = sanitizeRecordError(input, redact);
    return {
      ...sanitized,
      ...(typeof input.method === 'string' ? { method: input.method.toUpperCase() } : {}),
      ...(input.headers ? { headers: normalizeHeaders(input.headers, redact) } : {}),
    } as RequestLogRecord;
  };

  const emitCompatibilityRecord = (
    phase: 'complete' | 'error',
    input: Omit<RequestLogInput, 'phase'>,
  ): void => {
    emit(normalizeRecord({ ...input, phase }));
  };

  return {
    record(input: RequestLogInput): void {
      emit(normalizeRecord(input));
    },
    start(input: RequestStartRecord): RequestLogHandle {
      const method = input.method.toUpperCase();
      const headers = normalizeHeaders(input.headers, redact);
      const startedAt = readNow();
      let finished = false;

      emit({ phase: 'start', method, url: input.url, headers });

      const finish = (phase: 'complete' | 'error', record: RequestLifecycleInput = {}): void => {
        if (finished) return;
        finished = true;
        const duration = record.duration ?? Math.max(0, readNow() - startedAt);
        emit({
          ...sanitizeRecordError(record, redact),
          phase,
          method,
          url: input.url,
          headers,
          duration,
        });
      };

      return {
        complete(record: RequestLifecycleInput = {}): void {
          finish('complete', record);
        },
        error(record: RequestLifecycleInput = {}): void {
          finish('error', record);
        },
      };
    },
    complete(input: Omit<RequestLogRecord, 'phase'>): void {
      emitCompatibilityRecord('complete', input);
    },
    error(input: Omit<RequestLogRecord, 'phase'>): void {
      emitCompatibilityRecord('error', input);
    },
  };
}
