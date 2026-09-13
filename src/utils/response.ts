import { HttpError } from '../core/errors.js';
import type { JsonParser, ResponseType } from '../core/types.js';

function assertSize(size: number, maxBodySize: number | undefined): void {
  if (maxBodySize !== undefined && maxBodySize >= 0 && size > maxBodySize) {
    throw new HttpError('Response body exceeds maxBodySize', { code: 'ERR_MAX_BODY_SIZE' });
  }
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

async function readBytes(response: Response, maxBodySize?: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared >= 0) assertSize(declared, maxBodySize);
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
      assertSize(size, maxBodySize);
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
): Promise<unknown> {
  if (type === 'response') return response;
  if ([204, 205, 304].includes(response.status) || response.headers.get('content-length') === '0') return null;
  const bytes = await readBytes(response, maxBodySize, signal);
  if (!bytes.byteLength) return null;
  if (type === 'arrayBuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (type === 'blob') return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]);
  const raw = new TextDecoder().decode(bytes);
  if (!raw.trim()) return null;
  if (type === 'text') return raw;
  try {
    return await parseJson(raw);
  } catch (cause) {
    throw new HttpError('Response payload is not valid JSON', { code: 'ERR_BAD_PAYLOAD', cause });
  }
}

export async function readErrorPayload(response: Response, maxBodySize?: number, signal?: AbortSignal): Promise<unknown> {
  try {
    const text = await readResponse(response.clone(), 'text', maxBodySize, undefined, signal) as string | null;
    if (!text?.trim()) return null;
    try { return JSON.parse(text); } catch { return text; }
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
