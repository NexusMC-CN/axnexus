import { HttpError } from '../core/errors.js';

export function sanitizeHeaderName(name: string): string {
  const value = String(name).trim();
  if (!value || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(value)) {
    throw new HttpError('Invalid header name', { code: 'ERR_INVALID_HEADER' });
  }
  return value;
}

export function sanitizeHeaderValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new HttpError('Invalid header value', { code: 'ERR_INVALID_HEADER' });
  return value;
}
