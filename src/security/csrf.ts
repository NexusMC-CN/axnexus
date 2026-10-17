import type { RequestConfig } from '../core/types.js';
import { AxiosHeaders } from '../headers/headers.js';
import { isTrustedCsrfTarget } from './origin.js';
import { getCsrfToken, setCsrfPolicy } from './csrf-policy.js';
export { finalizeCsrfConfig } from './csrf-policy.js';

export interface CsrfInterceptorOptions {
  readToken: () => string | null | undefined;
  headerName?: string;
  methods?: readonly string[];
  /** Additional trusted HTTP(S) origins, beyond the browser and baseURL origins. */
  allowedOrigins?: readonly string[];
}

export type CsrfInterceptor = (config: RequestConfig) => RequestConfig;

export function createCsrfInterceptor(options: CsrfInterceptorOptions): CsrfInterceptor {
  const headerName = options.headerName || 'X-CSRF-Token';
  const methods = new Set((options.methods || ['POST', 'PUT', 'PATCH', 'DELETE']).map((method) => method.toUpperCase()));
  // Enumerable symbols survive config spreads across retries but never become
  // wire headers or JSON fields. Each interceptor owns its own provenance.
  const injectedToken = Symbol('csrfInjectedToken');
  return (config) => {
    const headers = new AxiosHeaders(config.headers);
    const previousToken = getCsrfToken(config, injectedToken);
    const injectedByUs = previousToken !== undefined && headers.get(headerName) === previousToken;
    const next: RequestConfig = { ...config, headers };
    setCsrfPolicy(next, injectedToken);
    if (headers.isDisabled(headerName)) return next;
    if (injectedByUs) headers.delete(headerName);
    // An explicit caller header is the caller's responsibility and is retained.
    if (headers.has(headerName)) return next;
    const method = String(config.method || 'GET').toUpperCase();
    if (!methods.has(method) || !isTrustedCsrfTarget(config, options.allowedOrigins ?? [])) return next;
    const token = String(options.readToken() || '').trim();
    if (token) {
      headers.set(headerName, token);
      const baseURL = config.baseURL;
      const allowedOrigins = [...(options.allowedOrigins ?? [])];
      setCsrfPolicy(next, injectedToken, {
        headerName,
        token,
        trusted: (resolved) => methods.has(resolved.method.toUpperCase())
          && isTrustedCsrfTarget({ ...resolved, baseURL }, allowedOrigins, resolved.url),
      });
    }
    return next;
  };
}
