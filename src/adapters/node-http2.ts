import { HttpError, isHttpError } from '../core/errors.js';
import { ProgressTracker, trackReadableStream } from '../transfer/progress.js';
import type { RateLimitOptions } from '../transfer/rate-limiter.js';
import type { AdapterConfig, AdapterResult, HttpAdapterFactory } from './types.js';

interface Http2Stream {
  on(event: string, listener: (...args: any[]) => void): this;
  once?(event: string, listener: (...args: any[]) => void): this;
  end(body?: unknown): void;
  close?(code?: number): void;
  write?(chunk: unknown): boolean;
  pause?(): void;
  resume?(): void;
}

interface Http2Session {
  request(headers: Record<string, string>, options?: { endStream?: boolean }): Http2Stream;
  on?(event: string, listener: (...args: any[]) => void): this;
  close?(): void;
  destroy?(): void;
  unref?(): void;
  readonly closed?: boolean;
  readonly destroyed?: boolean;
}

interface Http2Module {
  connect(origin: string): Http2Session;
  constants?: { NGHTTP2_CANCEL?: number };
}

export interface NodeHttp2AdapterOptions {
  module?: Http2Module;
}

type SessionStreamFailure = (cause: unknown) => void;

interface Http2SessionState {
  active: Set<SessionStreamFailure>;
  closed: boolean;
  failure?: unknown;
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

/** Resolve when the stream has drained, or reject when it closes/aborts first. */
function waitForDrain(stream: Http2Stream, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      stream.on?.('drain', onDrain);
      stream.on?.('close', onClose);
      stream.on?.('error', onClose);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onDrain = () => finish();
    const onClose = () => finish(signalReason(signal));
    const onAbort = () => finish(signalReason(signal));
    stream.on?.('drain', onDrain);
    stream.on?.('close', onClose);
    stream.on?.('error', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
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
  // `write()` returning false means the internal buffer is full. Ignoring it
  // lets a fast producer outrun the socket and grow memory without bound.
  const writable = stream.write?.(chunk);
  options.tracker?.update(options.tracker.loaded + chunk.byteLength);
  if (writable === false) await waitForDrain(stream, signal);
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
    // Cancelling during a byte-throttle wait must also cancel the upload
    // source. Releasing the reader lock does not run the source's cleanup.
    const onAbort = () => {
      try { void reader.cancel(signalReason(signal)).catch(() => undefined); } catch { /* already closed */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw signalReason(signal);
      while (true) {
        const result = await readChunk(reader, signal);
        if (result.done) break;
        await writeRequestChunk(stream, toBytes(result.value), signal, options);
      }
      if (!signal.aborted) stream.end();
      options.tracker?.complete();
      return;
    } finally {
      signal.removeEventListener('abort', onAbort);
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
  const sessionStates = new WeakMap<Http2Session, Http2SessionState>();
  let modulePromise: Promise<Http2Module> | undefined;
  const getModule = () => modulePromise ??= Promise.resolve(options.module ?? loadHttp2());

  const attachSessionState = (origin: string, session: Http2Session): Http2SessionState => {
    const existing = sessionStates.get(session);
    if (existing) return existing;

    const state: Http2SessionState = { active: new Set(), closed: false };
    sessionStates.set(session, state);
    // An idle session keeps the event loop referenced, which prevents a
    // one-shot script from exiting after its responses were consumed.
    try { session.unref?.(); } catch { /* optional runtime capability */ }
    const discard = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    const failActive = (cause: unknown) => {
      if (state.failure === undefined) {
        state.failure = cause ?? new Error('HTTP/2 session failed');
      }
      state.closed = true;
      discard();
      for (const fail of [...state.active]) {
        try { fail(state.failure); } catch { /* one stream must not block the others */ }
      }
    };
    session.on?.('error', (cause: unknown) => failActive(cause));
    // A GOAWAY means the peer will not accept new streams on this session even
    // though existing ones may still finish and `close` has not fired yet.
    // Retire it from the pool so new requests open a fresh connection.
    session.on?.('goaway', () => {
      discard();
      state.closed = true;
    });
    session.on?.('close', () => {
      if (state.active.size > 0) {
        failActive(state.failure ?? new Error('HTTP/2 session closed before streams completed'));
      } else {
        state.closed = true;
        discard();
      }
    });
    return state;
  };

  const registerSessionStream = (
    state: Http2SessionState,
    fail: SessionStreamFailure,
  ): (() => void) => {
    if (state.failure !== undefined || state.closed) {
      fail(state.failure ?? new Error('HTTP/2 session is unavailable'));
      return () => undefined;
    }
    state.active.add(fail);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      state.active.delete(fail);
    };
  };

  const factory = (async (config: AdapterConfig): Promise<AdapterResult> => {
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
    }
    const sessionState = attachSessionState(origin, session);
    if (sessionState.failure !== undefined || sessionState.closed) {
      if (sessions.get(origin) === session) sessions.delete(origin);
      throw networkError(sessionState.failure ?? new Error('HTTP/2 session is unavailable'));
    }

    const requestHeaders: Record<string, string> = {
      ':method': config.method,
      ':authority': target.host,
    };
    // Node ends the writable side immediately for methods it considers
    // body-less (DELETE among them). Opting out explicitly is required before
    // writing a request body, and CONNECT must omit `:path` entirely.
    if (config.method !== 'CONNECT') {
      requestHeaders[':path'] = `${target.pathname || '/'}${target.search}`;
    }
    config.headers.forEach((value, name) => {
      if (!name.startsWith(':')) requestHeaders[name.toLowerCase()] = value;
    });

    const preparedBody = await prepareRequestBody(config.body, requestHeaders, config.method, signal);
    if (signal?.aborted) throw abortError(signal);
    if (sessionState.failure !== undefined || sessionState.closed) {
      if (sessions.get(origin) === session) sessions.delete(origin);
      throw networkError(sessionState.failure ?? new Error('HTTP/2 session is unavailable'));
    }
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
    // DELETE defaults to an ended writable side in Node, so the body could
    // never be written. Always create the stream with `endStream: false` and
    // close it explicitly once the body has been sent.
    const stream = session.request(requestHeaders, { endStream: false });
    const cancelCode = http2.constants?.NGHTTP2_CANCEL ?? 8;
    const requestBodyAbort = new AbortController();
    let transportClosed = false;
    let responsePromiseSettled = false;
    let responseHeadersReceived = false;
    let requestBodyDone = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyClosed = false;
    let onAbort: (() => void) | undefined;
    let unregisterSessionStream: () => void = () => undefined;
    const maybeUnregisterSessionStream = () => {
      if (requestBodyDone && bodyClosed) unregisterSessionStream();
    };

    const closeTransport = () => {
      if (transportClosed) return;
      transportClosed = true;
      try { stream.close?.(cancelCode); } catch { /* stream already closed */ }
    };

    const cleanupAbort = () => {
      if (!onAbort) return;
      if (responsePromiseSettled && bodyClosed) {
        signal?.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
    };

    const markBodyClosed = () => {
      bodyClosed = true;
      maybeUnregisterSessionStream();
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
      } else {
        if (!bodyClosed) {
          bodyClosed = true;
          try { bodyController?.error(normalized); } catch { /* consumer already closed */ }
        }
        if (!requestBodyAbort.signal.aborted) requestBodyAbort.abort(normalized);
      }
      if (close) closeTransport();
      maybeUnregisterSessionStream();
      cleanupAbort();
    };

    unregisterSessionStream = registerSessionStream(sessionState, failResponse);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        stream.on('data', (chunk: unknown) => {
          if (bodyClosed) return;
          try { controller.enqueue(toBytes(chunk)); } catch { /* consumer canceled */ }
          // Respect the consumer's pace: pausing the source when the internal
          // queue is full prevents unbounded buffering on large downloads.
          const desired = controller.desiredSize;
          if (desired !== null && desired <= 0) {
            try { stream.pause?.(); } catch { /* unsupported by the transport */ }
          }
        });
        stream.on('end', () => {
          if (bodyClosed) return;
          bodyClosed = true;
          try { controller.close(); } catch { /* consumer canceled */ }
          maybeUnregisterSessionStream();
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
            maybeUnregisterSessionStream();
            cleanupAbort();
          }
        });
      },
      pull() {
        // The consumer is ready for more data; resume the paused source.
        try { stream.resume?.(); } catch { /* unsupported by the transport */ }
      },
      cancel(reason) {
        if (bodyClosed) return;
        bodyClosed = true;
        if (!requestBodyAbort.signal.aborted) requestBodyAbort.abort(reason);
        closeTransport();
        maybeUnregisterSessionStream();
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
            if (name.startsWith(':')) continue;
            // `set-cookie` is the one response field HTTP allows to repeat as a
            // list. String(value) would join the cookies with commas and lose
            // the individual boundaries, breaking session handling.
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, String(item));
            } else {
              responseHeaders.append(name, String(value));
            }
          }
          if ([204, 205, 304].includes(status)) {
            // No payload will ever arrive. Settle first, then release the abort
            // listener: `cleanupAbort` needs both flags set, so calling it
            // before the promise is marked settled would skip the removal and
            // leak the listener (plus its captured stream) for the whole life
            // of a long-lived caller signal.
            bodyClosed = true;
            responsePromiseSettled = true;
            resolve(new Response(null, { status, headers: responseHeaders }));
            maybeUnregisterSessionStream();
            cleanupAbort();
            // Nothing more will be written; a response without a body still
            // needs the request body path to stop.
            if (!requestBodyAbort.signal.aborted) {
              requestBodyAbort.abort(networkError(new Error('HTTP/2 response has no body')));
            }
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
          try { bodyController?.error(error); } catch { /* consumer already closed */ }
        }
        closeTransport();
        maybeUnregisterSessionStream();
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
        maybeUnregisterSessionStream();
        cleanupAbort();
      });
    // The upload is allowed to outlive the response. Once the response is fully
    // consumed nothing further will be written, so stop the reader instead of
    // leaving the body source open; its rejection is expected in that case.
    requestBody.catch(() => undefined);

    // RFC 9113 permits the server to send a complete response before the
    // request body has been fully written (for example an early 413). Waiting
    // for the upload would hide that status until the body source produces
    // another chunk, so the adapter returns as soon as the response is
    // complete. `responseBodyDone` resolves when the response body has ended.
    const response = await responsePromise;
    return { response, metadata: { protocol: 'h2', timings: { startedAt } } };
  }) as HttpAdapterFactory & {
    closeTransport?: () => void;
    releaseStream?: () => void;
  };
  /**
   * Close every pooled session. Without an explicit release an idle session can
   * hold the process open indefinitely, and repeated adapter creation would
   * keep abandoned connections alive.
   */
  factory.closeTransport = () => {
    const pending = [...sessions.values()];
    sessions.clear();
    for (const session of pending) {
      try { session.close?.(); } catch { /* session already closing */ }
      try { session.destroy?.(); } catch { /* session already destroyed */ }
    }
  };
  factory.releaseStream = () => {
    // Per-request listeners are owned and removed by the request scope itself;
    // nothing global needs releasing here.
  };
  return factory;
}

export const nodeHttp2Adapter = createNodeHttp2Adapter();
