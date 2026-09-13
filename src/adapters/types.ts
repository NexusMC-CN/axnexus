import type { AdapterResult, ResolvedRequestConfig } from '../core/types.js';

export type { AdapterMetadata, AdapterResult } from '../core/types.js';

export type AdapterCapability = 'fetch' | 'xhr' | 'http2' | 'http3';

export type AdapterConfig = ResolvedRequestConfig & {
  onUploadProgress?: import('../transfer/progress.js').ProgressListener;
  onDownloadProgress?: import('../transfer/progress.js').ProgressListener;
  progressInterval?: number;
  /** Maximum response payload size in bytes; response parsing enforces this limit. */
  maxBodySize?: number;
  rateLimiter?: import('../transfer/rate-limiter.js').RateLimiter;
};

export type HttpAdapterFactory = (config: AdapterConfig) => Promise<Response | AdapterResult>;

export function hasAdapterCapability(capability: AdapterCapability): boolean {
  switch (capability) {
    case 'fetch': return typeof globalThis.fetch === 'function';
    case 'xhr': return typeof globalThis.XMLHttpRequest === 'function';
    case 'http2': {
      const processLike = (globalThis as { process?: { versions?: { node?: string } } }).process;
      return Boolean(processLike?.versions?.node);
    }
    case 'http3': return false;
  }
}
