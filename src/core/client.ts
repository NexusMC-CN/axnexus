import { GetRequestCache } from '../cache/get-cache.js';
import { HttpError } from './errors.js';
import { applyInterceptorChain, applyInterceptorErrorChain, createRequestInterceptorManager, createInterceptorManager } from './interceptors.js';
import { appendQuery, resolveURL } from '../utils/query.js';
import { fetchAdapter } from '../adapters/fetch.js';
import { readErrorPayload, readResponse } from '../utils/response.js';
import { AxiosHeaders } from '../headers/headers.js';
import { mergeMethodHeaders, type HeaderDefaults } from '../headers/methods.js';
import { RateLimiter } from '../transfer/rate-limiter.js';
import type { RateLimitOptions } from '../transfer/rate-limiter.js';
import { encodeBody } from '../utils/body.js';
import { combineSignals } from '../utils/signal.js';
import type {
  AdapterResult,
  HttpAdapter,
  HttpClient,
  HttpClientConfig,
  HttpResponse,
  RequestConfig,
  RetryDelay,
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

function mergeAxiosHeaders(defaults: unknown, request: unknown, method: string): AxiosHeaders {
  return mergeMethodHeaders(defaults as HeaderDefaults | undefined, method, request as never);
}

function mergeRateLimitOptions(
  defaults: RateLimitOptions | undefined,
  request: RateLimitOptions | undefined,
): RateLimitOptions | undefined {
  if (defaults === undefined && request === undefined) return undefined;
  return { ...(defaults ?? {}), ...(request ?? {}) };
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

const TIMEOUT_REASON = Object.freeze({ code: 'ETIMEDOUT', name: 'TimeoutError' });

function signalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/** Race user/adapter work against a request signal without leaving listeners behind. */
function raceWithSignal<T>(value: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) {
    // The caller no longer needs the value, but the adapter/interceptor
    // promise still needs a rejection observer. Without this branch an
    // already-aborted combined signal can leave the original rejection
    // unhandled after the raced promise has settled.
    pending.catch(() => undefined);
    return Promise.reject(signalReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signalReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
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
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
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

function cacheKey(config: ResolvedRequestConfig, generatedRequestId?: string): string {
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

function toError(
  error: unknown,
  config: ResolvedRequestConfig,
  timeoutTriggered: boolean,
  canceled: boolean,
): HttpError {
  // The controller that timed out/canceled the attempt is authoritative even
  // when a custom adapter reports a generic HttpError of its own.
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
  return new HttpError('Network request failed', {
    code: 'ERR_NETWORK',
    config,
    retryable: true,
    cause: error,
  });
}

function responseInterceptorError(error: unknown, config: ResolvedRequestConfig): HttpError {
  if (error instanceof HttpError) {
    return new HttpError(error.message, {
      code: error.code,
      status: error.status,
      config: error.config ?? config,
      response: error.response,
      isAbort: error.isAbort,
      isTimeout: error.isTimeout,
      retryable: false,
      cause: error,
    });
  }
  return new HttpError(error instanceof Error ? error.message : 'Response interceptor failed', {
    code: 'ERR_NETWORK',
    config,
    retryable: false,
    cause: error,
  });
}

function isReadableStreamBody(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof ReadableStream === 'function' && value instanceof ReadableStream) return true;
  return typeof (value as { getReader?: unknown }).getReader === 'function';
}

async function shouldRetry(
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

function calculateRetryDelay(
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

export function createHttpClient(options: HttpClientConfig = {}): HttpClient {
  const defaults: HttpClientConfig = {
    credentials: 'include',
    requestId: true,
    ...options,
  };
  const adapter = defaults.adapter || buildFetchAdapter();
  const requestInterceptors = createRequestInterceptorManager();
  const responseInterceptors = createInterceptorManager<HttpResponse<unknown>>();
  const cache = new GetRequestCache(createRequestId());
  const rateLimiter = new RateLimiter(defaults.rateLimit ?? {});

  const requestInternal = async <T>(input: RequestConfig, fullResponse: boolean): Promise<T | HttpResponse<T>> => {
    let resolved: ResolvedRequestConfig | undefined;
    let interceptedConfig: RequestConfig | undefined;
    const requestIdEnabled = defaults.requestId ?? true;
    let stableRequestId = '';
    let generatedRequestIdForCache: string | undefined;
    let notified = false;
    // Setup hooks run before the per-attempt controller exists. Keep a
    // cancellation race around that phase so a caller can stop a pending
    // interceptor or request transform as well as an adapter attempt.
    const setupRateLimit = mergeRateLimitOptions(defaults.rateLimit, input.rateLimit);
    const setupSignals = combineSignals([
      defaults.signal,
      input.signal,
      setupRateLimit?.signal,
    ]);
    const notifyError = (error: HttpError) => {
      if (notified) return;
      notified = true;
      try {
        defaults.onRequestError?.(error);
      } catch {
        // Observers must never replace the request error.
      }
    };
    try {
      const initialMethod = String(input.method || 'GET').toUpperCase();
      const initialHeaders = mergeAxiosHeaders(defaults.headers, input.headers, initialMethod);
      const initialRequestIdPresent = initialHeaders.has('X-Request-Id');
      const fallbackRequestId = requestIdEnabled && !initialRequestIdPresent
        ? (typeof requestIdEnabled === 'function' ? requestIdEnabled() : createRequestId())
        : '';
      const fallbackWasGenerated = Boolean(requestIdEnabled && !initialRequestIdPresent && fallbackRequestId);
      if (fallbackRequestId) initialHeaders.set('X-Request-Id', fallbackRequestId);
      interceptedConfig = await raceWithSignal(
        applyInterceptorChain(requestInterceptors, { ...input, headers: initialHeaders }),
        setupSignals.signal,
      );
      // Normalize interceptor output through the same method-aware merge path.
      // A plain object can contain differently-cased copies of the same header;
      // constructing a native Headers object would concatenate those values.
      const interceptedMethod = String(interceptedConfig.method || initialMethod).toUpperCase();
      const interceptedHeaders = AxiosHeaders.from(interceptedConfig.headers);
      const interceptedRequestIdPresent = interceptedHeaders.has('X-Request-Id');
      const interceptedRequestIdDisabled = interceptedHeaders.isDisabled('X-Request-Id');
      const interceptedRequestId = interceptedHeaders.get('X-Request-Id');
      // An interceptor may intentionally delete the generated id or set the
      // false sentinel. Respect that opt-out instead of restoring it below.
      stableRequestId = interceptedRequestIdDisabled || !interceptedRequestIdPresent
        ? ''
        : (interceptedRequestId ?? fallbackRequestId);
      generatedRequestIdForCache = fallbackWasGenerated && stableRequestId === fallbackRequestId ? fallbackRequestId : undefined;
      const resolvedSetupSignals = combineSignals([
        setupSignals.signal,
        defaults.signal,
        interceptedConfig.signal,
        mergeRateLimitOptions(defaults.rateLimit, interceptedConfig.rateLimit)?.signal,
      ]);
      try {
        resolved = await raceWithSignal(
          createResolvedConfig(defaults, interceptedConfig, false, true, true),
          resolvedSetupSignals.signal,
        );
      } finally {
        resolvedSetupSignals.cleanup();
      }
      if (stableRequestId) resolved.headers.set('X-Request-Id', stableRequestId);
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
      const overallSignal = combineSignals([
        initialResolved.signal,
        initialResolved.rateLimit?.signal,
        totalController?.signal,
      ]);
      let totalTimeoutTriggered = false;
      const totalTimer = totalController
        ? setTimeout(() => {
          totalTimeoutTriggered = true;
          totalController.abort(TIMEOUT_REASON);
        }, totalTimeoutMs)
        : undefined;
    const perform = async (): Promise<HttpResponse<unknown>> => {
      let lastError: HttpError | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) {
          const retrySignals = combineSignals([
            overallSignal.signal,
            interceptedConfig?.signal,
            interceptedConfig?.rateLimit?.signal,
          ]);
          try {
            const retryInput = await raceWithSignal(applyInterceptorChain(requestInterceptors, {
              ...interceptedConfig!,
              headers: AxiosHeaders.from(interceptedConfig!.headers),
            }), retrySignals.signal);
            interceptedConfig = retryInput;
            const retryConfigSignals = combineSignals([
              retrySignals.signal,
              defaults.signal,
              retryInput.signal,
              mergeRateLimitOptions(defaults.rateLimit, retryInput.rateLimit)?.signal,
            ]);
            try {
              resolved = await raceWithSignal(
                createResolvedConfig(defaults, retryInput, false, true, true),
                retryConfigSignals.signal,
              );
            } finally {
              retryConfigSignals.cleanup();
            }
          } catch (error) {
            if (retrySignals.signal?.aborted && !overallSignal.signal?.aborted) {
              throw new HttpError('Request canceled', {
                code: 'ERR_CANCELED',
                config: resolved ?? initialResolved,
                isAbort: true,
                cause: error,
              });
            }
            throw error;
          } finally {
            retrySignals.cleanup();
          }
          if (stableRequestId) resolved.headers.set('X-Request-Id', stableRequestId);
        }
        const attemptResolved: ResolvedRequestConfig = resolved || initialResolved;
        // Preserve initial cancellation and total timeout signals, while also
        // honoring a signal that a request interceptor supplies on a retry.
        const attemptSignals = combineSignals([
          overallSignal.signal,
          attemptResolved.signal,
          attemptResolved.rateLimit?.signal,
        ]);
        const externalSignal = attemptSignals.signal;
        const controller = externalSignal || timeoutMs > 0 || totalController ? new AbortController() : null;
        let timeoutTriggered = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => controller?.abort(externalSignal?.reason);
        if (externalSignal && controller) externalSignal.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs > 0 && controller) {
          timer = setTimeout(() => {
            timeoutTriggered = true;
            controller.abort(TIMEOUT_REASON);
          }, timeoutMs);
        }
        const attemptConfig: ResolvedRequestConfig = {
          ...attemptResolved,
          signal: controller?.signal,
        };
        (attemptConfig as ResolvedRequestConfig & { rateLimiter?: RateLimiter }).rateLimiter = rateLimiter;
        const startedAt = Date.now();
        let responseInterceptorChainStarted = false;
        try {
          // Abort listeners do not fire when attached to an already-aborted
          // signal. Check explicitly before invoking an adapter so a signal
          // swapped in by a retry interceptor cannot let the attempt start.
          if (externalSignal?.aborted) {
            const reason = signalReason(externalSignal);
            controller?.abort(reason);
            throw reason;
          }
          const adapterOutput = await raceWithSignal(adapter(attemptConfig), attemptConfig.signal);
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
          responseInterceptorChainStarted = true;
          return await raceWithSignal(
            applyInterceptorChain(responseInterceptors, response, { reverse: true }),
            externalSignal,
          );
        } catch (error) {
          if (responseInterceptorChainStarted) {
            // `applyInterceptorChain` already traverses rejected handlers after
            // a fulfilled handler fails. Running a second chain would duplicate
            // side effects and make recovery order differ from Promise semantics.
            if (attemptConfig.signal?.aborted) {
              throw toError(
                error,
                attemptConfig,
                timeoutTriggered || totalTimeoutTriggered,
                Boolean(externalSignal?.aborted),
              );
            }
            throw responseInterceptorError(error, attemptConfig);
          }
          const normalized = toError(
            error,
            attemptConfig,
            timeoutTriggered || totalTimeoutTriggered,
            Boolean(externalSignal?.aborted),
          );
          try {
            const recovered = await raceWithSignal(
              applyInterceptorErrorChain(responseInterceptors, normalized, { reverse: true }),
              externalSignal,
            );
            if ((recovered as unknown) !== normalized) return recovered;
          } catch (rejectedError) {
            // If cancellation won the race while the rejected handlers were
            // being dispatched, keep the normalized cancellation instead of
            // reporting the signal's DOMException as an interceptor failure.
            if (rejectedError !== normalized && !attemptConfig.signal?.aborted) {
              throw responseInterceptorError(rejectedError, attemptConfig);
            }
          }
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
          if (attempt >= maxRetries) throw normalized;
          const retryCount = attempt + 1;
          const delay = calculateRetryDelay(retry, retryDelay, retryCount, normalized);
          if (!(await raceWithSignal(
            shouldRetry(normalized, attemptConfig, retry, retryOn, retryCount, delay),
            externalSignal,
          ))) throw normalized;
          const retryContext: RetryContext = { error: normalized, retryCount, delay };
          if (retry.beforeRetry) await raceWithSignal(retry.beforeRetry(retryContext), externalSignal);
          try {
            await sleep(delay, externalSignal);
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
          attemptSignals.cleanup();
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
      && initialResolved.throwHttpErrors === undefined
      // Custom Node transport objects are not stable/serializable cache keys.
      && initialResolved.dispatcher === undefined
      && initialResolved.agent === undefined;
    const cacheEnabled = !fullResponse && initialResolved.method === 'GET'
      && !initialResolved.bypassCache
      && cacheSetting !== false
      && cacheSetting !== undefined
      && initialResolved.responseType !== 'response'
      && !cacheDeadline
      && cachePolicyCompatible
      && responseInterceptors.getHandlers().length === 0
      // Request interceptors are allowed to mutate URL, headers, body, and
      // method on each retry. The key is established before `perform`, so
      // sharing here could store a later attempt under an earlier key.
      && requestInterceptors.getHandlers().length === 0
      && initialResolved.body === undefined;
    const ttl = typeof cacheSetting === 'object' ? Math.max(0, Number(cacheSetting.ttl) || 0) : 0;
    const runScheduled = () => rateLimiter.run(perform, {
      ...(initialResolved.rateLimit ?? {}),
      signal: overallSignal.signal,
    });
    try {
      const result = cacheEnabled
        ? await cache.getOrLoad(cacheKey(initialResolved, generatedRequestIdForCache), ttl, async () => (await runScheduled()).data)
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
        if (overallSignal.signal?.aborted) {
          throw new HttpError('Request canceled', {
            code: 'ERR_CANCELED',
            config: resolved,
            isAbort: true,
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
          // Setup already failed; rebuilding a fallback must not invoke a
          // stateful requestId factory (or any request transform) a second time.
          fallbackConfig = await createResolvedConfig(defaults, input, false, false);
        } catch {
          fallbackConfig = {
            ...defaults,
            ...input,
            method: String(input.method || 'GET').toUpperCase(),
            url: input.url || '',
            headers: new Headers(),
            body: input.body,
          };
        }
      }
      const setupCanceled = Boolean(
        setupSignals.signal?.aborted
        || defaults.signal?.aborted
        || input.signal?.aborted
        || interceptedConfig?.signal?.aborted
        || interceptedConfig?.rateLimit?.signal?.aborted
        || setupRateLimit?.signal?.aborted,
      );
      const normalized = toError(error, fallbackConfig, false, setupCanceled);
      notifyError(normalized);
      throw normalized;
    } finally {
      setupSignals.cleanup();
    }
  };

  const normalizePublicConfig = (input: RequestConfig | string, config?: RequestConfig): RequestConfig =>
    typeof input === 'string' ? { ...(config ?? {}), url: input } : input;
  const request = <T>(input: RequestConfig | string, config?: RequestConfig): Promise<T> =>
    requestInternal<T>(normalizePublicConfig(input, config), false) as Promise<T>;
  const requestResponse = <T>(input: RequestConfig | string, config?: RequestConfig): Promise<HttpResponse<T>> =>
    requestInternal<T>(normalizePublicConfig(input, config), true) as Promise<HttpResponse<T>>;

  const client: HttpClient = {
    request,
    requestResponse,
    get: (url, config = {}) => request({ ...config, url, method: 'GET' }),
    getResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'GET' }),
    head: (url, config = {}) => request({ ...config, url, method: 'HEAD' }),
    headResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'HEAD' }),
    options: (url, config = {}) => request({ ...config, url, method: 'OPTIONS' }),
    optionsResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'OPTIONS' }),
    trace: (url, config = {}) => request({ ...config, url, method: 'TRACE' }),
    traceResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'TRACE' }),
    connect: (url, config = {}) => request({ ...config, url, method: 'CONNECT' }),
    connectResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'CONNECT' }),
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
