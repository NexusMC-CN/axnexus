import { HttpError } from '../core/errors.js';
import type { JsonParser, ResponseType } from '../core/types.js';

/** `undefined`, negative, NaN and Infinity intentionally mean unlimited. */
function assertSize(size: number, maxBodySize: number | undefined): void {
  if (maxBodySize !== undefined && maxBodySize >= 0 && size > maxBodySize) {
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

export async function readResponse(
  response: Response,
  type: ResponseType = 'json',
  maxBodySize?: number,
  parseJson: JsonParser = (text) => JSON.parse(text),
  signal?: AbortSignal,
): Promise<unknown | undefined> {
  if (type === 'response') return response;
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
