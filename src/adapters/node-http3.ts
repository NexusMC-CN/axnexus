import { HttpError } from '../core/errors.js';
import type { AdapterConfig, AdapterResult, HttpAdapterFactory } from './types.js';

export interface QuicResponse {
  status: number;
  statusText?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

export interface QuicTransport {
  request(config: AdapterConfig): Response | QuicResponse | PromiseLike<Response | QuicResponse>;
  cancel?(config: AdapterConfig): void | PromiseLike<void>;
  close?(): Promise<void> | void;
}

function signalReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted', 'AbortError')
    : new Error('The operation was aborted');
}

function abortError(signal: AbortSignal): HttpError {
  const reason = signalReason(signal) as { code?: unknown; name?: unknown } | undefined;
  if (reason?.code === 'ETIMEDOUT' || reason?.name === 'TimeoutError') {
    return new HttpError('Request timed out', {
      code: 'ETIMEDOUT',
      isTimeout: true,
      retryable: true,
      cause: reason,
    });
  }
  return new HttpError('Request canceled', {
    code: 'ERR_CANCELED',
    isAbort: true,
    cause: reason,
  });
}

/** Cancellation is best effort; a transport hook must not replace the abort error. */
function cancelTransport(transport: QuicTransport, config: AdapterConfig): void {
  try {
    const result = transport.cancel?.(config);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Preserve the request's cancellation/timeout classification.
  }
}

export function createHttp3Adapter(transport?: QuicTransport): HttpAdapterFactory {
  if (!transport) throw new HttpError('HTTP/3 transport is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' });
  return async (config: AdapterConfig): Promise<AdapterResult> => {
    const signal = config.signal ?? config.rateLimit?.signal;
    const transportConfig = signal && config.signal !== signal ? { ...config, signal } : config;
    let result: Response | QuicResponse;
    if (signal?.aborted) {
      cancelTransport(transport, transportConfig);
      throw abortError(signal);
    }
    try {
      result = await new Promise<Response | QuicResponse>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          cancelTransport(transport, transportConfig);
          reject(signal ? abortError(signal) : new HttpError('Request canceled', {
            code: 'ERR_CANCELED',
            isAbort: true,
          }));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        // Close the small registration race before invoking user transport code.
        if (signal?.aborted) {
          onAbort();
          return;
        }
        let requestResult: Response | QuicResponse | PromiseLike<Response | QuicResponse>;
        try {
          requestResult = transport.request(transportConfig);
        } catch (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
          return;
        }
        Promise.resolve(requestResult).then((value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
      if (result instanceof Response) return { response: result, metadata: { protocol: 'h3' } };
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
        throw new HttpError(`Invalid HTTP/3 response status: ${String(result.status)}`, {
          code: 'ERR_NETWORK',
          retryable: true,
        });
      }
      const body = [204, 205, 304].includes(result.status) ? null : (result.body ?? null);
      return {
        response: new Response(body, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
        }),
        metadata: { protocol: 'h3' },
      };
    } catch (cause) {
      if (cause instanceof HttpError) throw cause;
      throw new HttpError('HTTP/3 request failed', { code: 'ERR_NETWORK', retryable: true, cause });
    }
  };
}
