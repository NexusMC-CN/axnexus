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
    try {
      result = await transport.request(config);
    } catch (cause) {
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
