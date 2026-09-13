import { AxiosHeaders } from '../headers/headers.js';
import { readErrorPayload, readResponse } from '../utils/response.js';
import { applyResponseTransforms } from './config.js';
import { combineSignals, raceWithSignal, signalReason, TIMEOUT_REASON } from './control.js';
import { responseInterceptorError, toError, HttpError } from './errors.js';
import { applyInterceptorChain, applyInterceptorErrorChain, type InterceptorManager } from './interceptors.js';
import { statusShouldThrow } from './retry.js';
import type { RateLimiter } from '../transfer/rate-limiter.js';
import type {
  AdapterResult,
  HttpAdapter,
  HttpClientConfig,
  HttpResponse,
  RequestConfig,
  ResolvedRequestConfig,
  ResponseType,
} from './types.js';

export interface ExecuteAttemptOptions {
  adapter: HttpAdapter;
  config: ResolvedRequestConfig;
  defaults: HttpClientConfig;
  responseInterceptors: InterceptorManager<HttpResponse<unknown>>;
  retryOn: Set<number>;
  overallSignal?: AbortSignal;
  queuedAt: number;
  timeoutMs: number;
  totalTimeoutEnabled: boolean;
  totalTimeoutTriggered: () => boolean;
  rateLimiter?: RateLimiter;
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

export async function executeAttempt(options: ExecuteAttemptOptions): Promise<HttpResponse<unknown>> {
  const {
    adapter,
    config,
    defaults,
    responseInterceptors,
    retryOn,
    overallSignal,
    queuedAt,
    timeoutMs,
    totalTimeoutEnabled,
    totalTimeoutTriggered,
    rateLimiter,
  } = options;
  const attemptSignals = combineSignals([
    overallSignal,
    config.signal,
    config.rateLimit?.signal,
  ]);
  const externalSignal = attemptSignals.signal;
  const controller = externalSignal || timeoutMs > 0 || totalTimeoutEnabled ? new AbortController() : null;
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
    ...config,
    signal: controller?.signal,
  };
  if (rateLimiter !== undefined) {
    (attemptConfig as ResolvedRequestConfig & { rateLimiter?: RateLimiter }).rateLimiter = rateLimiter;
  }
  const startedAt = Date.now();
  let responseInterceptorChainStarted = false;
  try {
    // Abort listeners do not fire when attached to an already-aborted signal.
    // Check explicitly before invoking an adapter so a replacement signal
    // cannot let an attempt start after cancellation.
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
      const payload = await readResponsePayload(rawResponse, config.maxBodySize, attemptConfig.signal);
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
      config.responseType ?? 'json',
      config.maxBodySize,
      config.parseJson,
      attemptConfig.signal,
    );
    let transformedData: unknown;
    try {
      transformedData = await raceWithSignal(
        applyResponseTransforms(data, config.transformResponse ?? defaults.transformResponse, rawResponse),
        attemptConfig.signal,
      );
    } catch (cause) {
      if (attemptConfig.signal?.aborted) throw cause;
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
      attemptConfig.signal,
    );
  } catch (error) {
    if (responseInterceptorChainStarted) {
      // `applyInterceptorChain` already traverses rejected handlers after a
      // fulfilled handler fails. Running a second chain would duplicate side
      // effects and change Promise rejection order.
      if (attemptConfig.signal?.aborted) {
        throw toError(
          error,
          attemptConfig,
          timeoutTriggered || totalTimeoutTriggered(),
          Boolean(externalSignal?.aborted),
        );
      }
      throw responseInterceptorError(error, attemptConfig);
    }
    const normalized = toError(
      error,
      attemptConfig,
      timeoutTriggered || totalTimeoutTriggered(),
      Boolean(externalSignal?.aborted),
    );
    try {
      const recovered = await raceWithSignal(
        applyInterceptorErrorChain(responseInterceptors, normalized, { reverse: true }),
        attemptConfig.signal,
      );
      if ((recovered as unknown) !== normalized) return recovered;
    } catch (rejectedError) {
      if (attemptConfig.signal?.aborted) {
        // Preserve timeout/cancellation classification when the error
        // interceptor itself is still pending as the attempt ends.
        throw toError(
          rejectedError,
          attemptConfig,
          timeoutTriggered || totalTimeoutTriggered(),
          Boolean(externalSignal?.aborted),
        );
      }
      if (rejectedError !== normalized) throw responseInterceptorError(rejectedError, attemptConfig);
    }
    if (totalTimeoutTriggered()) {
      throw new HttpError('Request timed out', {
        code: 'ETIMEDOUT',
        config: attemptConfig,
        isTimeout: true,
        retryable: false,
        cause: normalized,
      });
    }
    throw normalized;
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal && controller) externalSignal.removeEventListener('abort', onAbort);
    attemptSignals.cleanup();
  }
}
