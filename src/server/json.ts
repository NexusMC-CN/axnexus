import type { JsonParser, StandardSchema } from '../core/types.js';
import { HttpError } from '../core/errors.js';
import { validateStandardSchema } from '../core/schema.js';
import { AxiosHeaders, type HeaderInput } from '../headers/headers.js';
import { combineSignals } from '../utils/signal.js';
import { readResponse } from '../utils/response.js';

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
  const result = AxiosHeaders.from(headers).toHeaders();
  if (!result.has('Accept')) result.set('Accept', 'application/json');
  if (cookie && !result.has('Cookie')) result.set('Cookie', cookie);
  return result;
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
    if (!response.ok || response.status === 204 || response.headers.get('content-length') === '0') {
      return { data: null, status: response.status, response };
    }
    let data = await readResponse(response, 'json', maxBodySize, parseJson, combined.signal) as T | null;
    if (data !== null && schema) {
      try {
        data = await validateStandardSchema(data, schema) as T;
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
