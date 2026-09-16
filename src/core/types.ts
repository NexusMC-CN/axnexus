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

export type RetryDelay = number | ((attempt: number, error: import('./errors.js').HttpError) => number);

export interface RetryContext {
  error: import('./errors.js').HttpError;
  retryCount: number;
  delay: number;
}

export interface RetryOptions {
  limit?: number;
  methods?: string[];
  statusCodes?: number[];
  errorCodes?: string[];
  delay?: number | ((attempt: number, error: import('./errors.js').HttpError) => number);
  jitter?: boolean | ((delay: number, attempt: number, error: import('./errors.js').HttpError) => number);
  maxDelay?: number;
  respectRetryAfter?: boolean;
  shouldRetry?: (context: RetryContext) => boolean | Promise<boolean>;
  beforeRetry?: (context: RetryContext) => void | Promise<void>;
}

export type JsonParser = (text: string) => unknown | Promise<unknown>;
export type StandardSchema<T = unknown> = import('./schema.js').StandardSchema<T>;
export type JsonStringifier = (value: unknown) => string;
export type RequestTransform = (data: unknown, headers: Headers) => unknown | Promise<unknown>;
export type ResponseTransform = (data: unknown, response: Response) => unknown | Promise<unknown>;
export type FetchPriority = 'high' | 'low' | 'auto';

export interface CacheOptions {
  ttl?: number;
}

export interface RequestConfig extends Omit<RequestInit, 'body' | 'cache' | 'headers' | 'method' | 'signal'> {
  url?: string;
  method?: string;
  headers?: import('../headers/headers.js').HeaderInput;
  body?: BodyInit | null;
  data?: unknown;
  baseURL?: string;
  params?: QueryParams;
  timeout?: number;
  signal?: AbortSignal;
  retry?: number | RetryOptions;
  retryDelay?: RetryDelay;
  retryOn?: number[];
  retryUnsafeMethods?: boolean;
  validateStatus?: (status: number) => boolean;
  throwHttpErrors?: boolean | ((status: number) => boolean);
  totalTimeout?: number;
  parseJson?: JsonParser;
  schema?: StandardSchema;
  stringifyJson?: JsonStringifier;
  transformRequest?: RequestTransform | RequestTransform[];
  transformResponse?: ResponseTransform | ResponseTransform[];
  cache?: boolean | CacheOptions;
  /** Native Fetch cache mode; `cache` remains the client data-cache policy. */
  fetchCache?: RequestCache;
  /** Alias for `fetchCache` when mirroring a RequestInit-shaped config. */
  requestCache?: RequestCache;
  /** Node/Fetch implementation-specific transport options. */
  dispatcher?: unknown;
  agent?: unknown;
  priority?: FetchPriority;
  duplex?: 'half';
  bypassCache?: boolean;
  responseType?: ResponseType;
  allowAbsoluteURL?: boolean;
  onUploadProgress?: import('../transfer/progress.js').ProgressListener;
  onDownloadProgress?: import('../transfer/progress.js').ProgressListener;
  progressInterval?: number;
  /** Maximum response payload size in bytes; omitted/invalid values mean unlimited. */
  maxBodySize?: number;
  rateLimit?: import('../transfer/rate-limiter.js').RateLimitOptions;
}

/** Request config exposed to request interceptors after header normalization. */
export type RequestInterceptorConfig = Omit<RequestConfig, 'headers'> & {
  headers: import('../headers/headers.js').AxiosHeaders;
};

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

export type HttpAdapter = ((config: ResolvedRequestConfig) => Promise<Response | AdapterResult>) & {
  /**
   * Optional: release transport resources (and cancellation listeners) that the
   * adapter keeps for the request currently being processed.
   */
  releaseStream?: () => void;
  /** Optional: close long-lived transports (for example HTTP/2 sessions). */
  closeTransport?: () => void | Promise<void>;
};

export type InterceptorFulfilled<T> = (value: T) => T | Promise<T>;
export type InterceptorRejected<T> = (error: unknown) => T | Promise<T>;

export interface HttpClient {
  request<T = unknown>(config: RequestConfig): Promise<T>;
  request<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  requestResponse<T = unknown>(config: RequestConfig): Promise<HttpResponse<T>>;
  requestResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  getResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  head<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  headResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  options<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  optionsResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  trace<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  traceResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  connect<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  connectResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  post<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  postResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>;
  put<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  putResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>;
  patch<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<T>;
  patchResponse<T = unknown, B = unknown>(url: string, data?: B, config?: RequestConfig): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  deleteResponse<T = unknown>(url: string, config?: RequestConfig): Promise<HttpResponse<T>>;
  clearCache(): void;
  /**
   * Release transports the adapter holds open (for example HTTP/2 sessions).
   * Without this an idle session can keep a one-shot process alive.
   */
  close(): void | Promise<void>;
  interceptors: {
    request: import('./interceptors.js').RequestInterceptorManager;
    response: import('./interceptors.js').InterceptorManager<HttpResponse<unknown>>;
  };
}

export interface HttpClientConfig extends Omit<RequestConfig, 'method' | 'body' | 'data' | 'params'> {
  baseURL?: string;
  headers?: import('../headers/headers.js').HeaderInput;
  credentials?: RequestCredentials;
  timeout?: number;
  retry?: number | RetryOptions;
  retryDelay?: RetryDelay;
  retryOn?: number[];
  retryUnsafeMethods?: boolean;
  validateStatus?: (status: number) => boolean;
  throwHttpErrors?: boolean | ((status: number) => boolean);
  totalTimeout?: number;
  parseJson?: JsonParser;
  schema?: StandardSchema;
  stringifyJson?: JsonStringifier;
  transformRequest?: RequestTransform | RequestTransform[];
  transformResponse?: ResponseTransform | ResponseTransform[];
  adapter?: HttpAdapter;
  cache?: boolean | CacheOptions;
  requestId?: boolean | (() => string);
  rateLimit?: import('../transfer/rate-limiter.js').RateLimitOptions;
  onRequestError?: (error: import('./errors.js').HttpError) => void;
}
