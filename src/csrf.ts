import type { RequestConfig } from './types.js';

export interface CsrfInterceptorOptions {
  readToken: () => string | null | undefined;
  cookieName?: string;
  headerName?: string;
  methods?: readonly string[];
}

export type CsrfInterceptor = (config: RequestConfig) => RequestConfig;

export function createCsrfInterceptor(options: CsrfInterceptorOptions): CsrfInterceptor {
  const headerName = options.headerName || 'X-CSRF-Token';
  const methods = new Set((options.methods || ['POST', 'PUT', 'PATCH', 'DELETE']).map((method) => method.toUpperCase()));
  return (config) => {
    const method = String(config.method || 'GET').toUpperCase();
    if (!methods.has(method)) return config;
    const headers = new Headers(config.headers);
    if (headers.has(headerName)) return { ...config, headers };
    const token = String(options.readToken() || '').trim();
    if (token) headers.set(headerName, token);
    return { ...config, headers };
  };
}
