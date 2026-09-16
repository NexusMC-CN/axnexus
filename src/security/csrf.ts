import type { RequestConfig } from '../core/types.js';
import { AxiosHeaders } from '../headers/headers.js';

export interface CsrfInterceptorOptions {
  readToken: () => string | null | undefined;
  headerName?: string;
  methods?: readonly string[];
}

export type CsrfInterceptor = (config: RequestConfig) => RequestConfig;

/**
 * Header name a retry can use to mark a token this interceptor injected. On a
 * retry the previously injected value is replaced so a token refreshed in
 * `beforeRetry` actually reaches the wire, while a caller-supplied token is
 * still respected.
 */
const INJECTED_MARKER = 'x-csrf-token-injected';

export function createCsrfInterceptor(options: CsrfInterceptorOptions): CsrfInterceptor {
  const headerName = options.headerName || 'X-CSRF-Token';
  const methods = new Set((options.methods || ['POST', 'PUT', 'PATCH', 'DELETE']).map((method) => method.toUpperCase()));
  return (config) => {
    const method = String(config.method || 'GET').toUpperCase();
    if (!methods.has(method)) return config;
    const inputHeaders = config.headers as (HeadersInit & { toJSON?: (asStrings?: boolean) => Record<string, string> }) | undefined;
    const headers = new Headers(inputHeaders && typeof inputHeaders === 'object' && typeof inputHeaders.toJSON === 'function'
      ? inputHeaders.toJSON(true) as HeadersInit
      : inputHeaders as HeadersInit);
    // A `false` opt-out means the caller disabled this header on purpose.
    const disabled = inputHeaders instanceof AxiosHeaders
      ? inputHeaders.isDisabled(headerName)
      : headers.get(headerName) === 'false';
    if (disabled) return { ...config, headers };
    // Only an explicit caller-supplied token wins over `readToken`. A header
    // this interceptor added on the previous attempt must be refreshed, since
    // the request config is reused across retries.
    const injectedByUs = headers.has(INJECTED_MARKER);
    headers.delete(INJECTED_MARKER);
    if (headers.has(headerName) && !injectedByUs) return { ...config, headers };
    const token = String(options.readToken() || '').trim();
    if (token) {
      headers.set(headerName, token);
      headers.set(INJECTED_MARKER, '1');
    } else {
      headers.delete(headerName);
    }
    return { ...config, headers };
  };
}
