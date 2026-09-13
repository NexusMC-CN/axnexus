export interface ResponseCacheOptions {
  now?: () => number;
  maxEntries?: number;
}

export interface ResponseCachePolicy {
  ttl?: number;
  staleWhileRevalidate?: number;
  staleIfError?: boolean;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
  staleUntil: number;
}

function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {}
  return value;
}

export class ResponseCache<T = unknown> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private generation = 0;
  private readonly keyGenerations = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: ResponseCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    const requestedMaxEntries = Number(options.maxEntries ?? 256);
    this.maxEntries = Number.isFinite(requestedMaxEntries)
      ? Math.max(1, Math.floor(requestedMaxEntries))
      : 256;
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<T>,
    policy: ResponseCachePolicy = {},
  ): Promise<T> {
    const now = this.now();
    const ttl = Math.max(0, Number(policy.ttl) || 0);
    const staleWindow = Math.max(0, Number(policy.staleWhileRevalidate) || 0);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      this.touch(key, cached);
      return clone(cached.value);
    }

    const existing = this.inflight.get(key);
    if (cached && cached.staleUntil > now) {
      if (!existing) void this.refresh(key, loader, ttl, staleWindow, policy.staleIfError).catch(() => undefined);
      return clone(cached.value);
    }
    if (existing) return clone(await existing);

    return clone(await this.refresh(key, loader, ttl, staleWindow, policy.staleIfError));
  }

  clear(key?: string): void {
    if (key === undefined) {
      this.generation += 1;
      this.entries.clear();
      this.inflight.clear();
      return;
    }
    this.keyGenerations.set(key, (this.keyGenerations.get(key) ?? 0) + 1);
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  size(): number {
    return this.entries.size;
  }

  private touch(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private async refresh(
    key: string,
    loader: () => Promise<T>,
    ttl: number,
    staleWindow: number,
    staleIfError = false,
  ): Promise<T> {
    const current = this.inflight.get(key);
    if (current) return current;
    const previous = this.entries.get(key);
    const generation = this.generation;
    const keyGeneration = this.keyGenerations.get(key) ?? 0;
    const pending = loader().then((value) => {
      const expiresAt = this.now() + ttl;
      if (generation === this.generation && keyGeneration === (this.keyGenerations.get(key) ?? 0)) {
        this.touch(key, { value: clone(value), expiresAt, staleUntil: expiresAt + staleWindow });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      }
      return value;
    }).catch((error) => {
      if (staleIfError && previous && previous.staleUntil > this.now()) return previous.value;
      throw error;
    }).finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }
}
