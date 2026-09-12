import type { QueryParams, QueryValue } from '../core/types.js';

function stringifyValue(value: QueryValue): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function serializeParams(params: QueryParams | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) search.append(key, stringifyValue(item));
  }
  return search.toString();
}

export function resolveURL(baseURL = '', path = '', allowAbsoluteURL = true): string {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  const target = String(path || '').trim();
  const isAbsolute = /^(?:https?:)?\/\//i.test(target);
  if (isAbsolute) {
    if (!allowAbsoluteURL) throw new TypeError('Absolute URLs are disabled for this client');
    if (/^\/\//.test(target)) return `https:${target}`;
    return target;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
    throw new TypeError(`Unsupported URL protocol in request path: ${target}`);
  }
  if (!base) return target || '/';
  if (!target) return base;
  return `${base}/${target.replace(/^\/+/, '')}`;
}

export function appendQuery(url: string, params?: QueryParams): string {
  const query = serializeParams(params);
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}
