import { GetRequestCache } from '../cache/get-cache.js';
import { HttpError } from './errors.js';
import { applyInterceptorChain, createInterceptorManager } from './interceptors.js';
import { appendQuery, resolveURL } from '../utils/query.js';
import { fetchAdapter } from '../adapters/fetch.js';
import { readErrorPayload, readResponse } from '../utils/response.js';
import { AxiosHeaders } from '../headers/headers.js';
import { mergeMethodHeaders, type HeaderDefaults } from '../headers/methods.js';
import { RateLimiter } from '../transfer/rate-limiter.js';
import { encodeBody } from '../utils/body.js';
import { combineSignals } from '../utils/signal.js';
import type {
  AdapterResult,
  HttpAdapter,
  HttpClient,
  HttpClientConfig,
  HttpResponse,
  RequestConfig,
  RetryContext,
  RetryOptions,
  ResolvedRequestConfig,
  ResponseType,
  ResponseTimings,
} from './types.js';

const DEFAULT_RETRY_ON = [408, 429, 500, 502, 503, 504];
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `axnexus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function mergeHeaders(defaults: unknown, request: unknown, method: string): Headers {
  const merged = mergeMethodHeaders(defaults as HeaderDefaults | undefined, method, request as never);
  return new Headers(merged.toJSON(true) as HeadersInit);
}

function normalizeRetry(value: number | RetryOptions | undefined, fallback: number | RetryOptions | undefined): RetryOptions {
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

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

async function applyRequestTransforms(value: unknown, transforms: RequestConfig['transformRequest'], headers: Headers): Promise<unknown> {
  const list = transforms ? (Array.isArray(transforms) ? transforms : [transforms]) : [];
  let current = value;
  for (const transform of list) current = await transform(current, headers);
  return current;
}

async function applyResponseTransforms(value: unknown, transforms: RequestConfig['transformResponse'], response: Response): Promise<unknown> {
  const list = transforms ? (Array.isArray(transforms) ? transforms : [transforms]) : [];
  let current = value;
  for (const transform of list) current = await transform(current, response);
  return current;
}

function cacheKey(config: ResolvedRequestConfig): string {
  const headerEntries = Array.from(config.headers.entries())
    .filter(([name]) => name !== 'x-request-id')
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
    headers: headerEntries,
  });
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

function retryAfterMs(response: HttpResponse<unknown> | undefined): number | undefined {
  const raw = response?.headers.get('retry-after');
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function statusShouldThrow(config: ResolvedRequestConfig, status: number): boolean {
  if (typeof config.validateStatus === 'function') return !config.validateStatus(status);
  const policy = config.throwHttpErrors;
  if (typeof policy === 'function') return policy(status);
  if (policy === false) return false;
  return !(status >= 200 && status < 300);
}

async function readResponsePayload(response: Response, maxBodySize?: number, signal?: AbortSignal): Promise<unknown> {
  return readErrorPayload(response, maxBodySize, signal);
}

async function parseResponse(
  response: Response,
  type: ResponseType,
  maxBodySize: number | undefined,
  parseJson: RequestConfig['parseJson'],
  signal?: AbortSignal,
): Promise<unknown> {
  return readResponse(response, type, maxBodySize, parseJson, signal);
}

function buildFetchAdapter(): HttpAdapter {
  return fetchAdapter;
}

async function createResolvedConfig(
  defaults: HttpClientConfig,
  request: RequestConfig,
  requestIdEnabled: boolean | (() => string),
  applyTransforms = true,
): Promise<ResolvedRequestConfig> {
  const method = String(request.method || 'GET').toUpperCase();
  const baseURL = request.baseURL ?? defaults.baseURL ?? '';
  const allowAbsoluteURL = request.allowAbsoluteURL ?? defaults.allowAbsoluteURL ?? true;
  const url = appendQuery(
    resolveURL(baseURL, request.url || '', allowAbsoluteURL),
    request.params,
  );
  const headers = mergeHeaders(defaults.headers, request.headers, method);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (requestIdEnabled && !headers.has('X-Request-Id')) {
    headers.set('X-Request-Id', typeof requestIdEnabled === 'function' ? requestIdEnabled() : createRequestId());
  }
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
    body = encodeBody(transformedData, request.body, headers, stringifyJson);
  } catch (cause) {
    throw new HttpError('Request body serialization failed', {
      code: 'ERR_TRANSFORM_REQUEST',
      cause,
    });
  }
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

async function shouldRetry(
  error: HttpError,
  config: ResolvedRequestConfig,
  retry: RetryOptions,
  retryOn: Set<number>,
  retryCount: number,
): Promise<boolean> {
  if (error.isAbort) return false;
  if (typeof retry.shouldRetry === 'function') {
    return retry.shouldRetry({ error, retryCount, delay: 0 });
  }
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
  const rateLimiter = new RateLimiter(defaults.rateLimit ?? {});

  const requestInternal = async <T>(input: RequestConfig, fullResponse: boolean): Promise<T | HttpResponse<T>> => {
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
    const initialMethod = String(input.method || 'GET').toUpperCase();
    const initialHeaders = mergeHeaders(defaults.headers, input.headers, initialMethod);
    const requestIdEnabled = defaults.requestId ?? true;
    const stableRequestId = requestIdEnabled
      ? (initialHeaders.get('X-Request-Id') || (typeof requestIdEnabled === 'function' ? requestIdEnabled() : createRequestId()))
      : '';
    if (stableRequestId && !initialHeaders.has('X-Request-Id')) initialHeaders.set('X-Request-Id', stableRequestId);
    try {
      const intercepted = await applyInterceptorChain(requestInterceptors, { ...input, headers: initialHeaders });
      resolved = await createResolvedConfig(defaults, intercepted, false);
      if (stableRequestId && !resolved.headers.has('X-Request-Id')) resolved.headers.set('X-Request-Id', stableRequestId);
    const initialResolved = resolved;
    const retry = normalizeRetry(initialResolved.retry, defaults.retry);
    const maxRetries = retry.limit ?? 0;
    const retryOn = new Set((initialResolved.retryOn ?? defaults.retryOn ?? retry.statusCodes ?? DEFAULT_RETRY_ON).filter(Number.isFinite));
    const retryUnsafeMethods = initialResolved.retryUnsafeMethods ?? defaults.retryUnsafeMethods ?? false;
    initialResolved.retryUnsafeMethods = retryUnsafeMethods;
    const timeoutMs = normalizeTimeout(initialResolved.timeout ?? defaults.timeout);
    const retryDelay = initialResolved.retryDelay ?? defaults.retryDelay ?? retry.delay ?? 0;
    const totalTimeoutMs = normalizeTimeout(initialResolved.totalTimeout ?? defaults.totalTimeout);
    const queuedAt = Date.now();
    const totalController = totalTimeoutMs > 0 ? new AbortController() : null;
    const overallSignal = combineSignals([initialResolved.signal, totalController?.signal]);
    let totalTimeoutTriggered = false;
    const totalTimer = totalController
      ? setTimeout(() => {
        totalTimeoutTriggered = true;
        totalController.abort();
      }, totalTimeoutMs)
      : undefined;
    const perform = async (): Promise<HttpResponse<unknown>> => {
      let lastError: HttpError | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) {
          const retryInput = await applyInterceptorChain(requestInterceptors, { ...input, headers: new Headers(initialHeaders) });
          resolved = await createResolvedConfig(defaults, retryInput, false);
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
        const controller = externalSignal || timeoutMs > 0 || totalController ? new AbortController() : null;
        let timeoutTriggered = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => controller?.abort();
        const onTotalAbort = () => controller?.abort();
        if (externalSignal && controller) externalSignal.addEventListener('abort', onAbort, { once: true });
        if (totalController && controller) totalController.signal.addEventListener('abort', onTotalAbort, { once: true });
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
        (attemptConfig as ResolvedRequestConfig & { rateLimiter?: RateLimiter }).rateLimiter = rateLimiter;
        const startedAt = Date.now();
        try {
          const adapterOutput = await adapter(attemptConfig);
          const rawResponse = adapterOutput instanceof Response
            ? adapterOutput
            : (adapterOutput as AdapterResult).response;
          const metadata = adapterOutput instanceof Response ? undefined : (adapterOutput as AdapterResult).metadata;
          const headersAt = Date.now();
          if (statusShouldThrow(attemptConfig, rawResponse.status)) {
            const payload = await readResponsePayload(rawResponse, attemptResolved.maxBodySize, attemptConfig.signal);
            const response: HttpResponse<unknown> = {
              data: payload,
              status: rawResponse.status,
              statusText: rawResponse.statusText,
              headers: new AxiosHeaders(rawResponse.headers),
              config: attemptConfig,
              raw: rawResponse,
              protocol: metadata?.protocol ?? 'unknown',
              timings: {
                queuedAt,
                startedAt,
                headersAt,
                completedAt: Date.now(),
                duration: Date.now() - queuedAt,
                ...metadata?.timings,
              },
            };
            throw new HttpError(responseMessage(payload, rawResponse.status), {
              code: 'ERR_BAD_RESPONSE',
              status: rawResponse.status,
              config: attemptConfig,
              response,
              retryable: retryOn.has(rawResponse.status),
            });
          }
          const data = await parseResponse(
            rawResponse,
            attemptResolved.responseType ?? 'json',
            attemptResolved.maxBodySize,
            attemptResolved.parseJson,
            attemptConfig.signal,
          );
          let transformedData: unknown;
          try {
            transformedData = await applyResponseTransforms(data, attemptResolved.transformResponse ?? defaults.transformResponse, rawResponse);
          } catch (cause) {
            throw new HttpError('Response transform failed', {
              code: 'ERR_TRANSFORM_RESPONSE',
              config: attemptConfig,
              cause,
            });
          }
          const response: HttpResponse<unknown> = {
            data: transformedData,
            status: rawResponse.status,
            statusText: rawResponse.statusText,
            headers: new AxiosHeaders(rawResponse.headers),
            config: attemptConfig,
            raw: rawResponse,
            protocol: metadata?.protocol ?? 'unknown',
            timings: {
              queuedAt,
              startedAt,
              headersAt,
              completedAt: Date.now(),
              duration: Date.now() - queuedAt,
              downloadDuration: Date.now() - headersAt,
              ...metadata?.timings,
            },
          };
          const transformed = await applyInterceptorChain(responseInterceptors, response, { reverse: true });
          return transformed;
        } catch (error) {
          const normalized = toError(
            error,
            attemptConfig,
            timeoutTriggered || totalTimeoutTriggered,
            Boolean(attemptResolved.signal?.aborted),
          );
          lastError = normalized;
          if (totalTimeoutTriggered) {
            throw new HttpError('Request timed out', {
              code: 'ETIMEDOUT',
              config: attemptConfig,
              isTimeout: true,
              retryable: false,
              cause: normalized,
            });
          }
          if (attempt >= maxRetries || !(await shouldRetry(normalized, attemptConfig, retry, retryOn, attempt + 1))) throw normalized;
          let delay = typeof retryDelay === 'function'
            ? Math.max(0, Number(retryDelay(attempt + 1, normalized)) || 0)
            : Math.max(0, Number(retryDelay) || 0) * (attempt + 1);
          const retryAfter = retry.respectRetryAfter === false ? undefined : retryAfterMs(normalized.response);
          if (retryAfter !== undefined) delay = retryAfter;
          if (retry.maxDelay !== undefined) delay = Math.min(delay, Math.max(0, retry.maxDelay));
          if (retry.jitter) {
            delay = typeof retry.jitter === 'function'
              ? Math.max(0, Number(retry.jitter(delay, attempt + 1, normalized)) || 0)
              : Math.random() * delay;
          }
          const retryContext: RetryContext = { error: normalized, retryCount: attempt + 1, delay };
          if (retry.beforeRetry) await retry.beforeRetry(retryContext);
          try {
          await sleep(delay, overallSignal.signal);
          } catch (sleepError) {
            if (totalTimeoutTriggered) {
              throw new HttpError('Request timed out', {
                code: 'ETIMEDOUT',
                config: attemptConfig,
                isTimeout: true,
                retryable: false,
                cause: sleepError,
              });
            }
            throw sleepError;
          }
        } finally {
          if (timer) clearTimeout(timer);
          if (externalSignal && controller) externalSignal.removeEventListener('abort', onAbort);
          if (totalController && controller) totalController.signal.removeEventListener('abort', onTotalAbort);
        }
      }
      throw lastError || new HttpError('Request failed', { code: 'ERR_NETWORK', config: initialResolved });
    };

    const cacheSetting = initialResolved.cache ?? defaults.cache;
    const cacheDeadline = Boolean(initialResolved.signal) || timeoutMs > 0 || totalTimeoutMs > 0;
    const cachePolicyCompatible = initialResolved.maxBodySize === undefined
      && !initialResolved.onDownloadProgress
      && initialResolved.rateLimit === undefined
      && !initialResolved.parseJson
      && !initialResolved.transformResponse
      && !initialResolved.validateStatus
      && initialResolved.throwHttpErrors === undefined;
    const cacheEnabled = !fullResponse && initialResolved.method === 'GET'
      && !initialResolved.bypassCache
      && cacheSetting !== false
      && cacheSetting !== undefined
      && initialResolved.responseType !== 'response'
      && !cacheDeadline
      && cachePolicyCompatible;
    const ttl = typeof cacheSetting === 'object' ? Math.max(0, Number(cacheSetting.ttl) || 0) : 0;
    const runScheduled = () => rateLimiter.run(perform, {
      ...(initialResolved.rateLimit ?? {}),
      signal: overallSignal.signal,
    });
    try {
      const result = cacheEnabled
        ? await cache.getOrLoad(cacheKey(initialResolved), ttl, async () => (await runScheduled()).data)
        : await runScheduled();
      if (initialResolved.method !== 'GET') cache.clear();
      if (fullResponse) return result as HttpResponse<T>;
      return cacheEnabled ? result as T : (result as HttpResponse<T>).data;
    } catch (error) {
      if (totalTimeoutTriggered) {
        throw new HttpError('Request timed out', {
          code: 'ETIMEDOUT',
          config: resolved,
          isTimeout: true,
          retryable: false,
          cause: error,
        });
      }
      throw error;
    } finally {
      if (totalTimer) clearTimeout(totalTimer);
      overallSignal.cleanup();
    }
    } catch (error) {
      let fallbackConfig = resolved;
      if (!fallbackConfig) {
        try {
          fallbackConfig = await createResolvedConfig(defaults, input, requestIdEnabled, false);
        } catch {
          fallbackConfig = {
            ...defaults,
            ...input,
            method: String(input.method || 'GET').toUpperCase(),
            url: input.url || '',
            headers: mergeHeaders(defaults.headers, input.headers, String(input.method || 'GET').toUpperCase()),
            body: input.body,
          };
        }
      }
      const normalized = toError(error, fallbackConfig, false, Boolean(input.signal?.aborted));
      notifyError(normalized);
      throw normalized;
    }
  };

  const request = <T>(input: RequestConfig): Promise<T> => requestInternal<T>(input, false) as Promise<T>;
  const requestResponse = <T>(input: RequestConfig): Promise<HttpResponse<T>> => requestInternal<T>(input, true) as Promise<HttpResponse<T>>;

  const client: HttpClient = {
    request,
    requestResponse,
    get: (url, config = {}) => request({ ...config, url, method: 'GET' }),
    getResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'GET' }),
    post: (url, data, config = {}) => request({ ...config, url, method: 'POST', data }),
    postResponse: (url, data, config = {}) => requestResponse({ ...config, url, method: 'POST', data }),
    put: (url, data, config = {}) => request({ ...config, url, method: 'PUT', data }),
    putResponse: (url, data, config = {}) => requestResponse({ ...config, url, method: 'PUT', data }),
    patch: (url, data, config = {}) => request({ ...config, url, method: 'PATCH', data }),
    patchResponse: (url, data, config = {}) => requestResponse({ ...config, url, method: 'PATCH', data }),
    delete: (url, config = {}) => request({ ...config, url, method: 'DELETE' }),
    deleteResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'DELETE' }),
    clearCache: () => cache.clear(),
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
  };
  return client;
}
