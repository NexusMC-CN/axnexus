import { HttpError } from '../core/errors.js';
import type { AdapterConfig, AdapterResult, HttpAdapterFactory } from './types.js';

export interface QuicResponse {
  status: number;
  statusText?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

export interface QuicTransport {
  request(config: AdapterConfig): Promise<Response | QuicResponse>;
  cancel?(config: AdapterConfig): void;
  close?(): Promise<void> | void;
}

export function createHttp3Adapter(transport?: QuicTransport): HttpAdapterFactory {
  if (!transport) throw new HttpError('HTTP/3 transport is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' });
  return async (config: AdapterConfig): Promise<AdapterResult> => {
    let result: Response | QuicResponse;
    if (config.signal?.aborted) {
      transport.cancel?.(config);
      throw new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true });
    }
    try {
      result = await new Promise<Response | QuicResponse>((resolve, reject) => {
        let settled = false;
        const cleanup = () => config.signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          transport.cancel?.(config);
          reject(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
        };
        config.signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(transport.request(config)).then((value) => {
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
    } catch (cause) {
      if (cause instanceof HttpError && cause.code === 'ERR_CANCELED') throw cause;
      throw new HttpError('HTTP/3 request failed', { code: 'ERR_NETWORK', retryable: true, cause });
    }
    if (result instanceof Response) return { response: result, metadata: { protocol: 'h3' } };
    const body = [204, 205, 304].includes(result.status) ? null : (result.body ?? null);
    return {
      response: new Response(body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      }),
      metadata: { protocol: 'h3' },
    };
  };
}
