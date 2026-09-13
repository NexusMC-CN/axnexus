import type { JsonParser } from '../core/types.js';
import { HttpError } from '../core/errors.js';
import { combineSignals } from '../utils/signal.js';
import { readResponse } from '../utils/response.js';

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
  const { cookie, timeout, timeoutMs, fetch: injectedFetch, parseJson = (text) => JSON.parse(text), signal, headers, ...init } = options;
  const fetchImpl = injectedFetch ?? (globalThis as typeof globalThis & { fetch?: typeof globalThis.fetch }).fetch;
  const effectiveTimeout = timeoutMs ?? timeout ?? 0;
  const controller = effectiveTimeout > 0 ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), effectiveTimeout) : undefined;
  const combined = combineSignals([controller?.signal, signal ?? undefined]);
  try {
    if (typeof fetchImpl !== 'function') {
      throw new HttpError('Fetch API is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' });
    }
    const response = await fetchImpl(url, {
      ...init,
      signal: combined.signal,
      headers: buildHeaders(headers, cookie),
    });
    if (!response.ok || response.status === 204 || response.headers.get('content-length') === '0') {
      return { data: null, status: response.status, response };
    }
    // Response.text() does not consistently honor a signal once headers arrived.
    // The shared reader races each chunk against the combined deadline instead.
    const text = await readResponse(response, 'text', undefined, undefined, combined.signal) as string | null;
    if (!text?.trim()) return { data: null, status: response.status, response };
    try {
      return { data: await parseJson(text) as T, status: response.status, response };
    } catch (cause) {
      throw new HttpError('Response payload is not valid JSON', { code: 'ERR_BAD_PAYLOAD', cause });
    }
  } finally {
    if (timer) clearTimeout(timer);
    combined.cleanup();
  }
}

export async function fetchJson<T = unknown>(url: string | URL, options: FetchJsonOptions = {}): Promise<T | null> {
  const result = await fetchJsonResult<T>(url, options);
  return result.data;
}
