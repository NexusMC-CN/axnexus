import type { RequestConfig } from '../core/types.js';
import { resolveURL } from '../utils/query.js';

function origin(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Trust is checked before dispatch; transport redirects are not inspected here. */
export function isTrustedCsrfTarget(
  config: RequestConfig,
  allowedOrigins: readonly string[],
  resolvedURL?: string,
): boolean {
  const browserOrigin = typeof location === 'undefined' ? undefined : origin(location.href);
  // A final dispatch URL already passed the input URL policy. Reapplying the
  // absolute-input restriction would reject every resolved absolute baseURL.
  const url = resolvedURL ?? resolveURL(config.baseURL, config.url, config.allowAbsoluteURL);
  const targetOrigin = origin(url, browserOrigin);
  const baseOrigin = config.baseURL ? origin(config.baseURL, browserOrigin) : undefined;
  if (!targetOrigin) {
    // Server-side relative URLs have no authority and remain within the host's
    // routing context. Malformed absolute references are never trusted.
    return !/^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(url);
  }
  return targetOrigin === browserOrigin || targetOrigin === baseOrigin
    || allowedOrigins.some((allowed) => origin(allowed) === targetOrigin);
}
