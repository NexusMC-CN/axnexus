export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response';

export type HttpProtocol = 'h1' | 'h2' | 'h3' | 'unknown';

export interface ResponseTimings {
  queuedAt?: number;
  startedAt?: number;
  headersAt?: number;
  completedAt?: number;
  duration?: number;
  uploadDuration?: number;
  downloadDuration?: number;
}

export interface AdapterMetadata {
  protocol?: HttpProtocol;
  timings?: ResponseTimings;
}

export interface AdapterResult {
  response: Response;
  metadata?: AdapterMetadata;
}

export type QueryValue = string | number | boolean | Date;
export type QueryParams = Record<string, QueryValue | QueryValue[] | null | undefined>;

export type RetryDelay = number | ((attempt: number, error: Error) => number);

export interface CacheOptions {
  ttl?: number;
}

export interface RequestConfig extends Omit<RequestInit, 'body' | 'cache' | 'headers' | 'method' | 'signal'> {
  url?: string;
  method?: string;
  headers?: HeadersInit | import('../headers/methods.js').HeaderDefaults | import('../headers/headers.js').AxiosHeaders;
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
  onUploadProgress?: import('../transfer/progress.js').ProgressListener;
  onDownloadProgress?: import('../transfer/progress.js').ProgressListener;
  progressInterval?: number;
  maxBodySize?: number;
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
  headers: import('../headers/headers.js').AxiosHeaders;
  config: ResolvedRequestConfig;
  raw: Response;
  protocol: HttpProtocol;
  timings: ResponseTimings;
}

export type HttpAdapter = (config: ResolvedRequestConfig) => Promise<Response | AdapterResult>;

export type InterceptorFulfilled<T> = (value: T) => T | Promise<T>;
export type InterceptorRejected<T> = (error: unknown) => T | Promise<T>;

export interface HttpClient {
  request<T = unknown>(config: RequestConfig): Promise<T>;
  requestResponse<T = unknown>(config: RequestConfig): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  getResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  post<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  postResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>;
  put<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  putResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>;
  patch<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  patchResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  deleteResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  clearCache(): void;
  interceptors: {
    request: import('./interceptors.js').InterceptorManager<RequestConfig>;
    response: import('./interceptors.js').InterceptorManager<HttpResponse<unknown>>;
  };
}

export interface HttpClientConfig extends Omit<RequestConfig, 'method' | 'body' | 'data' | 'params'> {
  baseURL?: string;
  headers?: HeadersInit | import('../headers/methods.js').HeaderDefaults | import('../headers/headers.js').AxiosHeaders;
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
