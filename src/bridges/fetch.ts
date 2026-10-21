import { createHttpClient } from '../core/client.js';
import type { HttpClientConfig, RequestConfig } from '../core/types.js';
import { mergeMethodHeaders } from '../headers/methods.js';

/** Transport policies accepted by the dedicated, raw-response Fetch client. */
export type FetchHandlerOptions = Pick<HttpClientConfig,
  | 'adapter' | 'headers' | 'timeout' | 'totalTimeout' | 'dispatcher' | 'agent'
  | 'maxBodySize' | 'rateLimit' | 'onUploadProgress' | 'onDownloadProgress' | 'progressInterval'
>;

export type FetchHandler = typeof globalThis.fetch & {
  /** Release long-lived transports owned by this handler. */
  close(): void | Promise<void>;
};

let requestCopyTransfersBody: boolean | undefined;

function copiesTransferBody(): boolean {
  if (requestCopyTransfersBody !== undefined) return requestCopyTransfersBody;
  // Detect Request implementations that clone rather than transfer a source
  // body. This uses an empty local payload and never performs network I/O.
  const source = new Request('https://axnexus.invalid/', { method: 'POST', body: '' });
  const copy = new Request(source);
  requestCopyTransfersBody = source.bodyUsed || Boolean(source.body?.locked);
  void copy.body?.cancel().catch(() => undefined);
  if (!source.bodyUsed) void source.body?.cancel().catch(() => undefined);
  return requestCopyTransfersBody;
}

/**
 * Adapt axnexus transport policies to injectable Fetch clients such as oRPC.
 * A dedicated client prevents response schemas, transforms, and interceptors
 * from consuming the protocol's body. HTTP status handling belongs to the caller.
 * Transport failures retain axnexus HttpError classification.
 */
export function createFetchHandler(options: FetchHandlerOptions = {}): FetchHandler {
  // Copy only the public allowlist, including for untyped JavaScript callers.
  const { adapter, timeout, totalTimeout, dispatcher, agent, maxBodySize,
    rateLimit, onUploadProgress, onDownloadProgress, progressInterval } = options;
  const client = createHttpClient({ adapter, timeout, totalTimeout, dispatcher, agent,
    maxBodySize, rateLimit, onUploadProgress, onDownloadProgress, progressInterval,
    responseType: 'response', validateStatus: () => true, retry: 0, cache: false });
  const handler: typeof globalThis.fetch = async (input, init) => {
    const source = input instanceof Request ? input : undefined;
    // Null, like an omitted body, inherits a Request's body. An explicit new
    // body may replace a consumed source, matching native Fetch semantics.
    const inheritedBody = init?.body == null ? source?.body : undefined;
    if (inheritedBody && (source!.bodyUsed || inheritedBody.locked)) {
      throw new TypeError('Request body has already been consumed or locked');
    }
    // Explicit stream transfer avoids cloning on nonstandard implementations;
    // native ownership transfer, including its validation, remains unchanged.
    const request = new Request(input, inheritedBody && !copiesTransferBody()
      ? { ...init, body: inheritedBody, duplex: 'half' } as RequestInit : init);
    // Merge into a new store for this method. Flattening grouped defaults up
    // front would leak write-only credentials into unrelated request methods.
    const headers = mergeMethodHeaders(options.headers, request.method, request.headers);
    // Avoid adding axnexus' JSON Accept default to a Fetch request.
    if (!headers.has('Accept')) headers.set('Accept', false);
    const config: RequestConfig & { schema?: undefined } = {
      url: request.url,
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      // Preserve explicit policy values even on runtimes whose Request copy
      // constructor drops otherwise valid RequestInit fields.
      credentials: init?.credentials ?? request.credentials,
      mode: init?.mode ?? request.mode,
      redirect: init?.redirect ?? request.redirect,
      referrer: init?.referrer ?? request.referrer,
      referrerPolicy: init?.referrerPolicy ?? request.referrerPolicy,
      integrity: init?.integrity ?? request.integrity,
      keepalive: init?.keepalive ?? request.keepalive,
      fetchCache: init?.cache ?? request.cache,
      duplex: request.body ? 'half' : undefined,
      ...(init?.window === undefined ? {} : { window: init.window }),
      ...(init && 'priority' in init ? { priority: (init as RequestConfig).priority } : {}),
      responseType: 'response', validateStatus: () => true, retry: 0, cache: false,
    };
    return client.request<Response>(config);
  };
  return Object.assign(handler, { close: () => client.close() });
}
