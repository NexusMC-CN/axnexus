import { HttpError } from '../errors.js';
import type { RequestConfig, RetryOptions } from '../types.js';

function invalid(name: string, expected: string): never {
  throw new HttpError(`${name} must be ${expected}`, { code: 'ERR_INVALID_CONFIG' });
}

export function validateMaxBodySize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid('maxBodySize', 'a non-negative safe integer');
  }
  return value;
}

export function validateTimeout(value: unknown, name = 'timeout'): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(name, 'a non-negative safe integer');
  }
  return value;
}

export function validateDelay(value: unknown, name = 'retry.delay'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    invalid(name, 'a finite non-negative number no greater than Number.MAX_SAFE_INTEGER');
  }
  return value;
}

function validateStatuses(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 100 || item > 599)) {
    invalid(name, 'an array of HTTP status codes');
  }
}

function validateStrings(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    invalid(name, 'an array of non-empty strings');
  }
}

export function validateRetryOptions(value: unknown, name = 'retry'): void {
  if (value === undefined) return;
  if (typeof value === 'number') {
    validateTimeout(value, name);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name, 'a number or an options object');
  const retry = value as RetryOptions;
  validateTimeout(retry.limit, `${name}.limit`);
  if (retry.delay !== undefined && typeof retry.delay !== 'function') validateDelay(retry.delay, `${name}.delay`);
  if (retry.maxDelay !== undefined) validateDelay(retry.maxDelay, `${name}.maxDelay`);
  validateStrings(retry.methods, `${name}.methods`);
  validateStrings(retry.errorCodes, `${name}.errorCodes`);
  validateStatuses(retry.statusCodes, `${name}.statusCodes`);
  for (const key of ['shouldRetry', 'beforeRetry'] as const) {
    if (retry[key] !== undefined && typeof retry[key] !== 'function') invalid(`${name}.${key}`, 'a function');
  }
  if (retry.jitter !== undefined && typeof retry.jitter !== 'boolean' && typeof retry.jitter !== 'function') {
    invalid(`${name}.jitter`, 'a boolean or a function');
  }
  if (retry.respectRetryAfter !== undefined && typeof retry.respectRetryAfter !== 'boolean') {
    invalid(`${name}.respectRetryAfter`, 'a boolean');
  }
}

/** Validate explicit options before user callbacks or transport side effects. */
export function validateRequestOptions(options: RequestConfig): void {
  validateMaxBodySize(options.maxBodySize);
  validateTimeout(options.timeout);
  validateTimeout(options.totalTimeout, 'totalTimeout');
  validateRetryOptions(options.retry);
  validateStatuses(options.retryOn, 'retryOn');
  if (options.retryDelay !== undefined && typeof options.retryDelay !== 'function') {
    validateDelay(options.retryDelay, 'retryDelay');
  }
  if (options.requestId !== undefined && typeof options.requestId !== 'boolean' && typeof options.requestId !== 'function') {
    invalid('requestId', 'a boolean or a function');
  }
  if (options.cache !== undefined && typeof options.cache !== 'boolean') {
    if (!options.cache || typeof options.cache !== 'object' || Array.isArray(options.cache)) {
      invalid('cache', 'a boolean or an options object');
    }
    if (options.cache.ttl !== undefined) validateDelay(options.cache.ttl, 'cache.ttl');
    if (options.cache.partition !== undefined && (typeof options.cache.partition !== 'string' || !options.cache.partition)) {
      invalid('cache.partition', 'a non-empty string');
    }
  }
}
