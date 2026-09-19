import { AxiosHeaders } from '../headers/headers.js';
import {
  cancelBody,
  deferResponseBodyCleanup,
  readErrorPayload,
  markResponseMethod,
  readResponse,
} from '../utils/response.js';
import { applyResponseTransforms } from './config.js';
import { combineSignals, raceWithSignal, signalReason, TIMEOUT_REASON } from './control.js';
import { responseInterceptorError, toError, HttpError } from './errors.js';
import { applyInterceptorChain, applyInterceptorErrorChain, type InterceptorManager } from './interceptors.js';
import { statusShouldThrow } from './retry.js';
import { validateStandardSchema } from './schema.js';
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
  /**
   * Called once the adapter has produced a response and before the response
   * interceptor chain runs. Response interceptors may issue nested requests
   * through the same client, so the caller uses this hook to release the rate
   * limiter's concurrency slot and avoid deadlocking a `maxConcurrent: 1`
   * client.
   */
  onAdapterSettled?: () => void;
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
    onAdapterSettled,
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
  let rawBodyResponse: Response | undefined;
  let returnedRawBody: Response | undefined;
  const keepsRawBody = (value: unknown): boolean => {
    if (!rawBodyResponse || !value || typeof value !== 'object') return false;
    const candidate = value as { data?: unknown; raw?: unknown };
    return candidate.data === rawBodyResponse || candidate.raw === rawBodyResponse;
  };
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
    // Tag the response with its request method so body handling can recognize a
    // HEAD probe, whose Content-Length describes the matching GET resource.
    markResponseMethod(rawResponse, attemptConfig.method);
    // The adapter's network work is done. Let the caller hand back the rate
    // limiter slot before any user callback below can issue a nested request.
    onAdapterSettled?.();
    const metadata = adapterOutput instanceof Response ? undefined : (adapterOutput as AdapterResult).metadata;
    const headersAt = Date.now();
    let shouldThrow: boolean;
    try {
      shouldThrow = statusShouldThrow(attemptConfig, rawResponse.status);
    } catch (cause) {
      // A local status policy that throws is a configuration/programming error,
      // not a transport failure. Classify it separately so it is not reported as
      // ERR_NETWORK and is not retried as a transient network problem.
      throw new HttpError('Status validation callback failed', {
        code: 'ERR_INVALID_STATUS_POLICY',
        status: rawResponse.status,
        config: attemptConfig,
        retryable: false,
        cause,
      });
    }
    if (shouldThrow) {
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
    if (config.responseType === 'response' && data instanceof Response) {
      rawBodyResponse = data;
    }
    // `undefined` means the response carried no payload at all (204/HEAD/empty
    // body). An explicit JSON `null` is a real value and must still be
    // validated, so it is not treated as "no data". The public client contract
    // reports an absent payload as `null` while still validating a JSON null.
    const hasPayload = data !== undefined;
    let validatedData: unknown = hasPayload ? data : null;
    if (config.schema && hasPayload) {
      try {
        validatedData = await raceWithSignal(validateStandardSchema(validatedData, config.schema), attemptConfig.signal);
      } catch (cause) {
        if (attemptConfig.signal?.aborted) throw cause;
        throw new HttpError('Response schema validation failed', {
          code: 'ERR_SCHEMA_VALIDATION',
          config: attemptConfig,
          cause,
        });
      }
    }
    let transformedData: unknown;
    try {
      transformedData = await raceWithSignal(
        applyResponseTransforms(
          validatedData,
          config.transformResponse ?? defaults.transformResponse,
          rawResponse,
          attemptConfig.signal,
        ),
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
      raw: rawBodyResponse ?? rawResponse,
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
    const interceptedResponse = await raceWithSignal(
      applyInterceptorChain(responseInterceptors, response, {
        reverse: true,
        signal: attemptConfig.signal,
      }),
      attemptConfig.signal,
    );
    if (keepsRawBody(interceptedResponse)) returnedRawBody = rawBodyResponse;
    return interceptedResponse;
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
      if ((recovered as unknown) !== normalized) {
        if (keepsRawBody(recovered)) returnedRawBody = rawBodyResponse;
        return recovered;
      }
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
    if (rawBodyResponse && !returnedRawBody) cancelBody(rawBodyResponse);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (externalSignal && controller) externalSignal.removeEventListener('abort', onAbort);
      attemptSignals.cleanup();
    };
    if (!deferResponseBodyCleanup(returnedRawBody, cleanup)) cleanup();
  }
}
