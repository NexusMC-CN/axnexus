import type { AxiosHeaders } from '../headers/headers.js';

/**
 * Detect an ArrayBuffer across execution contexts. `instanceof` fails for a
 * buffer created in a same-origin iframe, which would then be JSON-serialized
 * (producing `'{}'`) instead of being uploaded as bytes.
 */
function isArrayBufferLike(value: unknown): boolean {
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { byteLength?: unknown };
  if (typeof candidate.byteLength !== 'number') return false;
  // Only a real ArrayBuffer exposes `slice` and lacks `BYTES_PER_ELEMENT`.
  return typeof (value as { slice?: unknown }).slice === 'function'
    && (value as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === undefined
    && Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

export function isPlainBody(value: unknown): boolean {
  if (typeof value === 'string') return false;
  if (value === null || typeof value !== 'object') return true;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return false;
  if (isArrayBufferLike(value)) return false;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return false;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return false;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return false;
  // Cross-realm ReadableStream (same-origin iframe) keeps its reader factory.
  if (typeof (value as { getReader?: unknown }).getReader === 'function') return false;
  return true;
}

export function encodeBody(
  data: unknown,
  body: BodyInit | null | undefined,
  headers: Headers | Pick<AxiosHeaders, 'has' | 'set' | 'isDisabled'>,
  stringifyJson: (value: unknown) => string = JSON.stringify,
  options: { contentTypeDisabled?: boolean } = {},
): BodyInit | null | undefined {
  if (data === undefined) return body;
  if (!isPlainBody(data)) return data as BodyInit;
  // A `false` opt-out (or an explicit deletion) must not be overridden by the
  // automatic Content-Type the JSON encoder would otherwise add.
  const disabled = options.contentTypeDisabled
    || (typeof (headers as Partial<AxiosHeaders>).isDisabled === 'function'
      && (headers as AxiosHeaders).isDisabled('Content-Type'));
  if (!headers.has('Content-Type') && !disabled) headers.set('Content-Type', 'application/json');
  return stringifyJson(data);
}
