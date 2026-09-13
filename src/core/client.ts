import { GetRequestCache } from '../cache/get-cache.js';
import { RateLimiter } from '../transfer/rate-limiter.js';
import { createInterceptorManager, createRequestInterceptorManager } from './interceptors.js';
import { buildFetchAdapter, createRequestId } from './config.js';
import { runRequestPipeline, type RequestPipelineDeps } from './pipeline.js';
import type { HttpClient, HttpClientConfig, HttpResponse, RequestConfig } from './types.js';

export function createHttpClient(options: HttpClientConfig = {}): HttpClient {
  const defaults: HttpClientConfig = {
    credentials: 'include',
    requestId: true,
    ...options,
  };
  const adapter = defaults.adapter || buildFetchAdapter();
  const requestInterceptors = createRequestInterceptorManager();
  const responseInterceptors = createInterceptorManager<HttpResponse<unknown>>();
  const cache = new GetRequestCache(createRequestId());
  const rateLimiter = new RateLimiter(defaults.rateLimit ?? {});
  const pipelineDeps: RequestPipelineDeps = {
    defaults,
    adapter,
    requestInterceptors,
    responseInterceptors,
    cache,
    rateLimiter,
  };

  const requestInternal = <T>(input: RequestConfig, fullResponse: boolean): Promise<T | HttpResponse<T>> =>
    runRequestPipeline<T>(input, fullResponse, pipelineDeps);

  const normalizePublicConfig = (input: RequestConfig | string, config?: RequestConfig): RequestConfig =>
    typeof input === 'string' ? { ...(config ?? {}), url: input } : input;
  const request = <T>(input: RequestConfig | string, config?: RequestConfig): Promise<T> =>
    requestInternal<T>(normalizePublicConfig(input, config), false) as Promise<T>;
  const requestResponse = <T>(input: RequestConfig | string, config?: RequestConfig): Promise<HttpResponse<T>> =>
    requestInternal<T>(normalizePublicConfig(input, config), true) as Promise<HttpResponse<T>>;

  const client: HttpClient = {
    request,
    requestResponse,
    get: (url, config = {}) => request({ ...config, url, method: 'GET' }),
    getResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'GET' }),
    head: (url, config = {}) => request({ ...config, url, method: 'HEAD' }),
    headResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'HEAD' }),
    options: (url, config = {}) => request({ ...config, url, method: 'OPTIONS' }),
    optionsResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'OPTIONS' }),
    trace: (url, config = {}) => request({ ...config, url, method: 'TRACE' }),
    traceResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'TRACE' }),
    connect: (url, config = {}) => request({ ...config, url, method: 'CONNECT' }),
    connectResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'CONNECT' }),
    post: (url, data, config = {}) => request({ ...config, url, method: 'POST', data }),
    postResponse: (url, data, config = {}) => requestResponse({ ...config, url, method: 'POST', data }),
    put: (url, data, config = {}) => request({ ...config, url, method: 'PUT', data }),
    putResponse: (url, data, config = {}) => requestResponse({ ...config, url, method: 'PUT', data }),
    patch: (url, data, config = {}) => request({ ...config, url, method: 'PATCH', data }),
    patchResponse: (url, data, config = {}) => requestResponse({ ...config, url, method: 'PATCH', data }),
    delete: (url, config = {}) => request({ ...config, url, method: 'DELETE' }),
    deleteResponse: (url, config = {}) => requestResponse({ ...config, url, method: 'DELETE' }),
    clearCache: () => cache.clear(),
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
  };
  return client;
}
