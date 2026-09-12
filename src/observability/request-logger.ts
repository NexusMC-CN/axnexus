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
) {
  const redact = new Set((options.redactHeaders ?? ['authorization', 'cookie', 'set-cookie']).map((name) => name.toLowerCase()));
  return {
    start(input: RequestStartRecord): void {
      emit({ phase: 'start', method: input.method.toUpperCase(), url: input.url, headers: normalizeHeaders(input.headers, redact) });
    },
    complete(input: Omit<RequestLogRecord, 'phase'>): void {
      emit({ ...input, phase: 'complete' });
    },
    error(input: Omit<RequestLogRecord, 'phase'>): void {
      emit({ ...input, phase: 'error' });
    },
  };
}
