type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

/** Fallback entry cap for caches constructed without an explicit bound. */
const DEFAULT_MAX_ENTRIES = 512;

/** Cache entries above this size are not retained; re-fetching beats pinning them. */
const MAX_ENTRY_BYTES = 1_000_000;

/** Per-caller controls for waiting on a cache hit or shared load. */
export interface CacheWaitOptions {
  /** Cancel this caller's wait without canceling the shared loader. */
  signal?: AbortSignal;
  /** Absolute epoch time in milliseconds at which this caller's wait expires. */
  deadline?: number;
}

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

function createWaitError(message: string, name: 'AbortError' | 'TimeoutError'): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

function normalizeDeadline(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Number(value) : undefined;
}

function getAbortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? createWaitError('The operation was aborted', 'AbortError');
}

function assertWaitAllowed(options: CacheWaitOptions | undefined): void {
  if (options?.signal?.aborted) throw getAbortReason(options.signal);
  const deadline = normalizeDeadline(options?.deadline);
  if (deadline !== undefined && deadline <= Date.now()) {
    throw createWaitError('The operation timed out', 'TimeoutError');
  }
}

function waitFor<T>(promise: Promise<T>, options: CacheWaitOptions | undefined): Promise<T> {
  const signal = options?.signal;
  const deadline = normalizeDeadline(options?.deadline);
  if (!signal && deadline === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal));
    };
    const onDeadline = () => {
      cleanup();
      reject(createWaitError('The operation timed out', 'TimeoutError'));
    };

    if (signal?.aborted) {
      promise.catch(() => undefined);
      return onAbort();
    }
    if (deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        promise.catch(() => undefined);
        return onDeadline();
      }
      timer = setTimeout(onDeadline, remaining);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export interface GetRequestCacheOptions {
  /** Maximum number of retained responses. Defaults to 512. */
  maxEntries?: number;
}

export class GetRequestCache {
  readonly instanceId: string;
  private readonly responseCache = new Map<string, CacheEntry>();
  private readonly inflightRequests = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private generation = 0;

  constructor(instanceId: string, options: GetRequestCacheOptions = {}) {
    this.instanceId = instanceId;
    const requested = Number(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxEntries = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_MAX_ENTRIES;
  }

  /** Current number of retained (possibly expired) responses. */
  size(): number {
    return this.responseCache.size;
  }

  /**
   * Drop every expired entry. Entries are otherwise only removed when the same
   * key is requested again, so a long-lived client walking distinct URLs would
   * keep every expired payload alive.
   */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.responseCache) {
      if (entry.expiresAt <= now) {
        this.responseCache.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private store(key: string, entry: CacheEntry): void {
    // Refresh insertion order so the oldest touched key is evicted first.
    this.responseCache.delete(key);
    this.responseCache.set(key, entry);
    if (this.responseCache.size <= this.maxEntries) return;
    // Prefer evicting already-expired entries before live ones.
    const now = Date.now();
    for (const [candidate, value] of this.responseCache) {
      if (this.responseCache.size <= this.maxEntries) return;
      if (value.expiresAt <= now) this.responseCache.delete(candidate);
    }
    while (this.responseCache.size > this.maxEntries) {
      const oldest = this.responseCache.keys().next().value;
      if (oldest === undefined) break;
      this.responseCache.delete(oldest);
    }
  }

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options?: CacheWaitOptions,
  ): Promise<T> {
    assertWaitAllowed(options);
    const now = Date.now();
    const generation = this.generation;
    const cached = this.responseCache.get(key);
    if (ttlMs > 0 && cached && cached.expiresAt > now) {
      return cloneValue(await waitFor(Promise.resolve(cached.value as T), options));
    }
    if (cached && cached.expiresAt <= now) this.responseCache.delete(key);

    const inflight = this.inflightRequests.get(key) as Promise<T> | undefined;
    if (inflight) return cloneValue(await waitFor(inflight, options));

    const pending = loader().then((value) => {
      if (ttlMs > 0 && generation === this.generation) {
        const stored = cloneValue(value);
        if (estimateBytes(stored) <= MAX_ENTRY_BYTES) {
          this.store(key, {
            expiresAt: Date.now() + ttlMs,
            value: stored,
          });
        }
      }
      return cloneValue(value);
    });
    this.inflightRequests.set(key, pending);
    // Clean up independently of any subscriber. A canceled subscriber must not
    // remove the shared promise while another caller is still waiting on it.
    pending.then(
      () => {
        if (this.inflightRequests.get(key) === pending) this.inflightRequests.delete(key);
        // Opportunistically reclaim expired payloads so the map cannot grow
        // without bound when callers keep requesting new URLs.
        if (this.responseCache.size > this.maxEntries) this.prune();
      },
      () => {
        if (this.inflightRequests.get(key) === pending) this.inflightRequests.delete(key);
      },
    );
    return cloneValue(await waitFor(pending, options));
  }

  clear(): void {
    this.generation += 1;
    this.responseCache.clear();
    this.inflightRequests.clear();
  }
}

/** Cheap upper-bound estimate used to avoid pinning very large payloads. */
function estimateBytes(value: unknown): number {
  if (value === null || value === undefined || typeof value !== 'object') return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

