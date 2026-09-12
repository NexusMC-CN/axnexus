import type { ResolvedRequestConfig } from '../core/types.js';

export type AdapterCapability = 'fetch' | 'xhr' | 'http2' | 'http3';

export interface AdapterMetadata {
  protocol?: 'h1' | 'h2' | 'h3' | 'unknown';
  timings?: {
    startedAt?: number;
    headersAt?: number;
    completedAt?: number;
  };
}

export interface AdapterResult {
  response: Response;
  metadata?: AdapterMetadata;
}

export type AdapterConfig = ResolvedRequestConfig & {
  onUploadProgress?: import('../transfer/progress.js').ProgressListener;
  onDownloadProgress?: import('../transfer/progress.js').ProgressListener;
  progressInterval?: number;
  maxBodySize?: number;
};

export type HttpAdapterFactory = (config: AdapterConfig) => Promise<Response>;

export function hasAdapterCapability(capability: AdapterCapability): boolean {
  switch (capability) {
    case 'fetch': return typeof globalThis.fetch === 'function';
    case 'xhr': return typeof globalThis.XMLHttpRequest === 'function';
    case 'http2': return false;
    case 'http3': return false;
  }
}
