import { raceWithSignal, signalReason, sleep } from '../core/control.js';
import { HttpError, isHttpError } from '../core/errors.js';
import type { HttpClient, NoSchemaRequestConfig, RequestConfig } from '../core/types.js';
import { AxiosHeaders } from '../headers/headers.js';
import { invalidConfig, validateStreamOptions } from './decoder.js';
import { parseSSEWithState } from './sse.js';
import type { ParserStreamOptions, SchemaStreamOptions, SSEEvent, StreamDecodeOptions } from './types.js';

export interface SSEReconnectOptions {
  /** Maximum total connection attempts, including the first. Must be a positive safe integer. */
  maxAttempts: number;
  /** Initial reconnection delay in milliseconds; server retry fields can replace it. Default: 1000. */
  delay?: number;
  /** Upper bound for both configured and server-provided delays. Default: 30000. */
  maxDelay?: number;
  /** Reconnect after ordinary EOF; disabled by default. */
  retryOnEOF?: boolean;
}

export interface ConnectSSEOptions<T = string, TContext = unknown> extends StreamDecodeOptions<T> {
  request?: Omit<RequestConfig<TContext>, 'url' | 'responseType' | 'signal' | 'schema' | 'parseJson' | 'transformResponse'>;
  reconnect?: SSEReconnectOptions;
  /** Matching events end the application stream and are not yielded or reconnected. No default sentinel. */
  isComplete?: (event: SSEEvent<T>) => boolean;
}

/** Minimal raw request contract; default client schemas are overridden per connection. */
export interface SSEClient<TContext = unknown> {
  request(url: string, config: NoSchemaRequestConfig<TContext>): Promise<unknown>;
}

export type SSEClientContext<Client> = Client extends HttpClient<infer TContext, any> ? TContext
  : Client extends SSEClient<infer TContext> ? TContext : unknown;

export function connectSSE<T, Client extends SSEClient<any>>(client: Client, url: string, options: ConnectSSEOptions<T, SSEClientContext<Client>> & SchemaStreamOptions<T>): AsyncIterable<SSEEvent<T>>;
export function connectSSE<T, Client extends SSEClient<any>>(client: Client, url: string, options: ConnectSSEOptions<T, SSEClientContext<Client>> & ParserStreamOptions<T>): AsyncIterable<SSEEvent<T>>;
export function connectSSE<Client extends SSEClient<any>>(client: Client, url: string, options?: Omit<ConnectSSEOptions<string, SSEClientContext<Client>>, 'schema' | 'parseJson'>): AsyncIterable<SSEEvent<string>>;
export function connectSSE<T>(client: SSEClient<any>, url: string, options: ConnectSSEOptions<T, any> = {}): AsyncIterable<SSEEvent<T>> {
  validateStreamOptions(options);
  const reconnect = options.reconnect;
  const method = (options.request?.method ?? 'GET').toUpperCase();
  if (reconnect) {
    if (!Number.isSafeInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 1) invalidConfig('reconnect.maxAttempts must be a positive safe integer');
    if (method !== 'GET') invalidConfig('SSE reconnection requires a GET request');
    for (const [name, value] of [['delay', reconnect.delay], ['maxDelay', reconnect.maxDelay]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) invalidConfig(`reconnect.${name} must be a finite non-negative number`);
    }
  }
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<SSEEvent<T>> {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signalReason(options.signal!));
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      const signal = controller.signal;
      const generator = (async function* () {
        const id = new AxiosHeaders(options.request?.headers).get('last-event-id');
        let lastId = typeof id === 'string' ? id : '';
        let delay = reconnect?.delay ?? 1000;
        try {
          for (let attempt = 1; attempt <= (reconnect?.maxAttempts ?? 1); attempt += 1) {
            signal.throwIfAborted();
            let failure: unknown;
            let failed = false;
            let applicationFailure = false;
            try {
              const headers = new AxiosHeaders(options.request?.headers).toHeaders();
              if (!headers.has('accept')) headers.set('accept', 'text/event-stream');
              if (lastId) headers.set('last-event-id', lastId);
              else headers.delete('last-event-id');
              // Disable ordinary request retries: an opened response stream has
              // its own explicit retry policy. A compatible raw client must not
              // consume/replace bodies in response interceptors.
              let accepted = false;
              const pending = Promise.resolve(client.request(url, {
                ...options.request, method, headers, signal, responseType: 'response',
                retry: 0, cache: false, schema: undefined, transformResponse: [],
                validateStatus: () => true,
              })).then((response) => {
                if (response instanceof Response && signal.aborted && !accepted) void response.body?.cancel(signal.reason).catch(() => undefined);
                return response;
              });
              const response = await raceWithSignal(pending, signal);
              accepted = true;
              if (!(response instanceof Response)) invalidConfig('connectSSE requires a client that returns an unconsumed raw Response');
              // HTTP 204 is an explicit server instruction to stop reconnecting.
              if (response.status === 204) { void response.body?.cancel().catch(() => undefined); return; }
              if (!response.ok) {
                void response.body?.cancel().catch(() => undefined);
                throw new HttpError('SSE connection returned an unsuccessful HTTP status', { code: 'ERR_BAD_RESPONSE', status: response.status, retryable: response.status >= 500 });
              }
              for await (const event of parseSSEWithState(response, { ...options, signal }, lastId, (state) => {
                lastId = state.id;
                if (state.retry !== undefined) delay = state.retry;
              })) {
                try {
                  if (options.isComplete?.(event)) return;
                } catch (error) { applicationFailure = true; throw error; }
                yield event;
              }
            } catch (error) {
              if (signal.aborted) throw signalReason(signal);
              if (applicationFailure || (isHttpError(error) && !error.retryable && error.code !== 'ERR_NETWORK')) throw error;
              failed = true;
              failure = error;
            }
            if (!reconnect || attempt === reconnect.maxAttempts || (!failed && !reconnect.retryOnEOF)) {
              if (failed) throw failure;
              return;
            }
            await sleep(Math.min(delay, reconnect.maxDelay ?? 30_000), signal);
          }
        } finally {
          options.signal?.removeEventListener('abort', onAbort);
        }
      })();
      return {
        next: (value?: unknown) => generator.next(value),
        async return(value?: unknown) {
          controller.abort(new DOMException('Stream iteration stopped', 'AbortError'));
          options.signal?.removeEventListener('abort', onAbort);
          return generator.return(value as never);
        },
        async throw(error?: unknown) {
          controller.abort(error);
          options.signal?.removeEventListener('abort', onAbort);
          return generator.throw(error);
        },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}
