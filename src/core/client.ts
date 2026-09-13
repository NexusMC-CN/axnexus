import { GetRequestCache } from '../cache/get-cache.js';
import { HttpError, toError } from './errors.js';
import { applyInterceptorChain, createRequestInterceptorManager, createInterceptorManager } from './interceptors.js';
import { AxiosHeaders } from '../headers/headers.js';
import { RateLimiter } from '../transfer/rate-limiter.js';
import { combineSignals, raceWithSignal, sleep, TIMEOUT_REASON } from './control.js';
import {
  buildFetchAdapter,
  createRequestId,
  createResolvedConfig,
  mergeAxiosHeaders,
  mergeRateLimitOptions,
  normalizeRetry,
  normalizeTimeout,
} from './config.js';
import {
  calculateRetryDelay,
  DEFAULT_RETRY_ON,
  shouldRetry,
} from './retry.js';
import { resolveCachePolicy } from './cache-policy.js';
import { executeAttempt } from './attempt.js';
import type {
  HttpClient,
  HttpClientConfig,
  HttpResponse,
  RequestConfig,
  RetryContext,
  ResolvedRequestConfig,
} from './types.js';

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
        try {
          return await executeAttempt({
            adapter,
            config: attemptResolved,
            defaults,
            responseInterceptors,
            retryOn,
            overallSignal: overallSignal.signal,
            queuedAt,
            timeoutMs,
            totalTimeoutEnabled: Boolean(totalController),
            totalTimeoutTriggered: () => totalTimeoutTriggered,
            rateLimiter,
          });
        } catch (error) {
          const normalized = error instanceof HttpError
            ? error
            : toError(error, attemptResolved, totalTimeoutTriggered, Boolean(overallSignal.signal?.aborted));
          lastError = normalized;
          if (totalTimeoutTriggered) {
            throw new HttpError('Request timed out', {
              code: 'ETIMEDOUT',
              config: normalized.config ?? attemptResolved,
              isTimeout: true,
              retryable: false,
              cause: normalized,
            });
          }
          if (attempt >= maxRetries) throw normalized;
          const retryCount = attempt + 1;
          const delay = calculateRetryDelay(retry, retryDelay, retryCount, normalized);
          if (!(await raceWithSignal(
            shouldRetry(normalized, normalized.config ?? attemptResolved, retry, retryOn, retryCount, delay),
            normalized.config?.signal ?? overallSignal.signal,
          ))) throw normalized;
          const retryContext: RetryContext = { error: normalized, retryCount, delay };
          const retrySignal = normalized.config?.signal ?? overallSignal.signal;
          if (retry.beforeRetry) await raceWithSignal(retry.beforeRetry(retryContext), retrySignal);
          try {
            await sleep(delay, retrySignal);
          } catch (sleepError) {
            if (totalTimeoutTriggered) {
              throw new HttpError('Request timed out', {
                code: 'ETIMEDOUT',
                config: normalized.config ?? attemptResolved,
                isTimeout: true,
                retryable: false,
                cause: sleepError,
              });
            }
            throw sleepError;
          }
        }
      }
      throw lastError || new HttpError('Request failed', { code: 'ERR_NETWORK', config: initialResolved });
    };

    const cachePolicy = resolveCachePolicy({
      config: initialResolved,
      defaultCache: defaults.cache,
      fullResponse,
      generatedRequestId: generatedRequestIdForCache,
      requestInterceptorCount: requestInterceptors.getHandlers().length,
      responseInterceptorCount: responseInterceptors.getHandlers().length,
    });
    const runScheduled = () => rateLimiter.run(perform, {
      ...(initialResolved.rateLimit ?? {}),
      signal: overallSignal.signal,
    });
    try {
      const result = cachePolicy.enabled
        ? await cache.getOrLoad(cachePolicy.key!, cachePolicy.ttl, async () => (await runScheduled()).data)
        : await runScheduled();
      if (initialResolved.method !== 'GET') cache.clear();
      if (fullResponse) return result as HttpResponse<T>;
      return cachePolicy.enabled ? result as T : (result as HttpResponse<T>).data;
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
