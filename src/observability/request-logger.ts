import type { HeaderInput } from '../headers/headers.js';
import { createQueryRedactor, normalizeHeaders, sanitizeRecordError } from './redaction.js';

export interface RequestStartRecord {
  method: string;
  url: string;
  headers?: HeaderInput;
}

/** Accumulated lifecycle phase durations in milliseconds. */
export interface RequestLogTimings {
  queue: number;
  retry: number;
  /** Present when an exposed raw response body has finished. */
  body?: number;
}

export interface RequestLogRecord {
  phase: 'start' | 'complete' | 'error';
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  status?: number;
  duration?: number;
  timings?: RequestLogTimings;
  attempts?: number;
  cache?: 'hit' | 'dedupe';
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
  /** Additional case-insensitive query names to redact in URLs and error messages. */
  redactQueryParams?: readonly string[];
  /** Receives the sanitized error; use to redact application-specific message secrets. */
  redactError?: (error: unknown) => unknown;
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
  const redactText = createQueryRedactor(options.redactQueryParams);
  const now = options.now ?? Date.now;

  const readNow = (): number => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  const normalizeRecord = (input: RequestLogInput): RequestLogRecord => {
    const sanitized = sanitizeRecordError(input, redact, redactText, options.redactError);
    return {
      ...sanitized,
      ...(typeof input.url === 'string' ? { url: redactText(input.url) } : {}),
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

      emit({ phase: 'start', method, url: redactText(input.url), headers });

      const finish = (phase: 'complete' | 'error', record: RequestLifecycleInput = {}): void => {
        if (finished) return;
        finished = true;
        const duration = record.duration ?? Math.max(0, readNow() - startedAt);
        emit({
          ...sanitizeRecordError(record, redact, redactText, options.redactError),
          phase,
          method,
          url: redactText(input.url),
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
