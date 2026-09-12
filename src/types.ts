export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response';

export type QueryValue = string | number | boolean | Date;
export type QueryParams = Record<string, QueryValue | QueryValue[] | null | undefined>;

export type RetryDelay = number | ((attempt: number, error: Error) => number);

export interface CacheOptions {
  ttl?: number;
}

export interface RequestConfig extends Omit<RequestInit, 'body' | 'cache' | 'headers' | 'method' | 'signal'> {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  data?: unknown;
  baseURL?: string;
  params?: QueryParams;
  timeout?: number;
  signal?: AbortSignal;
  retry?: number;
  retryDelay?: RetryDelay;
  retryOn?: number[];
  retryUnsafeMethods?: boolean;
  cache?: boolean | CacheOptions;
  bypassCache?: boolean;
  responseType?: ResponseType;
  allowAbsoluteURL?: boolean;
}

export interface ResolvedRequestConfig extends RequestConfig {
  method: string;
  url: string;
  headers: Headers;
  body?: BodyInit | null;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
  config: ResolvedRequestConfig;
  raw: Response;
}

export type HttpAdapter = (config: ResolvedRequestConfig) => Promise<Response>;

export type InterceptorFulfilled<T> = (value: T) => T | Promise<T>;
export type InterceptorRejected<T> = (error: unknown) => T | Promise<T>;

export interface HttpClient {
  request<T = unknown>(config: RequestConfig): Promise<T>;
  get<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  post<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  put<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  patch<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  delete<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  clearCache(): void;
  interceptors: {
    request: import('./interceptors.js').InterceptorManager<RequestConfig>;
    response: import('./interceptors.js').InterceptorManager<HttpResponse<unknown>>;
  };
}

export interface HttpClientConfig extends Omit<RequestConfig, 'method' | 'body' | 'data' | 'params'> {
  baseURL?: string;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  timeout?: number;
  retry?: number;
  retryDelay?: RetryDelay;
  retryOn?: number[];
  retryUnsafeMethods?: boolean;
  adapter?: HttpAdapter;
  cache?: CacheOptions;
  requestId?: boolean | (() => string);
  onRequestError?: (error: import('./errors.js').HttpError) => void;
}
