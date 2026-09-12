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

export function createXhrAdapter(): HttpAdapterFactory {
  return (config: AdapterConfig) => new Promise<Response>((resolve, reject) => {
    if (typeof XMLHttpRequest !== 'function') {
      reject(new HttpError('XMLHttpRequest is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' }));
      return;
    }
    const xhr = new XMLHttpRequest();
    const uploadTracker = config.onUploadProgress
      ? new ProgressTracker({ phase: 'upload', onProgress: config.onUploadProgress, progressInterval: config.progressInterval })
      : undefined;
    const downloadTracker = config.onDownloadProgress
      ? new ProgressTracker({ phase: 'download', onProgress: config.onDownloadProgress, progressInterval: config.progressInterval })
      : undefined;
    let settled = false;
    const cleanup = () => {
      config.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: HttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled || xhr.readyState !== 4) return;
      settled = true;
      cleanup();
      uploadTracker?.complete();
      downloadTracker?.complete();
      const body = xhr.responseType === 'arraybuffer' ? xhr.response : (xhr.response ?? xhr.responseText ?? '');
      const status = xhr.status === 1223 ? 204 : xhr.status;
      resolve(new Response(body, {
        status: status || 200,
        statusText: xhr.statusText || '',
        headers: parseResponseHeaders(xhr.getAllResponseHeaders?.() || ''),
      }));
    };
    const onAbort = () => {
      try { xhr.abort(); } catch { /* already closed */ }
      fail(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
    };
    xhr.onreadystatechange = finish;
    xhr.onload = finish;
    xhr.onerror = () => fail(new HttpError('Network request failed', { code: 'ERR_NETWORK', retryable: true }));
    xhr.onabort = () => fail(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
    xhr.ontimeout = () => fail(new HttpError('Request timed out', { code: 'ETIMEDOUT', isTimeout: true, retryable: true }));
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
    config.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      xhr.send(config.body as XMLHttpRequestBodyInit | Document | null | undefined);
    } catch (error) {
      fail(new HttpError('Network request failed', { code: 'ERR_NETWORK', retryable: true, cause: error }));
    }
  });
}

export const xhrAdapter = createXhrAdapter();
