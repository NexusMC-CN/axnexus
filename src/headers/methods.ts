import { AxiosHeaders, type HeaderInput, type HeaderRewrite, type HeaderValue, type RawHeaders } from './headers.js';

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
  connect?: RawHeaders;
  trace?: RawHeaders;
}

export function mergeMethodHeaders(
  defaults: HeaderInput | undefined,
  method: string,
  request: HeaderInput | undefined,
  rewrite: HeaderRewrite = true,
): AxiosHeaders {
  const result = new AxiosHeaders();
  const groupedNames = new Set(['common', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'connect', 'trace']);
  const isIterable = (value: unknown): value is HeaderInput => Boolean(value)
    && typeof value !== 'string'
    && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
  const applySource = (source: unknown) => {
    if (!source) return;
    // Raw header strings are a supported `HeaderInput`; parse them instead of
    // silently dropping a `'Authorization: ...'` block.
    if (typeof source === 'string') {
      result.set(source, rewrite);
      return;
    }
    if (source instanceof AxiosHeaders || (typeof Headers !== 'undefined' && source instanceof Headers) || isIterable(source)) {
      result.set(source as HeaderInput, rewrite);
      return;
    }
    if (typeof source !== 'object') return;
    const record = source as Record<string, unknown>;
    const commonKey = Object.keys(record).find((key) => key.toLowerCase() === 'common');
    const common = commonKey ? record[commonKey] : undefined;
    if (common && typeof common === 'object' && !Array.isArray(common)) result.set(common as RawHeaders, rewrite);
    const methodKey = Object.keys(record).find((key) => key.toLowerCase() === method.toLowerCase());
    const methodHeaders = methodKey ? record[methodKey] : undefined;
    if (methodHeaders && typeof methodHeaders === 'object' && !Array.isArray(methodHeaders)) {
      result.set(methodHeaders as RawHeaders, rewrite);
    }
    const direct: RawHeaders = {};
    for (const [key, value] of Object.entries(record)) {
      if (groupedNames.has(key.toLowerCase())) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        || Array.isArray(value) || value === null || value === undefined) {
        direct[key] = value as HeaderValue;
      }
    }
    result.set(direct, rewrite);
    // Replay explicit deletions last. `AxiosHeaders.set` drops undefined/null
    // entries from the temporary store above, so a request-level
    // `{ Authorization: null }` would otherwise leave the client default in
    // place and still send credentials the caller asked to remove.
    for (const [key, value] of Object.entries(record)) {
      if (groupedNames.has(key.toLowerCase())) continue;
      if (value === null || value === undefined || value === false) result.set(key, value as HeaderValue);
    }
  };
  applySource(defaults);
  applySource(request);
  return result;
}
