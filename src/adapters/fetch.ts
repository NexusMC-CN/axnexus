import type { AdapterConfig, HttpAdapterFactory } from './types.js';
import type { FetchPriority } from '../core/types.js';
import { HttpError } from '../core/errors.js';
import { ProgressTracker, trackReadableStream } from '../transfer/progress.js';

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function runtimeVersions(): { node?: string; bun?: string } | undefined {
  return (globalThis as {
    process?: { versions?: { node?: string; bun?: string } };
  }).process?.versions;
}

function isBunRuntime(): boolean {
  return Boolean(runtimeVersions()?.bun);
}

function isNodeRuntime(): boolean {
  // Bun exposes a Node-compatible process object, but its Fetch extensions are
  // different from Undici's dispatcher/agent/duplex options.
  const versions = runtimeVersions();
  return Boolean(versions?.node && !isBunRuntime());
}

function isReadableStreamBody(value: unknown): value is ReadableStream<Uint8Array> {
  if (value === null || value === undefined) return false;
  if (typeof ReadableStream === 'function' && value instanceof ReadableStream) return true;
  return typeof (value as { getReader?: unknown }).getReader === 'function';
}

export function createFetchAdapter(fetchImpl?: typeof globalThis.fetch): HttpAdapterFactory {
  return async (config: AdapterConfig) => {
    const runtimeFetch = fetchImpl ?? (globalThis as typeof globalThis & { fetch?: typeof globalThis.fetch }).fetch;
    if (typeof runtimeFetch !== 'function') {
      throw new HttpError('Fetch API is not available', { code: 'ERR_UNSUPPORTED_ADAPTER' });
    }
    const signal = config.signal ?? config.rateLimit?.signal;
    const init: RequestInit & {
      duplex?: 'half';
      dispatcher?: unknown;
      agent?: unknown;
      priority?: FetchPriority;
    } = {
      method: config.method,
      headers: config.headers,
      body: config.body,
      signal,
      credentials: config.credentials,
      mode: config.mode,
      redirect: config.redirect,
      referrer: config.referrer,
      referrerPolicy: config.referrerPolicy,
      integrity: config.integrity,
      keepalive: config.keepalive,
    };
    const fetchCache = config.fetchCache ?? config.requestCache;
    if (fetchCache !== undefined) init.cache = fetchCache;
    if (config.window !== undefined) init.window = config.window;
    if (config.priority !== undefined) init.priority = config.priority;
    if (isNodeRuntime() && config.duplex !== undefined) init.duplex = config.duplex;
    // `dispatcher` and `agent` are Node-specific extensions. Passing them to
    // browsers can make otherwise valid requests fail strict RequestInit
    // validation, so keep them on the Node path only.
    if (isNodeRuntime()) {
      if (config.dispatcher !== undefined) init.dispatcher = config.dispatcher;
      if (config.agent !== undefined) init.agent = config.agent;
    }
    // Node's undici requires this opt-in for WHATWG ReadableStream uploads.
    // Keep it out of browser requests because older implementations reject
    // unknown RequestInit members instead of ignoring them.
    if (isNodeRuntime() && isReadableStreamBody(config.body)) init.duplex = 'half';
    const response = await runtimeFetch(config.url, init);
    const headers = new Headers(response.headers);
    if (!response.body) {
      if (config.onDownloadProgress) {
        new ProgressTracker({
          phase: 'download',
          total: contentLength(response),
          onProgress: config.onDownloadProgress,
          progressInterval: config.progressInterval,
           signal,
        }).complete();
      }
      return response;
    }
    if (!config.onDownloadProgress && !(config.rateLimiter && config.rateLimit?.bytesPerSecond)) return response;
    const body = trackReadableStream(response.body, {
      phase: 'download',
      total: contentLength(response),
      onProgress: config.onDownloadProgress,
      progressInterval: config.progressInterval,
       signal,
      rateLimiter: config.rateLimiter,
       rateLimit: { ...config.rateLimit, signal },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return wrapped;
  };
}

export const fetchAdapter = createFetchAdapter();
