import { HttpError } from '../core/errors.js';
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
  return (config: AdapterConfig) => new Promise<Response>((resolve, reject) => {
    const signal = config.signal ?? config.rateLimit?.signal;
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    if (typeof XMLHttpRequest !== 'function') {
      reject(new HttpError('XMLHttpRequest is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' }));
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
    };
    const fail = (error: HttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled || xhr.readyState !== 4) return;
      if (xhr.status === 0) {
        fail(new HttpError('Network request failed', { code: 'ERR_NETWORK', retryable: true }));
        return;
      }
      const body = xhr.responseType === 'arraybuffer' ? xhr.response : (xhr.response ?? xhr.responseText ?? '');
      const status = xhr.status === 1223 ? 204 : xhr.status;
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
      try { xhr.abort(); } catch { /* already closed */ }
      fail(abortError(signal));
    };
    xhr.onreadystatechange = finish;
    xhr.onload = finish;
    xhr.onerror = () => fail(new HttpError('Network request failed', { code: 'ERR_NETWORK', retryable: true }));
    xhr.onabort = () => fail(abortError(signal));
    xhr.ontimeout = () => fail(new HttpError('Request timed out', { code: 'ETIMEDOUT', isTimeout: true, retryable: true }));
    try {
      xhr.open(config.method, config.url, true);
      xhr.responseType = config.responseType === 'arrayBuffer'
        ? 'arraybuffer'
        : config.responseType === 'blob' ? 'blob' : 'text';
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
  });
}

export const xhrAdapter = createXhrAdapter();
