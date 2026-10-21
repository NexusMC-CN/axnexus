import { isHttpError } from '../core/errors.js';
import { AxiosHeaders, type HeaderInput } from '../headers/headers.js';
import { SENSITIVE_QUERY_NAMES } from '../utils/sensitive-query.js';

/** Redact query values without normalizing ordinary parameters or relative URLs. */
export function createQueryRedactor(additionalNames: readonly string[] = []): (text: string) => string {
  const names = new Set([...SENSITIVE_QUERY_NAMES, ...additionalNames].map((name) => name.toLowerCase()));
  return (text) => {
    let output = '';
    let cursor = 0;
    for (const match of text.matchAll(/([?&])([^=&#\s]+)=/g)) {
      if (match.index < cursor) continue;
      const decoded = new URLSearchParams(`${match[2]}=`).keys().next().value;
      if (!decoded || !names.has(decoded.toLowerCase())) continue;
      const start = match.index + match[0].length;
      const delimiter = text.slice(start).search(/[&#]/);
      const end = delimiter < 0 ? text.length : start + delimiter;
      // Literal spaces are valid URL input. In prose, conservatively redact
      // through the next query delimiter rather than exposing part of a token.
      output += text.slice(cursor, start) + '[REDACTED]';
      cursor = end;
    }
    return output + text.slice(cursor);
  };
}

export function normalizeHeaders(headers: HeaderInput | undefined, redact: Set<string>): Record<string, string> {
  const output: Record<string, string> = {};
  AxiosHeaders.from(headers).forEach((value, name) => {
    // Header names are case-insensitive and `AxiosHeaders.normalize(true)` can
    // re-case them to `Authorization`/`Cookie`; match on the lowercased name so
    // a formatted instance cannot bypass redaction.
    output[name] = redact.has(name.toLowerCase()) ? '[REDACTED]' : value;
  });
  return output;
}

function sanitizeError(error: unknown, redact: Set<string>, redactText: (text: string) => string): unknown {
  if (isHttpError(error)) {
    return {
      name: error.name,
      message: redactText(error.message),
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      isAbort: error.isAbort,
      isTimeout: error.isTimeout,
      retryable: error.retryable,
      ...(error.config ? {
        config: {
          method: error.config.method,
          url: redactText(error.config.url),
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
    if (typeof source.message === 'string') output.message = redactText(source.message);
    for (const key of ['code', 'status', 'isAbort', 'isTimeout', 'retryable']) {
      const value = source[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        output[key] = value;
      }
    }
    return output;
  }

  return typeof error === 'string' ? redactText(error) : error;
}

export function sanitizeRecordError<T extends { error?: unknown }>(
  record: T,
  redact: Set<string>,
  redactText: (text: string) => string,
  redactError?: (error: unknown) => unknown,
): T {
  if (record.error === undefined) return record;
  const sanitized = sanitizeError(record.error, redact, redactText);
  return { ...record, error: redactError ? redactError(sanitized) : sanitized };
}
