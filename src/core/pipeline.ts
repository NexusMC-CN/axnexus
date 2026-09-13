import { GetRequestCache } from '../cache/get-cache.js';
import { AxiosHeaders } from '../headers/headers.js';
import { RateLimiter } from '../transfer/rate-limiter.js';
import { applyInterceptorChain, type InterceptorManager, type RequestInterceptorManager } from './interceptors.js';
import { executeAttempt } from './attempt.js';
import { resolveCachePolicy } from './cache-policy.js';
import {
  createRequestId,
  createResolvedConfig,
  mergeAxiosHeaders,
  mergeRateLimitOptions,
  normalizeRetry,
  normalizeTimeout,
} from './config.js';
import { combineSignals, raceWithSignal, sleep, TIMEOUT_REASON } from './control.js';
import { HttpError, toError } from './errors.js';
import {
  calculateRetryDelay,
  DEFAULT_RETRY_ON,
  shouldRetry,
} from './retry.js';
import type {
  HttpAdapter,
  HttpClientConfig,
  HttpResponse,
  RequestConfig,
  RetryContext,
  ResolvedRequestConfig,
} from './types.js';

export interface RequestPipelineDeps {
  defaults: HttpClientConfig;
  adapter: HttpAdapter;
  requestInterceptors: RequestInterceptorManager;
  responseInterceptors: InterceptorManager<HttpResponse<unknown>>;
  cache: GetRequestCache;
  rateLimiter: RateLimiter;
}

export async function runRequestPipeline<T>(
  input: RequestConfig,
  fullResponse: boolean,
  deps: RequestPipelineDeps,
): Promise<T | HttpResponse<T>> {
  const {
    defaults,
    adapter,
    requestInterceptors,
    responseInterceptors,
    cache,
    rateLimiter,
  } = deps;
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
        // Keep this runtime signal alive through retry policy hooks and the
        // delay. `executeAttempt` owns a shorter-lived controller and cleans
        // its listeners as soon as the attempt settles; the pipeline still
        // needs the caller/interceptor signal to cancel an in-between wait.
        const attemptSignals = combineSignals([
          overallSignal.signal,
          attemptResolved.signal,
          attemptResolved.rateLimit?.signal,
        ]);
        try {
          try {
            return await executeAttempt({
              adapter,
              config: attemptResolved,
              defaults,
              responseInterceptors,
              retryOn,
              overallSignal: attemptSignals.signal,
              queuedAt,
              timeoutMs,
              totalTimeoutEnabled: Boolean(totalController),
              totalTimeoutTriggered: () => totalTimeoutTriggered,
              rateLimiter,
            });
          } catch (error) {
            const normalized = error instanceof HttpError
              ? error
              : toError(error, attemptResolved, totalTimeoutTriggered, Boolean(attemptSignals.signal?.aborted));
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
              attemptSignals.signal,
            ))) throw normalized;
            const retryContext: RetryContext = { error: normalized, retryCount, delay };
            if (retry.beforeRetry) await raceWithSignal(retry.beforeRetry(retryContext), attemptSignals.signal);
            try {
              await sleep(delay, attemptSignals.signal);
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
        } finally {
          attemptSignals.cleanup();
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
}
