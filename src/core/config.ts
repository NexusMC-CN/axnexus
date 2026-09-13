import { HttpError } from './errors.js';
import { appendQuery, resolveURL } from '../utils/query.js';
import { fetchAdapter } from '../adapters/fetch.js';
import { AxiosHeaders } from '../headers/headers.js';
import { mergeMethodHeaders, type HeaderDefaults } from '../headers/methods.js';
import type { RateLimitOptions } from '../transfer/rate-limiter.js';
import { encodeBody } from '../utils/body.js';
import type {
  HttpAdapter,
  HttpClientConfig,
  RequestConfig,
  ResolvedRequestConfig,
  RetryOptions,
} from './types.js';

export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `axnexus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function mergeAxiosHeaders(defaults: unknown, request: unknown, method: string): AxiosHeaders {
  return mergeMethodHeaders(defaults as HeaderDefaults | undefined, method, request as never);
}

export function mergeRateLimitOptions(
  defaults: RateLimitOptions | undefined,
  request: RateLimitOptions | undefined,
): RateLimitOptions | undefined {
  if (defaults === undefined && request === undefined) return undefined;
  return { ...(defaults ?? {}), ...(request ?? {}) };
}

export function normalizeRetry(value: number | RetryOptions | undefined, fallback: number | RetryOptions | undefined): RetryOptions {
  const base: RetryOptions = typeof fallback === 'number'
    ? { limit: Math.max(0, Math.floor(Number(fallback) || 0)) }
    : fallback && typeof fallback === 'object'
      ? { ...fallback }
      : {};
  if (typeof value === 'number') {
    return { ...base, limit: Math.max(0, Math.floor(Number(value) || 0)) };
  }
  if (value && typeof value === 'object') {
    return {
      ...base,
      ...value,
      limit: value.limit === undefined
        ? Math.max(0, Math.floor(Number(base.limit) || 0))
        : Math.max(0, Math.floor(Number(value.limit) || 0)),
    };
  }
  return { ...base, limit: Math.max(0, Math.floor(Number(base.limit) || 0)) };
}

export function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

export async function applyRequestTransforms(
  value: unknown,
  transforms: RequestConfig['transformRequest'],
  headers: Headers,
): Promise<unknown> {
  const list = transforms ? (Array.isArray(transforms) ? transforms : [transforms]) : [];
  let current = value;
  for (const transform of list) current = await transform(current, headers);
  return current;
}

export async function applyResponseTransforms(
  value: unknown,
  transforms: RequestConfig['transformResponse'],
  response: Response,
): Promise<unknown> {
  const list = transforms ? (Array.isArray(transforms) ? transforms : [transforms]) : [];
  let current = value;
  for (const transform of list) current = await transform(current, response);
  return current;
}

export async function createResolvedConfig(
  defaults: HttpClientConfig,
  request: RequestConfig,
  requestIdEnabled: boolean | (() => string),
  applyTransforms = true,
  headersAlreadyMerged = false,
): Promise<ResolvedRequestConfig> {
  const method = String(request.method || 'GET').toUpperCase();
  const baseURL = request.baseURL ?? defaults.baseURL ?? '';
  const allowAbsoluteURL = request.allowAbsoluteURL ?? defaults.allowAbsoluteURL ?? true;
  const url = appendQuery(
    resolveURL(baseURL, request.url || '', allowAbsoluteURL),
    request.params,
  );
  // Request interceptors receive the already merged AxiosHeaders instance.
  // Keep that object authoritative so an interceptor can intentionally delete
  // a client default instead of having it restored on the next merge.
  const headerStore = headersAlreadyMerged
    ? mergeAxiosHeaders(undefined, request.headers, method)
    : mergeAxiosHeaders(defaults.headers, request.headers, method);
  if (!headerStore.has('Accept')) headerStore.set('Accept', 'application/json');
  if (requestIdEnabled && !headerStore.has('X-Request-Id')) {
    headerStore.set('X-Request-Id', typeof requestIdEnabled === 'function' ? requestIdEnabled() : createRequestId());
  }
  const contentTypeDisabled = headerStore.isDisabled('Content-Type');
  const headers = headerStore.toHeaders();
  const requestTransforms = request.transformRequest ?? defaults.transformRequest;
  let transformedData = request.data;
  if (applyTransforms && Object.prototype.hasOwnProperty.call(request, 'data')) {
    try {
      transformedData = await applyRequestTransforms(request.data, requestTransforms, headers);
    } catch (cause) {
      throw new HttpError('Request transform failed', {
        code: 'ERR_TRANSFORM_REQUEST',
        cause,
      });
    }
  }
  const stringifyJson = request.stringifyJson ?? defaults.stringifyJson ?? JSON.stringify;
  let body: BodyInit | null | undefined;
  try {
    body = encodeBody(transformedData, request.body, headers, stringifyJson, { contentTypeDisabled });
  } catch (cause) {
    throw new HttpError('Request body serialization failed', {
      code: 'ERR_TRANSFORM_REQUEST',
      cause,
    });
  }
  return {
    ...defaults,
    ...request,
    rateLimit: mergeRateLimitOptions(defaults.rateLimit, request.rateLimit),
    method,
    url,
    headers,
    body,
  };
}

export function buildFetchAdapter(): HttpAdapter {
  return fetchAdapter;
}
