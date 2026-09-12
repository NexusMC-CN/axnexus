import type { AdapterConfig, HttpAdapterFactory } from './types.js';
import { trackReadableStream } from '../transfer/progress.js';

function contentLength(response: Response): number | undefined {
  const value = Number(response.headers.get('content-length'));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createFetchAdapter(): HttpAdapterFactory {
  return async (config: AdapterConfig) => {
    const startedAt = Date.now();
    const response = await fetch(config.url, {
      method: config.method,
      headers: config.headers,
      body: config.body,
      signal: config.signal,
      credentials: config.credentials,
      mode: config.mode,
      redirect: config.redirect,
      referrer: config.referrer,
      referrerPolicy: config.referrerPolicy,
      integrity: config.integrity,
      keepalive: config.keepalive,
    });
    const headers = new Headers(response.headers);
    if (!config.onDownloadProgress || !response.body) return response;
    const body = trackReadableStream(response.body, {
      phase: 'download',
      total: contentLength(response),
      onProgress: config.onDownloadProgress,
      progressInterval: config.progressInterval,
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    void startedAt;
    return wrapped;
  };
}

export const fetchAdapter = createFetchAdapter();
