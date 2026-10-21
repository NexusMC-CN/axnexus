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
export type StandardSchema<TOutput = unknown, TInput = unknown> = import('./schema.js').StandardSchema<TOutput, TInput>;
export type JsonStringifier = (value: unknown) => string;
export type RequestTransform = (data: unknown, headers: Headers) => unknown | Promise<unknown>;
export type ResponseTransform = (data: unknown, response: Response) => unknown | Promise<unknown>;
export type FetchPriority = 'high' | 'low' | 'auto';

export interface CacheOptions {
  ttl?: number;
  /** Session namespace required when caching requests that may carry ambient credentials. */
  partition?: string;
}

export interface RequestConfig<TContext = unknown> extends Omit<RequestInit, 'body' | 'cache' | 'headers' | 'method' | 'signal'> {
  /** Local request context; it is never automatically sent or added to cache keys. */
  context?: TContext;
  url?: string;
  method?: string;
  headers?: import('../headers/headers.js').HeaderInput;
  body?: BodyInit | null;
  data?: unknown;
  baseURL?: string;
  params?: QueryParams;
  timeout?: number;
  /** Enable automatic X-Request-Id generation for this request. Defaults to false. */
  requestId?: boolean | (() => string);
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
  /** Maximum response payload size in bytes; omitted means unlimited. Must be a non-negative safe integer. */
  maxBodySize?: number;
  rateLimit?: import('../transfer/rate-limiter.js').RateLimitOptions;
}

/** Request config exposed to request interceptors after header normalization. */
export type RequestInterceptorConfig<TContext = unknown> = Omit<RequestConfig<TContext>, 'headers'> & {
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

/** Request calls without a schema retain the explicit response-generic API. */
export type NoSchemaRequestConfig<TContext = unknown> = RequestConfig<TContext> & { schema?: undefined };
export type SchemaRequestConfig<TContext = unknown> = RequestConfig<TContext> & { schema: StandardSchema };

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type HasDefaultSchema<TDefaults> = 'schema' extends KeysOfUnion<TDefaults> ? true : false;
type DefaultSchema<TDefaults> = [TDefaults] extends [{ schema: infer TSchema extends StandardSchema }]
  ? TSchema
  : never;
type HasNoTransformMember<TConfig> = 'transformResponse' extends keyof TConfig
  ? Exclude<TConfig[keyof TConfig & 'transformResponse'], undefined> extends never
    ? true
    : Exclude<TConfig[keyof TConfig & 'transformResponse'], undefined> extends readonly [] ? true : false
  : true;
type HasNoTransform<TConfig> = false extends (TConfig extends unknown ? HasNoTransformMember<TConfig> : never) ? false : true;
type HasNoEffectiveTransform<TConfig, TDefaults> = TConfig extends { transformResponse: infer TTransform }
  ? [TTransform] extends [undefined]
    ? HasNoTransform<TDefaults>
    : TTransform extends readonly [] ? true : false
  : HasNoTransform<TConfig> extends true ? HasNoTransform<TDefaults> : false;

/** A schema is applied before transforms; transformed outputs are deliberately unknown. */
export type SchemaResponseData<TConfig extends { schema: StandardSchema }, TDefaults = {}> =
  HasNoEffectiveTransform<TConfig, TDefaults> extends true
    ? import('./schema.js').InferSchemaOutput<TConfig['schema']> | null
    : unknown;
export type DefaultSchemaResponseData<TConfig, TDefaults> =
  'schema' extends KeysOfUnion<TConfig> ? unknown : HasNoEffectiveTransform<TConfig, TDefaults> extends true
    ? [DefaultSchema<TDefaults>] extends [never] ? unknown : import('./schema.js').InferSchemaOutput<DefaultSchema<TDefaults>> | null
    : unknown;

interface DataRequest<TContext, TDefaults> {
  <const TConfig extends SchemaRequestConfig<TContext>>(config: TConfig): Promise<SchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends SchemaRequestConfig<TContext>>(url: string, config: TConfig): Promise<SchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}>(config: HasDefaultSchema<TDefaults> extends true ? TConfig : never): Promise<DefaultSchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config?: TConfig] : [config: never]): Promise<DefaultSchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends RequestConfig<TContext>>(config: TConfig): Promise<unknown>;
  <const TConfig extends RequestConfig<TContext>>(url: string, config: TConfig): Promise<unknown>;
  <T = unknown>(config: HasDefaultSchema<TDefaults> extends true ? never : NoSchemaRequestConfig<TContext>): Promise<T>;
  <T = unknown>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config: never] : [config?: NoSchemaRequestConfig<TContext>]): Promise<T>;
}

interface ResponseRequest<TContext, TDefaults> {
  <const TConfig extends SchemaRequestConfig<TContext>>(config: TConfig): Promise<HttpResponse<SchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends SchemaRequestConfig<TContext>>(url: string, config: TConfig): Promise<HttpResponse<SchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}>(config: HasDefaultSchema<TDefaults> extends true ? TConfig : never): Promise<HttpResponse<DefaultSchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config?: TConfig] : [config: never]): Promise<HttpResponse<DefaultSchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends RequestConfig<TContext>>(config: TConfig): Promise<HttpResponse<unknown>>;
  <const TConfig extends RequestConfig<TContext>>(url: string, config: TConfig): Promise<HttpResponse<unknown>>;
  <T = unknown>(config: HasDefaultSchema<TDefaults> extends true ? never : NoSchemaRequestConfig<TContext>): Promise<HttpResponse<T>>;
  <T = unknown>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config: never] : [config?: NoSchemaRequestConfig<TContext>]): Promise<HttpResponse<T>>;
}

interface DataMethod<TContext, TDefaults> {
  <const TConfig extends SchemaRequestConfig<TContext>>(url: string, config: TConfig): Promise<SchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config?: TConfig] : [config: never]): Promise<DefaultSchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends RequestConfig<TContext>>(url: string, config: TConfig): Promise<unknown>;
  <T = unknown>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config: never] : [config?: NoSchemaRequestConfig<TContext>]): Promise<T>;
}

interface ResponseMethod<TContext, TDefaults> {
  <const TConfig extends SchemaRequestConfig<TContext>>(url: string, config: TConfig): Promise<HttpResponse<SchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config?: TConfig] : [config: never]): Promise<HttpResponse<DefaultSchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends RequestConfig<TContext>>(url: string, config: TConfig): Promise<HttpResponse<unknown>>;
  <T = unknown>(url: string, ...args: HasDefaultSchema<TDefaults> extends true ? [config: never] : [config?: NoSchemaRequestConfig<TContext>]): Promise<HttpResponse<T>>;
}

interface DataBodyMethod<TContext, TDefaults> {
  <const TConfig extends SchemaRequestConfig<TContext>, B = unknown>(url: string, data: B | undefined, config: TConfig): Promise<SchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}, B = unknown>(url: string, data?: B, ...args: HasDefaultSchema<TDefaults> extends true ? [config?: TConfig] : [config: never]): Promise<DefaultSchemaResponseData<TConfig, TDefaults>>;
  <const TConfig extends RequestConfig<TContext>, B = unknown>(url: string, data: B | undefined, config: TConfig): Promise<unknown>;
  <T = unknown, B = unknown>(url: string, data?: B, ...args: HasDefaultSchema<TDefaults> extends true ? [config: never] : [config?: NoSchemaRequestConfig<TContext>]): Promise<T>;
}

interface ResponseBodyMethod<TContext, TDefaults> {
  <const TConfig extends SchemaRequestConfig<TContext>, B = unknown>(url: string, data: B | undefined, config: TConfig): Promise<HttpResponse<SchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends NoSchemaRequestConfig<TContext> = {}, B = unknown>(url: string, data?: B, ...args: HasDefaultSchema<TDefaults> extends true ? [config?: TConfig] : [config: never]): Promise<HttpResponse<DefaultSchemaResponseData<TConfig, TDefaults>>>;
  <const TConfig extends RequestConfig<TContext>, B = unknown>(url: string, data: B | undefined, config: TConfig): Promise<HttpResponse<unknown>>;
  <T = unknown, B = unknown>(url: string, data?: B, ...args: HasDefaultSchema<TDefaults> extends true ? [config: never] : [config?: NoSchemaRequestConfig<TContext>]): Promise<HttpResponse<T>>;
}

export interface HttpClient<TContext = unknown, TDefaults = {}> {
  request: DataRequest<TContext, TDefaults>;
  requestResponse: ResponseRequest<TContext, TDefaults>;
  get: DataMethod<TContext, TDefaults>;
  getResponse: ResponseMethod<TContext, TDefaults>;
  head: DataMethod<TContext, TDefaults>;
  headResponse: ResponseMethod<TContext, TDefaults>;
  options: DataMethod<TContext, TDefaults>;
  optionsResponse: ResponseMethod<TContext, TDefaults>;
  trace: DataMethod<TContext, TDefaults>;
  traceResponse: ResponseMethod<TContext, TDefaults>;
  connect: DataMethod<TContext, TDefaults>;
  connectResponse: ResponseMethod<TContext, TDefaults>;
  delete: DataMethod<TContext, TDefaults>;
  deleteResponse: ResponseMethod<TContext, TDefaults>;
  post: DataBodyMethod<TContext, TDefaults>;
  postResponse: ResponseBodyMethod<TContext, TDefaults>;
  put: DataBodyMethod<TContext, TDefaults>;
  putResponse: ResponseBodyMethod<TContext, TDefaults>;
  patch: DataBodyMethod<TContext, TDefaults>;
  patchResponse: ResponseBodyMethod<TContext, TDefaults>;
  clearCache(): void;
  /** Release client plugin and transport resources. */
  close(): void | Promise<void>;
  use(plugin: import('../plugins/types.js').HttpPlugin<TContext>): () => Promise<void>;
  interceptors: {
    request: import('./interceptors.js').RequestInterceptorManager<TContext>;
    response: import('./interceptors.js').InterceptorManager<HttpResponse<unknown>>;
  };
}

export interface HttpClientConfig<TContext = unknown> extends Omit<RequestConfig<TContext>, 'method' | 'body' | 'data' | 'params'> {
  plugins?: readonly import('../plugins/types.js').HttpPlugin<TContext>[];
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
