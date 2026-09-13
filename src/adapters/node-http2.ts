import { HttpError, isHttpError } from '../core/errors.js';
import { ProgressTracker, trackReadableStream } from '../transfer/progress.js';
import type { RateLimitOptions } from '../transfer/rate-limiter.js';
import type { AdapterConfig, AdapterResult, HttpAdapterFactory } from './types.js';

interface Http2Stream {
  on(event: string, listener: (...args: any[]) => void): this;
  end(body?: unknown): void;
  close?(code?: number): void;
  write?(chunk: unknown): boolean;
}

interface Http2Session {
  request(headers: Record<string, string>): Http2Stream;
  on?(event: string, listener: (...args: any[]) => void): this;
  close?(): void;
}

interface Http2Module {
  connect(origin: string): Http2Session;
  constants?: { NGHTTP2_CANCEL?: number };
}

export interface NodeHttp2AdapterOptions {
  module?: Http2Module;
}

function loadHttp2(): Promise<Http2Module> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Http2Module>;
  return dynamicImport('node:http2');
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  return new TextEncoder().encode(String(chunk));
}

function canceledError(cause?: unknown): HttpError {
  return new HttpError('Request canceled', {
    code: 'ERR_CANCELED',
    isAbort: true,
    cause,
  });
}

function abortError(signal: AbortSignal): HttpError {
  const reason = signalReason(signal) as { code?: unknown; name?: unknown } | undefined;
  if (reason?.code === 'ETIMEDOUT' || reason?.name === 'TimeoutError') {
    return new HttpError('Request timed out', {
      code: 'ETIMEDOUT',
      isTimeout: true,
      retryable: true,
      cause: reason,
    });
  }
  return canceledError(reason);
}

function networkError(cause?: unknown): HttpError {
  return new HttpError('HTTP/2 stream failed', {
    code: 'ERR_NETWORK',
    retryable: true,
    cause,
  });
}

function signalReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted', 'AbortError')
    : new Error('The operation was aborted');
}

function isReadableStreamBody(value: unknown): value is ReadableStream<Uint8Array> {
  if (value === null || value === undefined) return false;
  if (typeof ReadableStream === 'function' && value instanceof ReadableStream) return true;
  return typeof (value as { getReader?: unknown }).getReader === 'function';
}

function byteLength(value: unknown): number | undefined {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value.byteLength;
  return undefined;
}

function declaredLength(headers: Record<string, string>): number | undefined {
  const value = Number(headers['content-length']);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface RequestTransferOptions {
  tracker?: ProgressTracker;
  rateLimiter?: import('../transfer/rate-limiter.js').RateLimiter;
  rateLimit?: RateLimitOptions;
}

async function writeRequestChunk(
  stream: Http2Stream,
  chunk: Uint8Array,
  signal: AbortSignal,
  options: RequestTransferOptions,
): Promise<void> {
  if (signal.aborted) throw signalReason(signal);
  if (options.rateLimiter) {
    await options.rateLimiter.consume(chunk.byteLength, {
      ...options.rateLimit,
      signal,
    });
  }
  if (signal.aborted) throw signalReason(signal);
  stream.write?.(chunk);
  options.tracker?.update(options.tracker.loaded + chunk.byteLength);
}

/** Convert browser BodyInit values to chunks accepted by Node's http2 stream. */
async function prepareRequestBody(
  body: unknown,
  headers: Record<string, string>,
  method: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (body === null || body === undefined || typeof body === 'string' || isReadableStreamBody(body)) return body;
  if (signal?.aborted) throw signalReason(signal);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (!headers['content-type'] && body.type) headers['content-type'] = body.type;
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    return body.toString();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    if (typeof Request !== 'function') {
      throw new HttpError('HTTP/2 FormData requests require the Fetch Request API', { code: 'ERR_UNSUPPORTED_ADAPTER' });
    }
    const syntheticMethod = method === 'GET' || method === 'HEAD' ? 'POST' : method;
    const request = new Request('http://axnexus.invalid/', { method: syntheticMethod, body });
    const contentType = request.headers.get('content-type');
    if (!headers['content-type'] && contentType) headers['content-type'] = contentType;
    return new Uint8Array(await request.arrayBuffer());
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

/**
 * Wait for a request-body chunk while still allowing the transport to cancel
 * the pending read. `ReadableStreamDefaultReader.read()` itself does not
 * observe an AbortSignal, so merely checking `signal.aborted` before the read
 * is not sufficient for a stream whose producer is waiting indefinitely.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signalReason(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const reason = signalReason(signal);
      try { void reader.cancel(reason).catch(() => undefined); } catch { /* stream already closed */ }
      reject(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function endRequest(
  stream: Http2Stream,
  body: unknown,
  signal: AbortSignal,
  options: RequestTransferOptions = {},
): Promise<void> {
  if (signal.aborted) throw signalReason(signal);
  if (isReadableStreamBody(body)) {
    const reader = body.getReader();
    try {
      while (true) {
        const result = await readChunk(reader, signal);
        if (result.done) break;
        await writeRequestChunk(stream, toBytes(result.value), signal, options);
      }
      if (!signal.aborted) stream.end();
      options.tracker?.complete();
      return;
    } finally {
      try { reader.releaseLock(); } catch { /* a pending read may still own the lock */ }
    }
  }
  if (signal.aborted) throw signalReason(signal);
  const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : byteLength(body) === undefined ? undefined : toBytes(body);
  if (bytes && (options.rateLimiter || options.tracker)) {
    if (options.rateLimiter) {
      await options.rateLimiter.consume(bytes.byteLength, { ...options.rateLimit, signal });
    }
    if (signal.aborted) throw signalReason(signal);
    stream.end(body instanceof ArrayBuffer ? bytes : body);
    options.tracker?.update(bytes.byteLength);
    options.tracker?.complete();
    return;
  }
  stream.end(body);
  options.tracker?.complete();
}

export function createNodeHttp2Adapter(options: NodeHttp2AdapterOptions = {}): HttpAdapterFactory {
  const sessions = new Map<string, Http2Session>();
  let modulePromise: Promise<Http2Module> | undefined;
  const getModule = () => modulePromise ??= Promise.resolve(options.module ?? loadHttp2());

  return async (config: AdapterConfig): Promise<AdapterResult> => {
    const startedAt = Date.now();
    // Direct adapter consumers may provide the cancellation signal through
    // rateLimit instead of the resolved request signal.
    const signal = config.signal ?? config.rateLimit?.signal;
    if (signal?.aborted) throw abortError(signal);

    const http2 = await getModule();
    if (signal?.aborted) throw abortError(signal);
    const target = new URL(config.url);
    const origin = target.origin;
    let session = sessions.get(origin);
    if (!session) {
      session = http2.connect(origin);
      sessions.set(origin, session);
      const discard = () => {
        if (sessions.get(origin) === session) sessions.delete(origin);
      };
      session.on?.('close', discard);
      session.on?.('error', discard);
    }

    const requestHeaders: Record<string, string> = {
      ':method': config.method,
      ':path': `${target.pathname || '/'}${target.search}`,
      ':authority': target.host,
    };
    config.headers.forEach((value, name) => {
      if (!name.startsWith(':')) requestHeaders[name.toLowerCase()] = value;
    });

    const preparedBody = await prepareRequestBody(config.body, requestHeaders, config.method, signal);
    if (signal?.aborted) throw abortError(signal);
    const uploadTotal = declaredLength(requestHeaders) ?? byteLength(preparedBody);
    const uploadTracker = config.onUploadProgress && preparedBody !== undefined && preparedBody !== null
      ? new ProgressTracker({
        phase: 'upload',
        total: uploadTotal,
        onProgress: config.onUploadProgress,
        progressInterval: config.progressInterval,
        signal,
      })
      : undefined;
    const stream = session.request(requestHeaders);
    const cancelCode = http2.constants?.NGHTTP2_CANCEL ?? 8;
    const requestBodyAbort = new AbortController();
    let transportClosed = false;
    let responsePromiseSettled = false;
    let responseHeadersReceived = false;
    let requestBodyDone = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyClosed = false;
    let onAbort: (() => void) | undefined;

    const closeTransport = () => {
      if (transportClosed) return;
      transportClosed = true;
      try { stream.close?.(cancelCode); } catch { /* stream already closed */ }
    };

    const cleanupAbort = () => {
      if (!onAbort) return;
      if (responsePromiseSettled && requestBodyDone && bodyClosed) {
        signal?.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
    };

    const markBodyClosed = () => {
      bodyClosed = true;
      cleanupAbort();
    };

    // A transport may emit an event synchronously from `request()`. Keep a
    // harmless fallback until the response promise installs its rejector.
    const noopReject: (reason?: unknown) => void = () => {};
    let rejectResponse: (reason?: unknown) => void = noopReject;
    let pendingFailure: unknown;
    const failResponse = (error: unknown, close = true) => {
      const normalized = isHttpError(error) ? error : networkError(error);
      if (!responseHeadersReceived) {
        bodyClosed = true;
        if (!responsePromiseSettled) {
          if (rejectResponse === noopReject) {
            // A stream can report an error while its body listeners are being
            // attached, before the response promise executor installs its
            // reject function. Defer the rejection instead of leaving a
            // permanently pending promise.
            pendingFailure = normalized;
          } else {
            responsePromiseSettled = true;
            rejectResponse(normalized);
          }
        }
        if (!requestBodyAbort.signal.aborted) requestBodyAbort.abort(normalized);
      } else if (!bodyClosed) {
        bodyClosed = true;
        bodyController?.error(normalized);
        if (!requestBodyAbort.signal.aborted) requestBodyAbort.abort(normalized);
      }
      if (close) closeTransport();
      cleanupAbort();
    };

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        stream.on('data', (chunk: unknown) => {
          if (bodyClosed) return;
          try { controller.enqueue(toBytes(chunk)); } catch { /* consumer canceled */ }
        });
        stream.on('end', () => {
          if (bodyClosed) return;
          bodyClosed = true;
          try { controller.close(); } catch { /* consumer canceled */ }
          cleanupAbort();
        });
        stream.on('error', (error: unknown) => {
          failResponse(error, true);
        });
        stream.on('aborted', () => {
          failResponse(networkError(new Error('HTTP/2 stream aborted')), true);
        });
        stream.on('close', () => {
          if (!responseHeadersReceived) {
            failResponse(networkError(new Error('HTTP/2 stream closed before response')), false);
          } else if (!bodyClosed) {
            // A normal HTTP/2 response emits `end` before `close`. A close
            // without end means the body was truncated and must not leave a
            // consumer waiting forever.
            bodyClosed = true;
            try { controller.error(networkError(new Error('HTTP/2 stream closed before end'))); } catch { /* consumer canceled */ }
            cleanupAbort();
          }
        });
      },
      cancel(reason) {
        if (bodyClosed) return;
        bodyClosed = true;
        if (!requestBodyAbort.signal.aborted) requestBodyAbort.abort(reason);
        closeTransport();
        cleanupAbort();
      },
    });

    const responsePromise = new Promise<Response>((resolve, reject) => {
      rejectResponse = reject;
      if (pendingFailure !== undefined) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        failResponse(failure);
      }
      const onResponse = (headers: Record<string, string | number>) => {
        if (responsePromiseSettled) return;
        // Mark that a response event is being handled, but do not mark the
        // promise settled until Response construction succeeds. Native
        // Response/Headers constructors reject malformed status or fields.
        responseHeadersReceived = true;
        try {
          const rawStatus = headers[':status'];
          const status = typeof rawStatus === 'number'
            ? rawStatus
            : typeof rawStatus === 'string' && rawStatus.trim()
              ? Number(rawStatus)
              : Number.NaN;
          if (!Number.isInteger(status) || status < 200 || status > 599) {
            throw networkError(new Error(`Invalid HTTP/2 response status: ${String(rawStatus)}`));
          }
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(headers)) {
            if (!name.startsWith(':')) responseHeaders.append(name, String(value));
          }
          if ([204, 205, 304].includes(status)) {
            markBodyClosed();
            responsePromiseSettled = true;
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          const responseBody = config.onDownloadProgress || (config.rateLimiter && config.rateLimit?.bytesPerSecond)
            ? trackReadableStream(body, {
              phase: 'download',
              total: Number(responseHeaders.get('content-length')) || undefined,
              onProgress: config.onDownloadProgress,
              progressInterval: config.progressInterval,
              signal,
              rateLimiter: config.rateLimiter,
              rateLimit: { ...config.rateLimit, signal },
            })
            : body;
          const response = new Response(responseBody, { status, headers: responseHeaders });
          responsePromiseSettled = true;
          resolve(response);
        } catch (error) {
          responseHeadersReceived = false;
          failResponse(error, true);
          return;
        }
        cleanupAbort();
      };
      stream.on('response', onResponse);
      onAbort = () => {
        const error = signal ? abortError(signal) : canceledError();
        if (!requestBodyAbort.signal.aborted) requestBodyAbort.abort(error);
        if (!responseHeadersReceived) {
          if (!responsePromiseSettled) {
            responsePromiseSettled = true;
            reject(error);
          }
          bodyClosed = true;
        } else if (!bodyClosed) {
          bodyClosed = true;
          bodyController?.error(error);
        }
        closeTransport();
        cleanupAbort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });

    const requestBody = endRequest(stream, preparedBody, requestBodyAbort.signal, {
      tracker: uploadTracker,
      rateLimiter: config.rateLimiter,
      rateLimit: config.rateLimit,
    })
      .catch((error) => {
        if (!responseHeadersReceived) failResponse(error, true);
        else if (!bodyClosed) failResponse(error, true);
        throw error;
      })
      .finally(() => {
        requestBodyDone = true;
        cleanupAbort();
      });

    const [response] = await Promise.all([responsePromise, requestBody]);
    return { response, metadata: { protocol: 'h2', timings: { startedAt } } };
  };
}

export const nodeHttp2Adapter = createNodeHttp2Adapter();
