import { HttpError } from '../core/errors.js';
import { isReadableStreamBody } from '../core/retry.js';
import type { AdapterConfig, HttpAdapterFactory } from './types.js';
import { ProgressTracker } from '../transfer/progress.js';
function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}

/** Statuses that must not carry a payload; XHR exposes them with a null body. */
function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function isTimeoutReason(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const candidate = reason as { code?: unknown; name?: unknown };
  return candidate.code === 'ETIMEDOUT' || candidate.name === 'TimeoutError';
}

function abortError(signal?: AbortSignal): HttpError {
  if (isTimeoutReason(signal?.reason)) {
    return new HttpError('Request timed out', { code: 'ETIMEDOUT', isTimeout: true, retryable: true });
  }
  return new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true });
}

export function createXhrAdapter(): HttpAdapterFactory {
  let lastRelease: (() => void) | undefined;
  const factory = ((config: AdapterConfig) => new Promise<Response>((resolve, reject) => {
    const signal = config.signal ?? config.rateLimit?.signal;
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    if (typeof XMLHttpRequest !== 'function') {
      reject(new HttpError('XMLHttpRequest is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' }));
      return;
    }
    // XHR cannot send streaming request bodies. Passing one through would be
    // coerced to the string "[object ReadableStream]" by WebIDL instead of
    // failing, silently uploading the wrong content.
    if (isReadableStreamBody(config.body)) {
      reject(new HttpError('XMLHttpRequest cannot send a ReadableStream request body', {
        code: 'ERR_UNSUPPORTED_ADAPTER',
      }));
      return;
    }
    let xhr: XMLHttpRequest;
    try {
      xhr = new XMLHttpRequest();
    } catch (cause) {
      reject(new HttpError('Unable to create XMLHttpRequest', { code: 'ERR_NETWORK', retryable: true, cause }));
      return;
    }
    const uploadTracker = config.onUploadProgress
      ? new ProgressTracker({ phase: 'upload', onProgress: config.onUploadProgress, progressInterval: config.progressInterval, signal })
      : undefined;
    const downloadTracker = config.onDownloadProgress
      ? new ProgressTracker({ phase: 'download', onProgress: config.onDownloadProgress, progressInterval: config.progressInterval, signal })
      : undefined;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      lastRelease = undefined;
    };
    lastRelease = cleanup;
    const fail = (error: HttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled || xhr.readyState !== 4) return;
      // `xhr.status` is 0 for a canceled/timeout request too. Leave those to
      // the dedicated handlers so a native timeout is not reported as a
      // retryable network failure; only report ERR_NETWORK for a genuine
      // transport failure that produced no status at all.
      if (xhr.status === 0) {
        if (signal?.aborted) {
          fail(abortError(signal));
          return;
        }
        fail(new HttpError('Network request failed', { code: 'ERR_NETWORK', retryable: true }));
        return;
      }
      const status = xhr.status === 1223 ? 204 : xhr.status;
      // 204/205/304 have no body by definition. Some runtimes still expose an
      // empty string; `new Response('')` is fine, but a non-null body with a
      // bodyless status throws and would be misreported as a network error.
      const rawBody = xhr.responseType === 'arraybuffer' || xhr.responseType === 'blob'
        ? xhr.response
        : (xhr.response ?? xhr.responseText ?? '');
      const isEmpty = rawBody === null || rawBody === undefined || rawBody === ''
        || (typeof ArrayBuffer !== 'undefined' && rawBody instanceof ArrayBuffer && rawBody.byteLength === 0)
        || (typeof Blob !== 'undefined' && rawBody instanceof Blob && rawBody.size === 0);
      const body = isBodylessStatus(status) || isEmpty ? null : rawBody;
      try {
        const response = new Response(body, {
          status,
          statusText: xhr.statusText || '',
          headers: parseResponseHeaders(xhr.getAllResponseHeaders?.() || ''),
        });
        settled = true;
        cleanup();
        uploadTracker?.complete();
        downloadTracker?.complete();
        resolve(response);
      } catch (cause) {
        fail(new HttpError('Invalid XMLHttpRequest response', { code: 'ERR_NETWORK', retryable: true, cause }));
      }
    };
    const onAbort = () => {
      // Classify before aborting: `xhr.abort()` synchronously re-enters
      // `onabort`/`onreadystatechange`, and settling first keeps the reason.
      const error = abortError(signal);
      if (settled) return;
      settled = true;
      cleanup();
      try { xhr.abort(); } catch { /* already closed */ }
      reject(error);
    };
    xhr.onreadystatechange = finish;
    xhr.onload = finish;
    xhr.onerror = () => fail(new HttpError('Network request failed', { code: 'ERR_NETWORK', retryable: true }));
    xhr.onabort = () => {
      // A native abort (or the abort issued above) is reported through the
      // signal when one exists; otherwise preserve the dedicated abort code.
      if (signal?.aborted) fail(abortError(signal));
      else fail(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
    };
    xhr.ontimeout = () => fail(new HttpError('Request timed out', { code: 'ETIMEDOUT', isTimeout: true, retryable: true }));
    try {
      xhr.open(config.method, config.url, true);
      // Always read the response as binary. Mapping `responseType: 'response'`
      // to text would decode the bytes before re-constructing a Response and
      // corrupt any non-text payload.
      xhr.responseType = 'arraybuffer';
      // `credentials: 'omit'` cannot be expressed by XHR: withCredentials=false
      // still sends same-origin cookies (the XHR credentials mode stays
      // same-origin). Reject rather than silently leaking session credentials.
      if (config.credentials === 'omit') {
        fail(new HttpError('XMLHttpRequest cannot guarantee credentials: "omit"', {
          code: 'ERR_UNSUPPORTED_ADAPTER',
        }));
        return;
      }
      xhr.withCredentials = config.credentials === 'include';
      if (config.timeout && config.timeout > 0) xhr.timeout = config.timeout;
      config.headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      if (config.onUploadProgress && xhr.upload) {
        xhr.upload.onprogress = (event) => {
          const total = event.lengthComputable ? event.total : undefined;
          uploadTracker?.setTotal(total);
          uploadTracker?.update(event.loaded, Date.now());
        };
      }
      if (downloadTracker) {
        xhr.onprogress = (event) => {
          downloadTracker.setTotal(event.lengthComputable ? event.total : undefined);
          downloadTracker.update(event.loaded, Date.now());
        };
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      // Close the small race between the initial check and listener setup.
      if (signal?.aborted) {
        onAbort();
        return;
      }
      xhr.send(config.body as XMLHttpRequestBodyInit | Document | null | undefined);
    } catch (error) {
      fail(new HttpError('Network request failed', { code: 'ERR_NETWORK', retryable: true, cause: error }));
    }
  })) as HttpAdapterFactory & { releaseStream?: () => void };
  // XHR settles through `cleanup`, but a caller that abandons the request (for
  // example after a `responseType: 'response'` body is no longer needed) can
  // still ask the client to drop the pending abort listener.
  factory.releaseStream = () => {
    lastRelease?.();
    lastRelease = undefined;
  };
  return factory;
}

export const xhrAdapter = createXhrAdapter();
