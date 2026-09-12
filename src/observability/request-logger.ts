export interface RequestStartRecord {
  method: string;
  url: string;
  headers?: HeadersInit;
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

export interface RequestLoggerOptions {
  redactHeaders?: string[];
  /** Clock used for lifecycle duration measurements. Defaults to Date.now. */
  now?: () => number;
}

/** Fields accepted by a lifecycle handle after a request has started. */
export type RequestLifecycleInput = Omit<RequestLogRecord, 'phase' | 'method' | 'url' | 'headers'>;

export interface RequestLogHandle {
  complete(input?: RequestLifecycleInput): void;
  error(input?: RequestLifecycleInput): void;
}

export interface RequestLogger {
  start(input: RequestStartRecord): RequestLogHandle;
  /** Compatibility method for callers that emit a complete record themselves. */
  complete(input: Omit<RequestLogRecord, 'phase'>): void;
  /** Compatibility method for callers that emit an error record themselves. */
  error(input: Omit<RequestLogRecord, 'phase'>): void;
}

function normalizeHeaders(headers: HeadersInit | undefined, redact: Set<string>): Record<string, string> {
  const output: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    output[name] = redact.has(name) ? '[REDACTED]' : value;
  });
  return output;
}

export function createRequestLogger(
  emit: (record: RequestLogRecord) => void,
  options: RequestLoggerOptions = {},
): RequestLogger {
  const redact = new Set((options.redactHeaders ?? ['authorization', 'cookie', 'set-cookie']).map((name) => name.toLowerCase()));
  const now = options.now ?? Date.now;

  const readNow = (): number => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  const emitCompatibilityRecord = (
    phase: 'complete' | 'error',
    input: Omit<RequestLogRecord, 'phase'>,
  ): void => {
    emit({
      ...input,
      ...(input.headers ? { headers: normalizeHeaders(input.headers, redact) } : {}),
      phase,
    });
  };

  return {
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
          ...record,
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
