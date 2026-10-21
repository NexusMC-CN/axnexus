import { GetRequestCache } from '../cache/get-cache.js';
import { RateLimiter } from '../transfer/rate-limiter.js';
import { createInterceptorManager, createRequestInterceptorManager } from './interceptors.js';
import { buildFetchAdapter, createRequestId } from './config.js';
import { runRequestPipeline, type RequestPipelineDeps } from './pipeline.js';
import { validateRequestOptions } from './configuration/validation.js';
import { createPluginRuntime } from '../plugins/runtime.js';
import { registerClientLifecyclePolicy } from './lifecycle/client-policy.js';
import type { HttpAdapter, HttpClient, HttpClientConfig, HttpResponse, RequestConfig } from './types.js';

export function createHttpClient<TContext = unknown>(): HttpClient<TContext, {}>;
export function createHttpClient<TContext = unknown, const TDefaults extends HttpClientConfig<TContext> = HttpClientConfig<TContext>>(options: TDefaults): HttpClient<TContext, TDefaults>;
export function createHttpClient(options: HttpClientConfig = {}): HttpClient {
  validateRequestOptions(options);
  const defaults: HttpClientConfig = {
    credentials: 'same-origin',
    requestId: false,
    ...options,
  };
  const adapter = defaults.adapter || buildFetchAdapter();
  const requestInterceptors = createRequestInterceptorManager();
  const responseInterceptors = createInterceptorManager<HttpResponse<unknown>>();
  const cache = new GetRequestCache(createRequestId());
  const rateLimiter = new RateLimiter(defaults.rateLimit ?? {});
  const plugins = createPluginRuntime(() => client);
  let closing: Promise<void> | undefined;
  // Adapters that manage long-lived transports (HTTP/2 sessions) can expose a
  // per-request release hook so a completed request drops its abort listener.
  const releaseAdapterStream = () => adapter.releaseStream?.();
  const pipelineDeps: RequestPipelineDeps = {
    defaults,
    adapter,
    requestInterceptors,
    responseInterceptors,
    cache,
    rateLimiter,
    releaseAdapterStream,
    events: plugins,
  };

  const requestInternal = async <T>(input: RequestConfig, fullResponse: boolean): Promise<T | HttpResponse<T>> => {
    validateRequestOptions(input);
    return runRequestPipeline<T>(input, fullResponse, pipelineDeps);
  };

  const normalizePublicConfig = (input: RequestConfig | string, config?: RequestConfig): RequestConfig =>
    typeof input === 'string' ? { ...(config ?? {}), url: input } : input;
  const request = <T>(input: RequestConfig | string, config?: RequestConfig): Promise<T> =>
    requestInternal<T>(normalizePublicConfig(input, config), false) as Promise<T>;
  const requestResponse = <T>(input: RequestConfig | string, config?: RequestConfig): Promise<HttpResponse<T>> =>
    requestInternal<T>(normalizePublicConfig(input, config), true) as Promise<HttpResponse<T>>;

  const client = {
    request,
    requestResponse,
    get: (url: string, config: RequestConfig = {}) => request({ ...config, url, method: 'GET' }),
    getResponse: (url: string, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'GET' }),
    head: (url: string, config: RequestConfig = {}) => request({ ...config, url, method: 'HEAD' }),
    headResponse: (url: string, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'HEAD' }),
    options: (url: string, config: RequestConfig = {}) => request({ ...config, url, method: 'OPTIONS' }),
    optionsResponse: (url: string, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'OPTIONS' }),
    trace: (url: string, config: RequestConfig = {}) => request({ ...config, url, method: 'TRACE' }),
    traceResponse: (url: string, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'TRACE' }),
    connect: (url: string, config: RequestConfig = {}) => request({ ...config, url, method: 'CONNECT' }),
    connectResponse: (url: string, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'CONNECT' }),
    post: (url: string, data?: unknown, config: RequestConfig = {}) => request({ ...config, url, method: 'POST', data }),
    postResponse: (url: string, data?: unknown, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'POST', data }),
    put: (url: string, data?: unknown, config: RequestConfig = {}) => request({ ...config, url, method: 'PUT', data }),
    putResponse: (url: string, data?: unknown, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'PUT', data }),
    patch: (url: string, data?: unknown, config: RequestConfig = {}) => request({ ...config, url, method: 'PATCH', data }),
    patchResponse: (url: string, data?: unknown, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'PATCH', data }),
    delete: (url: string, config: RequestConfig = {}) => request({ ...config, url, method: 'DELETE' }),
    deleteResponse: (url: string, config: RequestConfig = {}) => requestResponse({ ...config, url, method: 'DELETE' }),
    clearCache: () => cache.clear(),
    use: plugins.use,
    close: () => closing ??= (async () => {
      try { await plugins.close(); }
      finally { await adapter.closeTransport?.(); }
    })(),
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
  } as unknown as HttpClient;
  registerClientLifecyclePolicy(client, defaults);
  try {
    for (const plugin of defaults.plugins ?? []) plugins.use(plugin);
  } catch (error) {
    void client.close()?.catch(() => undefined);
    throw error;
  }
  return client;
}
