import { HttpError } from '../core/errors.js';
import type { ResponseType } from '../core/types.js';

function assertSize(size: number, maxBodySize: number | undefined): void {
  if (maxBodySize !== undefined && maxBodySize >= 0 && size > maxBodySize) {
    throw new HttpError('Response body exceeds maxBodySize', { code: 'ERR_MAX_BODY_SIZE' });
  }
}

async function readBytes(response: Response, maxBodySize?: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared >= 0) assertSize(declared, maxBodySize);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertSize(bytes.byteLength, maxBodySize);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      assertSize(size, maxBodySize);
      chunks.push(result.value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* stream already failed */ }
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponse(response: Response, type: ResponseType = 'json', maxBodySize?: number): Promise<unknown> {
  if (type === 'response') return response;
  if (response.status === 204 || response.headers.get('content-length') === '0') return null;
  const bytes = await readBytes(response, maxBodySize);
  if (!bytes.byteLength) return null;
  if (type === 'arrayBuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (type === 'blob') return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]);
  const raw = new TextDecoder().decode(bytes);
  if (type === 'text') return raw.trim() ? raw : null;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new HttpError('Response payload is not valid JSON', { code: 'ERR_BAD_PAYLOAD', cause });
  }
}

export async function readErrorPayload(response: Response, maxBodySize?: number): Promise<unknown> {
  try {
    const text = await readResponse(response.clone(), 'text', maxBodySize) as string | null;
    if (!text?.trim()) return null;
    try { return JSON.parse(text); } catch { return text; }
  } catch {
    return null;
  }
}
