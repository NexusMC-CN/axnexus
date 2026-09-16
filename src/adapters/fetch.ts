import type { AdapterConfig, HttpAdapterFactory } from './types.js';
import type { FetchPriority } from '../core/types.js';
import { HttpError } from '../core/errors.js';
import { ProgressTracker, trackReadableStream } from '../transfer/progress.js';
import { markResponseMethod } from '../utils/response.js';

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * True when the body Fetch exposes is decoded while `Content-Length` still
 * describes the compressed size, making the declared length unusable as a
 * progress total.
 */
function isCompressed(response: Response): boolean {
  const encoding = response.headers.get('content-encoding');
  if (encoding === null) return false;
  const normalized = encoding.trim().toLowerCase();
  return normalized !== '' && normalized !== 'identity';
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

/** A response with no body: HEAD and the bodyless statuses transfer nothing. */
function hasNoResponseBody(status: number, method: string): boolean {
  if (method.toUpperCase() === 'HEAD') return true;
  return status === 204 || status === 205 || status === 304;
}

/**
 * Copy identity metadata that a re-created Response would otherwise lose.
 * `url`, `redirected` and `type` are read-only and derived from the internal
 * response state, so they are overridden on the instance rather than proxied —
 * a Proxy is not recognized as a `Response` by `instanceof` consumers.
 */
function proxyResponseMetadata(source: Response, target: Response): Response {
  for (const property of ['url', 'redirected', 'type'] as const) {
    try {
      Object.defineProperty(target, property, {
        value: source[property],
        configurable: true,
        enumerable: false,
      });
    } catch {
      // A non-configurable runtime keeps its own value; the body still works.
    }
  }
  return target;
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
    // `duplex` is required by the Fetch standard for a ReadableStream body, in
    // browsers as well as Node. Forwarding it only on Node made browser
    // streaming uploads fail with a missing-duplex TypeError.
    if (config.duplex !== undefined) init.duplex = config.duplex;
    // `dispatcher` and `agent` are Node-specific extensions. Passing them to
    // browsers can make otherwise valid requests fail strict RequestInit
    // validation, so keep them on the Node path only.
    if (isNodeRuntime()) {
      if (config.dispatcher !== undefined) init.dispatcher = config.dispatcher;
      if (config.agent !== undefined) init.agent = config.agent;
    }
    if (isReadableStreamBody(config.body)) init.duplex = 'half';
    const response = await runtimeFetch(config.url, init);
    // Tag the response so downstream body handling recognizes a HEAD probe
    // whose Content-Length describes the matching GET resource.
    markResponseMethod(response, config.method);
    const headers = new Headers(response.headers);
    const bodyless = hasNoResponseBody(response.status, config.method);
    if (!response.body) {
      if (config.onDownloadProgress) {
        new ProgressTracker({
          phase: 'download',
          // A HEAD response advertises the size of the corresponding GET
          // representation while transferring zero bytes; reporting it as
          // downloaded would fabricate a complete transfer.
          total: bodyless ? 0 : contentLength(response),
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
      // Content-Length describes the *encoded* payload while the stream yields
      // decoded bytes, so a compressed response would exceed its total and pin
      // percent at 100 before the transfer finished. Only trust it when the
      // response is not compressed, and never for a bodyless status.
      total: bodyless ? 0 : (isCompressed(response) ? undefined : contentLength(response)),
      onProgress: config.onDownloadProgress,
      progressInterval: config.progressInterval,
       signal,
      rateLimiter: config.rateLimiter,
       rateLimit: { ...config.rateLimit, signal },
    });
    // Re-creating the Response drops its url/redirected/type; surface the
    // original values so callers relying on them are not misled.
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return proxyResponseMetadata(response, wrapped);
  };
}

export const fetchAdapter = createFetchAdapter();
