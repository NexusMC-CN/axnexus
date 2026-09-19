import { HttpError } from '../core/errors.js';
import type { JsonParser, ResponseType } from '../core/types.js';

/**
 * `undefined`, negative, NaN and Infinity intentionally mean unlimited.
 * Only a real number counts: `null`/`false`/`''` coerce to 0 and would
 * otherwise silently become a zero-byte limit that rejects every body.
 */
function normalizeMaxBodySize(maxBodySize: number | undefined): number | undefined {
  if (typeof maxBodySize !== 'number') return undefined;
  return maxBodySize;
}

/** `undefined`, negative, NaN and Infinity intentionally mean unlimited. */
function assertSize(size: number, maxBodySize: number | undefined): void {
  const limit = normalizeMaxBodySize(maxBodySize);
  if (limit !== undefined && limit >= 0 && size > limit) {
    throw new HttpError('Response body exceeds maxBodySize', { code: 'ERR_MAX_BODY_SIZE' });
  }
}

/** 204/205/304 never carry a payload. */
function isPayloadForbidden(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/**
 * A response that cannot carry a body but may still advertise the size of the
 * corresponding GET resource. `Content-Length` must not be enforced as a real
 * payload size for HEAD, and callers must not be told bytes were transferred.
 */
function hasNoBody(response: Response): boolean {
  return isPayloadForbidden(response.status);
}

/** Attach the request method so body enforcement can recognize a HEAD probe. */
const RESPONSE_METHOD = Symbol('axnexus.responseMethod');

export function markResponseMethod(response: Response, method: string | undefined): Response {
  if (!method) return response;
  try {
    Object.defineProperty(response, RESPONSE_METHOD, {
      value: method.toUpperCase(),
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Frozen or exotic Response implementations simply keep the status check.
  }
  return response;
}

function responseMethod(response: Response): string | undefined {
  const tagged = (response as Response & { [RESPONSE_METHOD]?: string })[RESPONSE_METHOD];
  if (tagged) return tagged;
  const method = (response as Response & { method?: unknown }).method;
  return typeof method === 'string' ? method.toUpperCase() : undefined;
}

/** True when the response transfers no payload (HEAD or a bodyless status). */
function carriesNoPayload(response: Response): boolean {
  if (responseMethod(response) === 'HEAD') return true;
  return hasNoBody(response);
}

function declaredSize(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null || !raw.trim()) return undefined;
  const declared = Number(raw);
  if (!Number.isFinite(declared) || declared < 0) return undefined;
  return declared;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

interface RawResponseLifecycle {
  finished: boolean;
  cleanups: Set<() => void>;
}

const RAW_RESPONSE_LIFECYCLES = new WeakMap<Response, RawResponseLifecycle>();

/**
 * Keep request cancellation and transport resources alive while a caller owns
 * a raw response body. Returns true only when cleanup was deferred.
 */
export function deferResponseBodyCleanup(response: Response | undefined, cleanup: () => void): boolean {
  if (!response) return false;
  const lifecycle = RAW_RESPONSE_LIFECYCLES.get(response);
  if (!lifecycle || lifecycle.finished) return false;
  lifecycle.cleanups.add(cleanup);
  return true;
}

function readAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The operation may already be in flight even though the caller has
    // canceled. Consume a later rejection so aborting does not create an
    // unhandled promise alongside the intentional AbortError.
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw abortReason(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { void reader.cancel(abortReason(signal)).catch(() => undefined); } catch { /* stream already failed */ }
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Stop a response body we are no longer going to read. Cancelling the stream is
 * the only way to release the underlying connection once we have decided the
 * payload will not be consumed (over-limit payloads, aborted reads, discarded
 * error responses).
 */
export function cancelBody(response: Response, reason?: unknown): void {
  try {
    const body = response.body;
    if (!body) return;
    if (typeof body.cancel === 'function' && !body.locked) {
      void Promise.resolve(body.cancel(reason)).catch(() => undefined);
      return;
    }
    // A locked stream still owns the connection: release it through a reader.
    const reader = body.getReader();
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined).then(
      () => { try { reader.releaseLock(); } catch { /* already released */ } },
      () => { try { reader.releaseLock(); } catch { /* already released */ } },
    );
  } catch {
    // Cleanup is advisory; the size/abort error is what the caller needs.
  }
}

async function readBytes(
  response: Response,
  maxBodySize?: number,
  signal?: AbortSignal,
  declared?: number,
): Promise<Uint8Array> {
  // Only enforce a declared length when the response can actually carry one.
  // A HEAD resource probe legitimately reports the size of the corresponding
  // GET representation while transferring zero bytes.
  if (!carriesNoPayload(response) && declared !== undefined) {
    try {
      assertSize(declared, maxBodySize);
    } catch (error) {
      cancelBody(response, error);
      throw error;
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await readAbortable(response.arrayBuffer(), signal));
    assertSize(bytes.byteLength, maxBodySize);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await readChunk(reader, signal);
      if (result.done) break;
      size += result.value.byteLength;
      try {
        assertSize(size, maxBodySize);
      } catch (error) {
        // Cancel the source before surfacing the error: the caller will not
        // read any further, and an open stream keeps the connection alive.
        try { void reader.cancel(error).catch(() => undefined); } catch { /* stream already failed */ }
        throw error;
      }
      chunks.push(result.value);
    }
  } catch (error) {
    // Some runtimes keep a cloned Response's cancel promise pending after a
    // buffered chunk has been read. Do not make the caller wait for cleanup.
    try { void reader.cancel(error).catch(() => undefined); } catch { /* stream already failed */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* the underlying stream may still be closing */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Apply `maxBodySize` to a response returned in raw `responseType: 'response'`
 * mode. The caller owns the body, so the limit cannot be enforced by buffering:
 * the declared `Content-Length` is rejected up front and the body stream is
 * wrapped so an oversized or chunked response still fails while it is consumed.
 * HEAD and bodyless statuses carry no payload and are left untouched.
 */
function limitRawResponse(response: Response, maxBodySize?: number, signal?: AbortSignal): Response {
  const limit = normalizeMaxBodySize(maxBodySize);
  const enforcesLimit = limit !== undefined && Number.isFinite(limit) && limit >= 0;
  if (!enforcesLimit && !signal) return response;
  if (carriesNoPayload(response)) return response;
  if (signal?.aborted) {
    const reason = abortReason(signal);
    cancelBody(response, reason);
    throw reason;
  }
  const declared = declaredSize(response);
  if (enforcesLimit && declared !== undefined && declared > limit) {
    cancelBody(response);
    throw new HttpError(`Response body exceeds maxBodySize (${declared} > ${limit})`, {
      code: 'ERR_MAX_BODY_SIZE',
    });
  }
  if (!response.body) return response;
  let seen = 0;
  const source = response.body.getReader();
  const lifecycle: RawResponseLifecycle = { finished: false, cleanups: new Set() };
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const releaseSourceLock = () => {
    try { source.releaseLock(); } catch { /* a read/cancel may still be settling */ }
  };
  const finish = () => {
    if (lifecycle.finished) return;
    lifecycle.finished = true;
    signal?.removeEventListener('abort', onAbort);
    for (const cleanup of lifecycle.cleanups) {
      try { cleanup(); } catch { /* cleanup must not replace the stream result */ }
    }
    lifecycle.cleanups.clear();
  };
  const onAbort = () => {
    if (lifecycle.finished) return;
    const reason = abortReason(signal!);
    try {
      void source.cancel(reason).catch(() => undefined).finally(releaseSourceLock);
    } catch {
      releaseSourceLock();
    }
    try { streamController?.error(reason); } catch { /* stream already closed */ }
    finish();
  };
  const limited = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const { done, value } = await source.read();
        if (lifecycle.finished) return;
        if (done) {
          controller.close();
          releaseSourceLock();
          finish();
          return;
        }
        seen += value.byteLength;
        if (enforcesLimit && seen > limit) {
          const error = new HttpError(`Response body exceeds maxBodySize (${seen} > ${limit})`, {
            code: 'ERR_MAX_BODY_SIZE',
          });
          void source.cancel(error).catch(() => undefined).finally(releaseSourceLock);
          controller.error(error);
          finish();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (!lifecycle.finished) {
          controller.error(error);
          releaseSourceLock();
          finish();
        }
      }
    },
    cancel(reason) {
      let canceled: Promise<void>;
      try {
        canceled = source.cancel(reason);
      } catch (error) {
        releaseSourceLock();
        finish();
        throw error;
      }
      finish();
      return canceled.finally(releaseSourceLock);
    },
  });
  const wrapped = new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // `new Response(...)` cannot carry `url`/`redirected`/`type` from the
  // original: those describe the fetch that produced it, and losing them
  // breaks callers that inspect the final URL or the redirect chain.
  for (const [key, value] of [['url', response.url], ['redirected', response.redirected], ['type', response.type]] as const) {
    try {
      Object.defineProperty(wrapped, key, { value, configurable: true, enumerable: true });
    } catch { /* a runtime may expose these as non-configurable getters */ }
  }
  markResponseMethod(wrapped, responseMethod(response));
  RAW_RESPONSE_LIFECYCLES.set(wrapped, lifecycle);
  return wrapped;
}

export async function readResponse(
  response: Response,
  type: ResponseType = 'json',
  maxBodySize?: number,
  parseJson: JsonParser = (text) => JSON.parse(text),
  signal?: AbortSignal,
): Promise<unknown | undefined> {
  if (type === 'response') return limitRawResponse(response, maxBodySize, signal);
  // No payload at all: 204/205/304 and HEAD. Distinct from a JSON `null` body,
  // which is a real value that schema validation must still see.
  if (carriesNoPayload(response)) return undefined;
  const bytes = await readBytes(response, maxBodySize, signal, declaredSize(response));
  if (!bytes.byteLength) return undefined;
  if (type === 'arrayBuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (type === 'blob') {
    // Re-create the Blob with the response MIME type; without it callers lose
    // the metadata used for file validation, previews and re-uploads.
    const contentType = response.headers.get('content-type');
    const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return contentType ? new Blob([source], { type: contentType }) : new Blob([source]);
  }
  const raw = new TextDecoder().decode(bytes);
  if (!raw.trim()) return undefined;
  if (type === 'text') return raw;
  try {
    return await readAbortable(Promise.resolve().then(() => parseJson(raw)), signal);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new HttpError('Response payload is not valid JSON', { code: 'ERR_BAD_PAYLOAD', cause });
  }
}

export async function readErrorPayload(response: Response, maxBodySize?: number, signal?: AbortSignal): Promise<unknown> {
  // `Response.clone()` tees the stream: cancelling the clone does not cancel
  // the underlying source, so the original response must be released too.
  const clone = response.clone();
  try {
    const text = await readResponse(clone, 'text', maxBodySize, undefined, signal) as string | null | undefined;
    cancelBody(response);
    if (typeof text !== 'string' || !text.trim()) return null;
    try { return JSON.parse(text); } catch { return text; }
  } catch (error) {
    cancelBody(clone, error);
    cancelBody(response, error);
    if (signal?.aborted) throw error;
    return null;
  }
}
