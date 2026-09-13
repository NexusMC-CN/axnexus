import type { CacheOptions, ResolvedRequestConfig } from './types.js';

export interface CachePolicyInput {
  config: ResolvedRequestConfig;
  defaultCache?: boolean | CacheOptions;
  fullResponse: boolean;
  generatedRequestId?: string;
  requestInterceptorCount: number;
  responseInterceptorCount: number;
}

export interface CachePolicy {
  enabled: boolean;
  key?: string;
  ttl: number;
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
    && config.body === undefined;
  if (!enabled) return { enabled: false, ttl: 0 };
  const ttl = typeof cacheSetting === 'object' ? Math.max(0, Number(cacheSetting.ttl) || 0) : 0;
  return {
    enabled: true,
    key: cacheKey(config, input.generatedRequestId),
    ttl,
  };
}
