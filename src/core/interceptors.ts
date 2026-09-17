import { AxiosHeaders } from '../headers/headers.js';
import { mergeMethodHeaders } from '../headers/methods.js';
import type { InterceptorFulfilled, InterceptorRejected, RequestConfig, RequestInterceptorConfig } from './types.js';

interface Handler<T> {
  fulfilled?: InterceptorFulfilled<T>;
  rejected?: InterceptorRejected<T>;
}

export class InterceptorManager<T> {
  private readonly handlers: Array<Handler<T> | null> = [];

  use(fulfilled?: InterceptorFulfilled<T>, rejected?: InterceptorRejected<T>): number {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }

  eject(id: number): void {
    if (id >= 0 && id < this.handlers.length) this.handlers[id] = null;
  }

  getHandlers(reverse = false): Handler<T>[] {
    const active = this.handlers.filter((handler): handler is Handler<T> => handler !== null);
    return reverse ? active.reverse() : active;
  }
}

function normalizeRequestConfig(config: RequestConfig, base?: RequestConfig): RequestConfig {
  const method = String(config.method || 'GET').toUpperCase();
  const headers = config.headers instanceof AxiosHeaders
    ? config.headers
    : mergeMethodHeaders(base?.headers as never, method, config.headers);
  return { ...config, headers };
}

/**
 * Request interceptors always receive AxiosHeaders, while accepting native
 * Headers and plain header objects when a callback returns a new config.
 */
export class RequestInterceptorManager extends InterceptorManager<RequestConfig> {
  override use(
    fulfilled?: (value: RequestInterceptorConfig) => RequestConfig | Promise<RequestConfig>,
    rejected?: (error: unknown) => RequestConfig | Promise<RequestConfig>,
  ): number {
    const normalizedFulfilled = fulfilled
      ? async (value: RequestConfig): Promise<RequestConfig> => {
        const normalized = normalizeRequestConfig(value);
        const next = await fulfilled(normalized as RequestInterceptorConfig);
        return normalizeRequestConfig(next, normalized);
      }
      : undefined;
    const normalizedRejected = rejected
      ? async (error: unknown): Promise<RequestConfig> => normalizeRequestConfig(await rejected(error))
      : undefined;
    return super.use(normalizedFulfilled, normalizedRejected);
  }
}

export function createInterceptorManager<T>(): InterceptorManager<T> {
  return new InterceptorManager<T>();
}

export function createRequestInterceptorManager(): RequestInterceptorManager {
  return new RequestInterceptorManager();
}

export async function applyInterceptorChain<T>(
  manager: InterceptorManager<T>,
  value: T,
  options: { reverse?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const handlers = manager.getHandlers(options.reverse);
  const { signal } = options;
  // Racing the chain only settles the caller's promise; handlers already
  // queued would still run. Stop before starting work for a request that has
  // been cancelled.
  const guard = (): void => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  };
  let chain: Promise<T> = Promise.resolve(value) as Promise<T>;
  for (const handler of handlers) {
    // The guard must cover the rejected path as well: a recovering handler
    // would otherwise resurrect a request whose signal has already aborted.
    chain = chain.then(
      (current) => {
        guard();
        return Promise.resolve(handler.fulfilled ? handler.fulfilled(current) : current);
      },
      handler.rejected
        ? (error: unknown) => {
          guard();
          return Promise.resolve(handler.rejected!(error));
        }
        : undefined,
    );
  }
  return chain;
}

/** Runs a response chain from a rejected promise, allowing rejected handlers to recover. */
export async function applyInterceptorErrorChain<T>(
  manager: InterceptorManager<T>,
  error: unknown,
  options: { reverse?: boolean } = {},
): Promise<T> {
  const handlers = manager.getHandlers(options.reverse);
  // Avoid creating a detached Promise.reject when there is no error handler.
  // The async function's own rejection is the only promise the caller needs
  // to observe, which prevents cancellation paths from producing an
  // unhandled-rejection warning in Node.
  if (handlers.length === 0) throw error;
  let chain: Promise<T> = Promise.reject(error) as Promise<T>;
  for (const handler of handlers) {
    chain = chain.then(handler.fulfilled, handler.rejected);
  }
  return chain;
}
