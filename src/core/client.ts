import { GetRequestCache } from '../cache.js';
import { HttpError } from './errors.js';
import { applyInterceptorChain, createInterceptorManager } from './interceptors.js';
import { appendQuery, resolveURL } from '../query.js';
import type {
  HttpAdapter,
  HttpClient,
  HttpClientConfig,
  HttpResponse,
  RequestConfig,
  ResolvedRequestConfig,
  ResponseType,
} from './types.js';

const DEFAULT_RETRY_ON = [408, 429, 500, 502, 503, 504];
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `axnexus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isPlainBody(value: unknown): boolean {
  if (typeof value === 'string') return false;
  if (value === null || typeof value !== 'object') return true;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return false;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return false;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return false;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return false;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return false;
  return true;
}

function encodeBody(config: RequestConfig, headers: Headers): BodyInit | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(config, 'data')) return config.body;
  if (!isPlainBody(config.data)) return config.data as BodyInit;
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return JSON.stringify(config.data);
}

function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function normalizeRetryCount(value: number | undefined): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(config: ResolvedRequestConfig): string {
  const headerEntries = Array.from(config.headers.entries())
    .filter(([name]) => name !== 'x-request-id')
    .sort(([a], [b]) => a.localeCompare(b));
  return `${config.method} ${config.url} ${JSON.stringify(headerEntries)}`;
}

function responseMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
    if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 240);
  return `Request failed with HTTP ${status}`;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const raw = await response.clone().text().catch(() => '');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function parseResponse(response: Response, type: ResponseType): Promise<unknown> {
  if (type === 'response') return response;
  if (response.status === 204 || response.headers.get('content-length') === '0') return null;
  if (type === 'text') {
    const value = await response.text();
    return value.trim() ? value : null;
  }
  if (type === 'blob') return response.blob();
  if (type === 'arrayBuffer') return response.arrayBuffer();
  const raw = await response.text();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new HttpError('Response payload is not valid JSON', {
      code: 'ERR_BAD_PAYLOAD',
      cause,
    });
  }
}

function buildFetchAdapter(): HttpAdapter {
  return async (config) => fetch(config.url, {
    method: config.method,
    headers: config.headers,
    body: config.body,
    signal: config.signal,
    credentials: config.credentials,
    mode: config.mode,
    redirect: config.redirect,
    referrer: config.referrer,
    referrerPolicy: config.referrerPolicy,
    integrity: config.integrity,
    keepalive: config.keepalive,
  });
}

function createResolvedConfig(
  defaults: HttpClientConfig,
  request: RequestConfig,
  requestIdEnabled: boolean | (() => string),
): ResolvedRequestConfig {
  const method = String(request.method || 'GET').toUpperCase();
  const baseURL = request.baseURL ?? defaults.baseURL ?? '';
  const allowAbsoluteURL = request.allowAbsoluteURL ?? defaults.allowAbsoluteURL ?? true;
  const url = appendQuery(
    resolveURL(baseURL, request.url || '', allowAbsoluteURL),
    request.params,
  );
  const headers = mergeHeaders(defaults.headers, request.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (requestIdEnabled && !headers.has('X-Request-Id')) {
    headers.set('X-Request-Id', typeof requestIdEnabled === 'function' ? requestIdEnabled() : createRequestId());
  }
  const body = encodeBody(request, headers);
  return {
    ...defaults,
    ...request,
    method,
    url,
    headers,
    body,
  };
}

function toError(
  error: unknown,
  config: ResolvedRequestConfig,
  timeoutTriggered: boolean,
  canceled: boolean,
): HttpError {
  if (error instanceof HttpError) {
    if (!error.config) {
      return new HttpError(error.message, {
        code: error.code,
        config,
        status: error.status,
        response: error.response,
        isAbort: error.isAbort,
        isTimeout: error.isTimeout,
        retryable: error.retryable,
        cause: error,
      });
    }
    return error;
  }
  if (timeoutTriggered) {
    return new HttpError('Request timed out', {
      code: 'ETIMEDOUT',
      config,
      isTimeout: true,
      retryable: true,
      cause: error,
    });
  }
  if (canceled) {
    return new HttpError('Request canceled', {
      code: 'ERR_CANCELED',
      config,
      isAbort: true,
      cause: error,
    });
  }
  return new HttpError('Network request failed', {
    code: 'ERR_NETWORK',
    config,
    retryable: true,
    cause: error,
  });
}

function shouldRetry(error: HttpError, config: ResolvedRequestConfig, retryOn: Set<number>): boolean {
  if (error.isAbort) return false;
  if (!IDEMPOTENT_METHODS.has(config.method) && !config.retryUnsafeMethods) return false;
  if (error.isTimeout || error.code === 'ERR_NETWORK') return true;
  if (error.code !== 'ERR_BAD_RESPONSE' || error.status === undefined) return false;
  return retryOn.has(error.status);
}

export function createHttpClient(options: HttpClientConfig = {}): HttpClient {
  const defaults: HttpClientConfig = {
    credentials: 'include',
    requestId: true,
    ...options,
  };
  const adapter = defaults.adapter || buildFetchAdapter();
  const requestInterceptors = createInterceptorManager<RequestConfig>();
  const responseInterceptors = createInterceptorManager<HttpResponse<unknown>>();
  const cache = new GetRequestCache(createRequestId());

  const request = async <T>(input: RequestConfig): Promise<T> => {
    let resolved: ResolvedRequestConfig | undefined;
    let notified = false;
    const notifyError = (error: HttpError) => {
      if (notified) return;
      notified = true;
      try {
        defaults.onRequestError?.(error);
      } catch {
        // Observers must never replace the request error.
      }
    };
    const initialHeaders = mergeHeaders(defaults.headers, input.headers);
    const requestIdEnabled = defaults.requestId ?? true;
    const stableRequestId = requestIdEnabled
      ? (initialHeaders.get('X-Request-Id') || (typeof requestIdEnabled === 'function' ? requestIdEnabled() : createRequestId()))
      : '';
    if (stableRequestId && !initialHeaders.has('X-Request-Id')) initialHeaders.set('X-Request-Id', stableRequestId);
    try {
      const intercepted = await applyInterceptorChain(requestInterceptors, { ...input, headers: initialHeaders });
      resolved = createResolvedConfig(defaults, intercepted, false);
      if (stableRequestId && !resolved.headers.has('X-Request-Id')) resolved.headers.set('X-Request-Id', stableRequestId);
    const initialResolved = resolved;
    const maxRetries = normalizeRetryCount(initialResolved.retry ?? defaults.retry);
    const retryOn = new Set((initialResolved.retryOn ?? defaults.retryOn ?? DEFAULT_RETRY_ON).filter(Number.isFinite));
    const retryUnsafeMethods = initialResolved.retryUnsafeMethods ?? defaults.retryUnsafeMethods ?? false;
    initialResolved.retryUnsafeMethods = retryUnsafeMethods;
    const timeoutMs = normalizeTimeout(initialResolved.timeout ?? defaults.timeout);
    const retryDelay = initialResolved.retryDelay ?? defaults.retryDelay ?? 0;
    const perform = async (): Promise<T> => {
      let lastError: HttpError | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) {
          const retryInput = await applyInterceptorChain(requestInterceptors, { ...input, headers: new Headers(initialHeaders) });
          resolved = createResolvedConfig(defaults, retryInput, false);
          if (stableRequestId && !resolved.headers.has('X-Request-Id')) resolved.headers.set('X-Request-Id', stableRequestId);
        }
        const attemptResolved: ResolvedRequestConfig = resolved || initialResolved;
        const externalSignal = attemptResolved.signal;
        if (externalSignal?.aborted) {
          throw new HttpError('Request canceled', {
            code: 'ERR_CANCELED',
            config: attemptResolved,
            isAbort: true,
          });
        }
        const controller = externalSignal || timeoutMs > 0 ? new AbortController() : null;
        let timeoutTriggered = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => controller?.abort();
        if (externalSignal && controller) externalSignal.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs > 0 && controller) {
          timer = setTimeout(() => {
            timeoutTriggered = true;
            controller.abort();
          }, timeoutMs);
        }
        const attemptConfig: ResolvedRequestConfig = {
          ...attemptResolved,
          signal: controller?.signal,
        };
        try {
          const rawResponse = await adapter(attemptConfig);
          if (!rawResponse.ok) {
            const payload = await readResponsePayload(rawResponse);
            const response: HttpResponse<unknown> = {
              data: payload,
              status: rawResponse.status,
              statusText: rawResponse.statusText,
              headers: rawResponse.headers,
              config: attemptConfig,
              raw: rawResponse,
            };
            throw new HttpError(responseMessage(payload, rawResponse.status), {
              code: 'ERR_BAD_RESPONSE',
              status: rawResponse.status,
              config: attemptConfig,
              response,
              retryable: retryOn.has(rawResponse.status),
            });
          }
          const data = await parseResponse(rawResponse, attemptResolved.responseType ?? 'json');
          const response: HttpResponse<unknown> = {
            data,
            status: rawResponse.status,
            statusText: rawResponse.statusText,
            headers: rawResponse.headers,
            config: attemptConfig,
            raw: rawResponse,
          };
          const transformed = await applyInterceptorChain(responseInterceptors, response, { reverse: true });
          return transformed.data as T;
        } catch (error) {
          const normalized = toError(
            error,
            attemptConfig,
            timeoutTriggered,
            Boolean(attemptResolved.signal?.aborted),
          );
          lastError = normalized;
          if (attempt >= maxRetries || !shouldRetry(normalized, attemptConfig, retryOn)) throw normalized;
          const delay = typeof retryDelay === 'function'
            ? Math.max(0, Number(retryDelay(attempt + 1, normalized)) || 0)
            : Math.max(0, Number(retryDelay) || 0) * (attempt + 1);
          await sleep(delay);
        } finally {
          if (timer) clearTimeout(timer);
          if (externalSignal && controller) externalSignal.removeEventListener('abort', onAbort);
        }
      }
      throw lastError || new HttpError('Request failed', { code: 'ERR_NETWORK', config: initialResolved });
    };

    const cacheSetting = initialResolved.cache ?? defaults.cache;
    const cacheEnabled = initialResolved.method === 'GET'
      && !initialResolved.bypassCache
      && cacheSetting !== false
      && cacheSetting !== undefined
      && initialResolved.responseType !== 'response';
    const ttl = typeof cacheSetting === 'object' ? Math.max(0, Number(cacheSetting.ttl) || 0) : 0;
    const result = cacheEnabled ? await cache.getOrLoad(cacheKey(initialResolved), ttl, perform) : await perform();
    if (initialResolved.method !== 'GET') cache.clear();
    return result;
    } catch (error) {
      const fallbackConfig = resolved || createResolvedConfig(defaults, input, requestIdEnabled);
      const normalized = toError(error, fallbackConfig, false, Boolean(input.signal?.aborted));
      notifyError(normalized);
      throw normalized;
    }
  };

  const client: HttpClient = {
    request,
    get: (url, config = {}) => request({ ...config, url, method: 'GET' }),
    post: (url, data, config = {}) => request({ ...config, url, method: 'POST', data }),
    put: (url, data, config = {}) => request({ ...config, url, method: 'PUT', data }),
    patch: (url, data, config = {}) => request({ ...config, url, method: 'PATCH', data }),
    delete: (url, config = {}) => request({ ...config, url, method: 'DELETE' }),
    clearCache: () => cache.clear(),
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
  };
  return client;
}
