import { validateMaxBodySize, validateTimeout } from '../core/configuration/validation.js';
import { scheduleTimer } from '../core/lifecycle/timers.js';
import { assertBrowserMethod } from '../adapters/method.js';
import { AxiosHeaders } from '../headers/headers.js';
import type { JsonParser, StandardSchema } from '../core/types.js';
import { HttpError } from '../core/errors.js';
import { validateStandardSchema, type InferSchemaOutput } from '../core/schema.js';
import { raceWithSignal } from '../core/control.js';
import type { HeaderInput } from '../headers/headers.js';
import { mergeMethodHeaders } from '../headers/methods.js';
import { combineSignals } from '../utils/signal.js';
import { cancelBody, readResponse, markResponseDecoded, markResponseMethod, awaitTransportResponse } from '../utils/response.js';

export interface FetchJsonOptions extends Omit<RequestInit, 'headers'> {
  headers?: HeaderInput;
  cookie?: string;
  timeout?: number;
  timeoutMs?: number;
  /** Throw HttpError on non-2xx status; defaults to false. */
  throwHttpErrors?: boolean;
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

function buildHeaders(headers: HeaderInput | undefined, cookie: string | undefined, method: string): Headers {
  const store = mergeMethodHeaders(undefined, method, headers);
  // Honour the `false` opt-out the client uses before falling back to defaults:
  // converting to native Headers first would erase the sentinel and let the
  // default value (or the injected cookie) resurrect a disabled header.
  if (!store.has('Accept') && !store.isDisabled('Accept')) store.set('Accept', 'application/json');
  if (cookie && !store.has('Cookie') && !store.isDisabled('Cookie')) store.set('Cookie', cookie);
  return store.toHeaders();
}

export function fetchJsonResult<const TOptions extends FetchJsonOptions & { schema: StandardSchema }>(url: string | URL, options: TOptions): Promise<FetchJsonResult<InferSchemaOutput<TOptions['schema']>>>;
export function fetchJsonResult<const TOptions extends FetchJsonOptions>(url: string | URL, options: TOptions): Promise<FetchJsonResult>;
export function fetchJsonResult<T = unknown>(url: string | URL, options?: FetchJsonOptions & { schema?: undefined }): Promise<FetchJsonResult<T>>;
export function fetchJsonResult(url: string | URL, options: FetchJsonOptions = {}): Promise<FetchJsonResult> {
  return fetchJsonResultInternal(url, options);
}

async function fetchJsonResultInternal(url: string | URL, options: FetchJsonOptions): Promise<FetchJsonResult> {
  const {
    cookie,
    timeout,
    timeoutMs,
    maxBodySize,
    throwHttpErrors = false,
    fetch: injectedFetch,
    parseJson = (text) => JSON.parse(text),
    schema,
    signal,
    headers,
    ...init
  } = options;
  const fetchImpl = injectedFetch ?? (globalThis as typeof globalThis & { fetch?: typeof globalThis.fetch }).fetch;
  validateMaxBodySize(maxBodySize);
  if (timeout !== undefined) validateTimeout(timeout, 'timeout');
  if (timeoutMs !== undefined) validateTimeout(timeoutMs, 'timeoutMs');
  const effectiveTimeout = timeoutMs ?? timeout ?? 0;
  const method = String(init.method ?? 'GET').toUpperCase();
  assertBrowserMethod(method);
  const startedAt = Date.now();
  const controller = effectiveTimeout > 0 ? new AbortController() : undefined;
  const cancelTimer = controller ? scheduleTimer(() => controller.abort(), effectiveTimeout) : undefined;
  const combined = combineSignals([controller?.signal, signal ?? undefined]);
  let receivedResponse: Response | undefined;
  try {
    if (combined.signal?.aborted) throw combined.signal.reason;
    if (typeof fetchImpl !== 'function') {
      throw new HttpError('Fetch API is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' });
    }
    const response = await awaitTransportResponse(fetchImpl(url, {
      ...init,
      signal: combined.signal,
      headers: buildHeaders(headers, cookie, method),
    }), combined.signal);
    receivedResponse = response;
    markResponseDecoded(markResponseMethod(response, method));
    if (!response.ok && throwHttpErrors) {
      const completedAt = Date.now();
      throw new HttpError(`Request failed with HTTP ${response.status}`, {
        code: 'ERR_BAD_RESPONSE',
        status: response.status,
        response: {
          data: null,
          status: response.status,
          statusText: response.statusText,
          headers: new AxiosHeaders(response.headers),
          config: { url: String(url), method, headers: buildHeaders(headers, cookie, method) },
          raw: response,
          protocol: 'unknown',
          timings: { queuedAt: startedAt, startedAt, completedAt, duration: completedAt - startedAt },
        },
      });
    }
    const bodylessStatus = response.status === 204 || response.status === 205 || response.status === 304;
    const noBody = bodylessStatus || method === 'HEAD';
    if (!response.ok || noBody) {
      // `fetchJson` discards the Response it cannot use, so this path must
      // release the body itself. An unread body holds a connection open in
      // Node/Undici and can exhaust the connection pool.
      cancelBody(response);
      return { data: null, status: response.status, response };
    }
    const payload = await readResponse(response, 'json', maxBodySize, parseJson, combined.signal);
    // `undefined` is an absent payload; an explicit JSON `null` is a value and
    // must still be validated.
    let data: unknown = payload === undefined ? null : payload;
    if (schema && payload !== undefined) {
      try {
        // A Standard Schema validator may be asynchronous and never settle.
        // Racing it against the combined signal keeps `timeoutMs`/`timeout` and
        // caller cancellation effective during validation, matching the client
        // pipeline.
        data = await raceWithSignal(
          validateStandardSchema(payload, schema),
          combined.signal,
        );
      } catch (cause) {
        // A timeout/cancellation is not a validation failure: rethrow it so the
        // caller still sees the native `AbortError` (name 'AbortError'), which
        // is what the fetch phase propagates too — it is deliberately not
        // rewritten into ETIMEDOUT / ERR_CANCELED.
        if (combined.signal?.aborted) throw cause;
        throw new HttpError('Response schema validation failed', {
          code: 'ERR_SCHEMA_VALIDATION',
          status: response.status,
          response: {
            data: null,
            status: response.status,
            statusText: response.statusText,
            headers: new AxiosHeaders(response.headers),
            config: { url: String(url), method, headers: buildHeaders(headers, cookie, method) },
            raw: response,
            protocol: 'unknown',
            timings: { queuedAt: startedAt, startedAt, completedAt: Date.now(), duration: Date.now() - startedAt },
          },
          cause,
        });
      }
    }
    return { data, status: response.status, response };
  } finally {
    if (receivedResponse) cancelBody(receivedResponse);
    cancelTimer?.();
    combined.cleanup();
  }
}

export function fetchJson<const TOptions extends FetchJsonOptions & { schema: StandardSchema }>(url: string | URL, options: TOptions): Promise<InferSchemaOutput<TOptions['schema']> | null>;
export function fetchJson<const TOptions extends FetchJsonOptions>(url: string | URL, options: TOptions): Promise<unknown>;
export function fetchJson<T = unknown>(url: string | URL, options?: FetchJsonOptions & { schema?: undefined }): Promise<T | null>;
export async function fetchJson(url: string | URL, options: FetchJsonOptions = {}): Promise<unknown> {
  const result = await fetchJsonResultInternal(url, options);
  return result.data;
}
