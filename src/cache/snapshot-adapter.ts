import type { AdapterMetadata, HttpAdapter } from '../core/types.js';
import { raceWithSignal, signalReason } from '../core/control.js';
import { cancelBody, readResponse, responseBodyIsDecoded, markResponseDecoded } from '../utils/response.js';
import type { GetRequestCache } from './get-cache.js';
import type { CachePolicy } from './policy.js';

interface ResponseSnapshot {
  body?: ArrayBuffer;
  decoded: boolean;
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  redirected: boolean;
  type: ResponseType;
  metadata?: AdapterMetadata;
}

/** Share only network bytes. Parsing, retries and user hooks belong to each caller. */
export function snapshotAdapter(adapter: HttpAdapter, cache: GetRequestCache, policy: CachePolicy, release?: () => void): HttpAdapter {
  return async (config) => {
    const snapshot = await cache.getOrLoad<ResponseSnapshot>(policy.key!, policy.ttl, async (signal) => {
      // The shared request must never inherit the first subscriber's abort controller.
      const pending = Promise.resolve().then(() => {
        if (signal.aborted) throw signalReason(signal);
        return adapter({ ...config, signal });
      });
      pending.then(output => {
        if (signal.aborted) cancelBody(output instanceof Response ? output : output.response, signal.reason);
      }, () => undefined);
      try {
        const output = await raceWithSignal(pending, signal);
        const response = output instanceof Response ? output : output.response;
        const body = await readResponse(response, 'arrayBuffer', undefined, undefined, signal) as ArrayBuffer | undefined;
        return {
          body,
          decoded: responseBodyIsDecoded(response),
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries()),
          url: response.url,
          redirected: response.redirected,
          type: response.type,
          metadata: output instanceof Response ? undefined : output.metadata,
        };
      } finally {
        release?.();
      }
    }, {
      signal: config.signal,
      shouldStore: value => {
        const entry = value as ResponseSnapshot;
        const headers = new Headers(entry.headers);
        return entry.status >= 200 && entry.status < 300
          && !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(headers.get('cache-control') ?? '')
          && !(headers.get('vary') ?? '').split(',').some(value => value.trim() === '*');
      },
    });
    const response = snapshot.status === 0 ? Response.error() : new Response(snapshot.body, {
      status: snapshot.status,
      statusText: snapshot.statusText,
      headers: snapshot.headers,
    });
    if (snapshot.decoded) markResponseDecoded(response);
    for (const key of ['url', 'redirected', 'type'] as const) {
      Object.defineProperty(response, key, { value: snapshot[key], configurable: true });
    }
    return { response, metadata: snapshot.metadata };
  };
}
