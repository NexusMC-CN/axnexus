type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export class GetRequestCache {
  readonly instanceId: string;
  private readonly responseCache = new Map<string, CacheEntry>();
  private readonly inflightRequests = new Map<string, Promise<unknown>>();

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.responseCache.get(key);
    if (ttlMs > 0 && cached && cached.expiresAt > now) {
      return cloneValue(cached.value as T);
    }
    if (cached && cached.expiresAt <= now) this.responseCache.delete(key);

    const inflight = this.inflightRequests.get(key) as Promise<T> | undefined;
    if (inflight) return cloneValue(await inflight);

    const pending = loader().then((value) => {
      if (ttlMs > 0) {
        this.responseCache.set(key, {
          expiresAt: Date.now() + ttlMs,
          value: cloneValue(value),
        });
      }
      return cloneValue(value);
    });
    this.inflightRequests.set(key, pending);
    try {
      return cloneValue(await pending);
    } finally {
      this.inflightRequests.delete(key);
    }
  }

  clear(): void {
    this.responseCache.clear();
  }
}
