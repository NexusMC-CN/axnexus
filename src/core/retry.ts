import { HttpError } from './errors.js';
import type { HttpResponse, ResolvedRequestConfig, RetryDelay, RetryOptions } from './types.js';

export const DEFAULT_RETRY_ON = [408, 429, 500, 502, 503, 504];
export const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function retryAfterMs(response: HttpResponse<unknown> | undefined): number | undefined {
  const raw = response?.headers.get('retry-after');
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

export function statusShouldThrow(config: ResolvedRequestConfig, status: number): boolean {
  if (typeof config.validateStatus === 'function') return !config.validateStatus(status);
  const policy = config.throwHttpErrors;
  if (typeof policy === 'function') return policy(status);
  if (policy === false) return false;
  return !(status >= 200 && status < 300);
}

export function isReadableStreamBody(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof ReadableStream === 'function' && value instanceof ReadableStream) return true;
  return typeof (value as { getReader?: unknown }).getReader === 'function';
}

export async function shouldRetry(
  error: HttpError,
  config: ResolvedRequestConfig,
  retry: RetryOptions,
  retryOn: Set<number>,
  retryCount: number,
  delay: number,
): Promise<boolean> {
  // Caller cancellation and non-replayable bodies are always hard stops.
  if (error.isAbort || isReadableStreamBody(config.body)) return false;
  if (typeof retry.shouldRetry === 'function') {
    return retry.shouldRetry({ error, retryCount, delay });
  }
  if (error.retryable === false) return false;
  const methods = new Set((retry.methods ?? []).map((method) => method.toUpperCase()));
  const methodAllowed = methods.size > 0
    ? methods.has(config.method)
    : IDEMPOTENT_METHODS.has(config.method) || Boolean(config.retryUnsafeMethods);
  if (!methodAllowed) return false;
  const errorCodes = new Set(retry.errorCodes ?? []);
  const defaultDecision = error.isTimeout || error.code === 'ERR_NETWORK'
    ? true
    : error.code === 'ERR_BAD_RESPONSE' && error.status !== undefined
      ? (retry.statusCodes ? retry.statusCodes.includes(error.status) : retryOn.has(error.status))
      : errorCodes.has(error.code);
  return defaultDecision;
}

export function calculateRetryDelay(
  retry: RetryOptions,
  retryDelay: RetryDelay | number | undefined,
  retryCount: number,
  error: HttpError,
): number {
  let delay = typeof retryDelay === 'function'
    ? Math.max(0, Number(retryDelay(retryCount, error)) || 0)
    : Math.max(0, Number(retryDelay) || 0) * retryCount;
  const retryAfter = retry.respectRetryAfter === false ? undefined : retryAfterMs(error.response);
  if (retryAfter !== undefined) delay = retryAfter;
  if (retry.maxDelay !== undefined) delay = Math.min(delay, Math.max(0, retry.maxDelay));
  if (retry.jitter) {
    delay = typeof retry.jitter === 'function'
      ? Math.max(0, Number(retry.jitter(delay, retryCount, error)) || 0)
      : Math.random() * delay;
  }
  return delay;
}
