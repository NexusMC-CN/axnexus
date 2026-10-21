import type { RequestConfig } from '../types.js';

type ClientLifecyclePolicy = Pick<RequestConfig, 'timeout' | 'totalTimeout' | 'signal'>;
const policies = new WeakMap<object, ClientLifecyclePolicy>();

/** Internal bridge for layers that validate before and after a client request. */
export function registerClientLifecyclePolicy(client: object, policy: ClientLifecyclePolicy): void {
  policies.set(client, { timeout: policy.timeout, totalTimeout: policy.totalTimeout, signal: policy.signal });
}

export function getClientLifecyclePolicy(client: object): ClientLifecyclePolicy | undefined {
  return policies.get(client);
}
