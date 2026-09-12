import type { JsonParser } from '../core/types.js';
import { combineSignals } from '../utils/signal.js';

export interface FetchJsonOptions extends RequestInit {
  cookie?: string;
  timeout?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  parseJson?: JsonParser;
}

export interface FetchJsonResult<T = unknown> {
  data: T | null;
  status: number;
  response: Response;
}

function buildHeaders(headers: HeadersInit | undefined, cookie: string | undefined): Headers {
  const result = new Headers(headers);
  if (!result.has('Accept')) result.set('Accept', 'application/json');
  if (cookie && !result.has('Cookie')) result.set('Cookie', cookie);
  return result;
}

export async function fetchJsonResult<T = unknown>(url: string | URL, options: FetchJsonOptions = {}): Promise<FetchJsonResult<T>> {
  const { cookie, timeout, timeoutMs, fetch: fetchImpl = globalThis.fetch, parseJson = (text) => JSON.parse(text), signal, headers, ...init } = options;
  const effectiveTimeout = timeoutMs ?? timeout ?? 0;
  const controller = effectiveTimeout > 0 ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), effectiveTimeout) : undefined;
  const combined = combineSignals([controller?.signal, signal ?? undefined]);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: combined.signal,
      headers: buildHeaders(headers, cookie),
    });
    if (!response.ok || response.status === 204 || response.headers.get('content-length') === '0') {
      return { data: null, status: response.status, response };
    }
    const text = await response.text();
    if (!text.trim()) return { data: null, status: response.status, response };
    return { data: await parseJson(text) as T, status: response.status, response };
  } finally {
    if (timer) clearTimeout(timer);
    combined.cleanup();
  }
}

export async function fetchJson<T = unknown>(url: string | URL, options: FetchJsonOptions = {}): Promise<T | null> {
  const result = await fetchJsonResult<T>(url, options);
  return result.data;
}
