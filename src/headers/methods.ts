import { AxiosHeaders, type HeaderRewrite, type HeaderValue, type RawHeaders } from './headers.js';

export interface HeaderDefaults {
  [name: string]: HeaderValue | RawHeaders | undefined;
  common?: RawHeaders;
  get?: RawHeaders;
  post?: RawHeaders;
  put?: RawHeaders;
  patch?: RawHeaders;
  delete?: RawHeaders;
  head?: RawHeaders;
  options?: RawHeaders;
}

export function mergeMethodHeaders(
  defaults: HeaderDefaults | AxiosHeaders | Headers | undefined,
  method: string,
  request: RawHeaders | Headers | AxiosHeaders | HeadersInit | undefined,
  rewrite: HeaderRewrite = true,
): AxiosHeaders {
  const result = new AxiosHeaders();
  const source = defaults instanceof AxiosHeaders || defaults instanceof Headers
    ? new AxiosHeaders(defaults)
    : defaults;
  if (source) {
    if (source instanceof AxiosHeaders || source instanceof Headers) {
      result.set(source, rewrite);
    } else {
      if (source.common) result.set(source.common, rewrite);
      const methodHeaders = source[method.toLowerCase()];
      if (methodHeaders && typeof methodHeaders === 'object' && !Array.isArray(methodHeaders)) {
        result.set(methodHeaders as RawHeaders, rewrite);
      }
      const direct: RawHeaders = {};
      for (const [key, value] of Object.entries(source)) {
        if (!['common', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(key.toLowerCase()) && (typeof value === 'string' || Array.isArray(value) || value === null || value === false || value === undefined)) {
          direct[key] = value as HeaderValue;
        }
      }
      result.set(direct, rewrite);
    }
  }
  if (request) result.set(request, rewrite);
  return result;
}
