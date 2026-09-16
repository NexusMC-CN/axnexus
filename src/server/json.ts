import type { JsonParser, StandardSchema } from '../core/types.js';
import { HttpError } from '../core/errors.js';
import { validateStandardSchema } from '../core/schema.js';
import { AxiosHeaders, type HeaderInput } from '../headers/headers.js';
import { combineSignals } from '../utils/signal.js';
import { cancelBody, readResponse } from '../utils/response.js';

export interface FetchJsonOptions extends Omit<RequestInit, 'headers'> {
  headers?: HeaderInput;
  cookie?: string;
  timeout?: number;
  timeoutMs?: number;
  /** Maximum response body size in bytes; defaults to unlimited. */
  maxBodySize?: number;
  fetch?: typeof globalThis.fetch;
  parseJson?: JsonParser;
  schema?: StandardSchema;
}

export interface FetchJsonResult<T = unknown> {
  data: T | null;
  status: number;
  response: Response;
}

function buildHeaders(headers: HeaderInput | undefined, cookie: string | undefined): Headers {
  const store = AxiosHeaders.from(headers);
  // Honour the `false` opt-out the client uses before falling back to defaults:
  // converting to native Headers first would erase the sentinel and let the
  // default value (or the injected cookie) resurrect a disabled header.
  if (!store.has('Accept') && !store.isDisabled('Accept')) store.set('Accept', 'application/json');
  if (cookie && !store.has('Cookie') && !store.isDisabled('Cookie')) store.set('Cookie', cookie);
  return store.toHeaders();
}

export async function fetchJsonResult<T = unknown>(url: string | URL, options: FetchJsonOptions = {}): Promise<FetchJsonResult<T>> {
  const {
    cookie,
    timeout,
    timeoutMs,
    maxBodySize,
    fetch: injectedFetch,
    parseJson = (text) => JSON.parse(text),
    schema,
    signal,
    headers,
    ...init
  } = options;
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
    const bodylessStatus = response.status === 204 || response.status === 205 || response.status === 304;
    const noBody = bodylessStatus
      || String(init.method ?? 'GET').toUpperCase() === 'HEAD'
      || response.headers.get('content-length') === '0';
    if (!response.ok || noBody) {
      // `fetchJson` discards the Response it cannot use, so this path must
      // release the body itself. An unread body holds a connection open in
      // Node/Undici and can exhaust the connection pool.
      cancelBody(response);
      return { data: null, status: response.status, response };
    }
    const payload = await readResponse(response, 'json', maxBodySize, parseJson, combined.signal) as T | null | undefined;
    // `undefined` is an absent payload; an explicit JSON `null` is a value and
    // must still be validated.
    let data = (payload === undefined ? null : payload) as T | null;
    if (schema && payload !== undefined) {
      try {
        data = await validateStandardSchema(payload, schema) as T;
      } catch (cause) {
        throw new HttpError('Response schema validation failed', {
          code: 'ERR_SCHEMA_VALIDATION',
          cause,
        });
      }
    }
    return { data, status: response.status, response };
  } finally {
    if (timer) clearTimeout(timer);
    combined.cleanup();
  }
}

export async function fetchJson<T = unknown>(url: string | URL, options: FetchJsonOptions = {}): Promise<T | null> {
  const result = await fetchJsonResult<T>(url, options);
  return result.data;
}
