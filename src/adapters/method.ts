import { HttpError } from '../core/errors.js';

export function assertBrowserMethod(method: string): void {
  if (['CONNECT', 'TRACE', 'TRACK'].includes(method.toUpperCase())) {
    throw new HttpError(`Fetch and XMLHttpRequest do not support ${method.toUpperCase()}`, {
      code: 'ERR_UNSUPPORTED_METHOD',
      retryable: false,
    });
  }
}
