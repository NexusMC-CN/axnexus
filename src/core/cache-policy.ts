import type { CacheOptions, ResolvedRequestConfig, RetryDelay } from './types.js';

export interface CachePolicyInput {
  config: ResolvedRequestConfig;
  defaultCache?: boolean | CacheOptions;
  fullResponse: boolean;
  generatedRequestId?: string;
  requestInterceptorCount: number;
  responseInterceptorCount: number;
  defaultRetry?: number | import('./types.js').RetryOptions;
  defaultRetryOn?: number[];
  defaultRetryDelay?: RetryDelay;
}

function retryOnMatchesDefault(value: number[] | undefined, fallback: number[] | undefined): boolean {
  if (value === undefined) return fallback === undefined;
  if (fallback === undefined) return false;
  const normalizedValue = normalizedRetryOn(value);
  const normalizedFallback = normalizedRetryOn(fallback);
  if (normalizedValue.length !== normalizedFallback.length) return false;
  return normalizedValue.every((status, index) => status === normalizedFallback[index]);
}

function retryDelayMatchesDefault(value: RetryDelay | undefined, fallback: RetryDelay | undefined): boolean {
  return value === fallback;
}

function normalizedRetryOn(value: number[] | undefined): number[] {
  return [...new Set((value ?? []).filter(Number.isFinite))].sort((a, b) => a - b);
}

function retryDelayKey(value: RetryDelay | undefined): number | string {
  if (typeof value === 'function') return 'function';
  return value ?? '';
}

export interface CachePolicy {
  enabled: boolean;
  key?: string;
  ttl: number;
}

/**
 * True when the request's retry settings add nothing beyond the client default,
 * which is what makes two callers interchangeable for in-flight deduplication.
 */
function retryConfigIsDefault(
  config: ResolvedRequestConfig,
  defaultRetry: number | import('./types.js').RetryOptions | undefined,
): boolean {
  const request = config.retry;
  if (request === undefined) return true;
  if (typeof request === 'number') {
    const fallback = typeof defaultRetry === 'number' ? defaultRetry : defaultRetry?.limit ?? 0;
    return Math.max(0, Math.floor(Number(request) || 0)) === Math.max(0, Math.floor(Number(fallback) || 0));
  }
  const fallback = typeof defaultRetry === 'object' && defaultRetry !== null ? defaultRetry : {};
  const keys = new Set([...Object.keys(request), ...Object.keys(fallback)]);
  for (const key of keys) {
    const a = (request as Record<string, unknown>)[key];
    const b = (fallback as Record<string, unknown>)[key];
    if (a !== b) return false;
  }
  return true;
}

export function cacheKey(config: ResolvedRequestConfig, generatedRequestId?: string): string {
  const headerEntries = Array.from(config.headers.entries())
    .filter(([name, value]) => !(name === 'x-request-id' && generatedRequestId !== undefined && value === generatedRequestId))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    method: config.method,
    url: config.url,
    responseType: config.responseType ?? 'json',
    credentials: config.credentials ?? '',
    mode: config.mode ?? '',
    redirect: config.redirect ?? '',
    referrer: config.referrer ?? '',
    referrerPolicy: config.referrerPolicy ?? '',
    integrity: config.integrity ?? '',
    keepalive: Boolean(config.keepalive),
    fetchCache: config.fetchCache ?? config.requestCache ?? '',
    priority: config.priority ?? '',
    window: config.window === undefined ? '' : config.window,
    retryOn: normalizedRetryOn(config.retryOn),
    retryDelay: retryDelayKey(config.retryDelay),
    headers: headerEntries,
  });
}

export function resolveCachePolicy(input: CachePolicyInput): CachePolicy {
  const { config } = input;
  const cacheSetting = config.cache ?? input.defaultCache;
  const cacheDeadline = Boolean(config.signal) || Number(config.timeout) > 0 || Number(config.totalTimeout) > 0;
  const policyCompatible = config.maxBodySize === undefined
    && !config.onDownloadProgress
    && config.rateLimit === undefined
    && !config.parseJson
    && !config.transformResponse
    && !config.validateStatus
    && config.throwHttpErrors === undefined
    // A schema is request-specific: a cached entry produced without one would
    // silently skip validation, and two different schemas would share each
    // other's transformed value. Such requests use the cache neither for
    // reading nor for writing.
    && config.schema === undefined
    // Custom Node transport objects are not stable/serializable cache keys.
    && config.dispatcher === undefined
    && config.agent === undefined;
  const enabled = !input.fullResponse
    && config.method === 'GET'
    && !config.bypassCache
    && cacheSetting !== false
    && cacheSetting !== undefined
    && config.responseType !== 'response'
    && !cacheDeadline
    && policyCompatible
    && input.responseInterceptorCount === 0
    // Request interceptors are allowed to mutate URL, headers, body, and
    // method on each retry. The key is established before execution, so
    // sharing here could store a later attempt under an earlier key.
    && input.requestInterceptorCount === 0
    // A retry policy is per-caller: joining another caller's in-flight request
    // would impose that caller's retry limit, delay and hooks on this one, so
    // requests that differ in retry behaviour must not share a load.
    && retryConfigIsDefault(config, input.defaultRetry)
    && retryOnMatchesDefault(config.retryOn, input.defaultRetryOn)
    && retryDelayMatchesDefault(config.retryDelay, input.defaultRetryDelay)
    && config.body === undefined;
  if (!enabled) return { enabled: false, ttl: 0 };
  const ttl = typeof cacheSetting === 'object' ? Math.max(0, Number(cacheSetting.ttl) || 0) : 0;
  return {
    enabled: true,
    key: cacheKey(config, input.generatedRequestId),
    ttl,
  };
}
