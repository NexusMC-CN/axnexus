import type { RequestConfig, ResolvedRequestConfig } from '../core/types.js';

interface CsrfPolicy {
  owner: symbol;
  headerName: string;
  token: string;
  trusted: (config: ResolvedRequestConfig) => boolean;
}

const csrfPolicies = Symbol('csrfPolicies');
type ProtectedConfig = RequestConfig & { [csrfPolicies]?: CsrfPolicy[] };

export function getCsrfToken(config: ProtectedConfig, owner: symbol): string | undefined {
  return config[csrfPolicies]?.find((policy) => policy.owner === owner)?.token;
}

/** Preserve private provenance when an interceptor returns a new public config. */
export function inheritCsrfPolicy<T extends RequestConfig>(config: T, previous?: RequestConfig): T {
  const target = config as ProtectedConfig;
  if (previous && !Object.prototype.hasOwnProperty.call(target, csrfPolicies)) {
    const policies = (previous as ProtectedConfig)[csrfPolicies];
    if (policies) target[csrfPolicies] = policies;
  }
  return config;
}

export function setCsrfPolicy(config: ProtectedConfig, owner: symbol, policy?: Omit<CsrfPolicy, 'owner'>): void {
  const policies = (config[csrfPolicies] ?? []).filter((item) => item.owner !== owner);
  if (policy) policies.push({ owner, ...policy });
  config[csrfPolicies] = policies;
}

/** Runs after URL resolution and request transforms, immediately before dispatch. */
export function finalizeCsrfConfig(config: ResolvedRequestConfig): ResolvedRequestConfig {
  const policies = (config as ProtectedConfig)[csrfPolicies] ?? [];
  for (const policy of policies) {
    // A caller replacement is explicit and no longer belongs to this injector.
    if (config.headers.get(policy.headerName) !== policy.token) continue;
    if (!policy.trusted(config)) {
      config.headers.delete(policy.headerName);
      continue;
    }
    // Fetch forwards custom headers across redirects. Fail closed because an
    // interceptor cannot validate the redirect target before Fetch sends it.
    if (config.redirect === undefined || config.redirect === 'follow') config.redirect = 'error';
  }
  return config;
}
