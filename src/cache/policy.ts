import type { CacheOptions, ResolvedRequestConfig } from '../core/types.js';

export interface CachePolicyInput {
  config: ResolvedRequestConfig;
  defaultCache?: boolean | CacheOptions;
  fullResponse: boolean;
  generatedRequestId?: string;
}

export interface CachePolicy {
  enabled: boolean;
  /** Network sharing and retained-result eligibility are independent. */
  share: boolean;
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
  const partition = typeof cacheSetting === 'object' ? cacheSetting.partition : undefined;
  const share = !input.fullResponse
    && config.method === 'GET'
    && !config.bypassCache
    && cacheSetting !== false && cacheSetting !== undefined
    && config.responseType !== 'response'
    && config.maxBodySize === undefined
    && !config.onDownloadProgress && !config.onUploadProgress
    && config.rateLimit === undefined
    && config.dispatcher === undefined && config.agent === undefined
    && config.body === undefined
    && (config.credentials === 'omit' || typeof partition === 'string');
  if (!share) return { enabled: false, share: false, ttl: 0 };
  const ttl = typeof cacheSetting === 'object' ? Math.max(0, Number(cacheSetting.ttl) || 0) : 0;
  return {
    enabled: ttl > 0,
    share: true,
    key: JSON.stringify([partition ?? null, cacheKey(config, input.generatedRequestId)]),
    ttl,
  };
}
