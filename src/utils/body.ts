export function isPlainBody(value: unknown): boolean {
  if (typeof value === 'string') return false;
  if (value === null || typeof value !== 'object') return true;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return false;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return false;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return false;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return false;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return false;
  return true;
}

export function encodeBody(data: unknown, body: BodyInit | null | undefined, headers: Headers): BodyInit | null | undefined {
  if (data === undefined) return body;
  if (!isPlainBody(data)) return data as BodyInit;
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return JSON.stringify(data);
}
