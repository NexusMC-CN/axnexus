import { scheduleTimer } from '../core/lifecycle/timers.js';
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
  /** Whether the resolved value may be retained. */
  shouldStore?: (value: unknown) => boolean;
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
    let timer: (() => void) | undefined;
    const cleanup = () => {
      timer?.();
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
      timer = scheduleTimer(onDeadline, remaining);
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
  private readonly inflightRequests = new Map<string, { promise: Promise<unknown>; controller: AbortController; users: number; settled: boolean }>();
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
    loader: (signal: AbortSignal) => Promise<T>,
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

    let inflight = this.inflightRequests.get(key);
    if (!inflight) {
      const controller = new AbortController();
      const entry = { controller, users: 0, settled: false, promise: undefined as unknown as Promise<unknown> };
      // Schedule the loader after registering ownership so synchronous throws
      // and reentrant callers cannot escape the shared lifecycle.
      entry.promise = Promise.resolve().then(() => loader(controller.signal)).then((value) => {
        if (ttlMs > 0 && generation === this.generation && !controller.signal.aborted
          && (options?.shouldStore?.(value) ?? true) && estimateBytes(value) <= MAX_ENTRY_BYTES) {
          this.store(key, { expiresAt: Date.now() + ttlMs, value: cloneValue(value) });
        }
        return value;
      }).finally(() => {
        entry.settled = true;
        if (this.inflightRequests.get(key) === entry) this.inflightRequests.delete(key);
      });
      this.inflightRequests.set(key, entry);
      inflight = entry;
    }
    inflight.users += 1;
    try {
      return cloneValue(await waitFor(inflight.promise as Promise<T>, options));
    } finally {
      inflight.users -= 1;
      if (inflight.users === 0 && !inflight.settled) {
        if (this.inflightRequests.get(key) === inflight) this.inflightRequests.delete(key);
        inflight.controller.abort(createWaitError('All subscribers left', 'AbortError'));
      }
    }
  }

  clear(): void {
    this.generation += 1;
    this.responseCache.clear();
    this.inflightRequests.clear();
  }
}

/** Cheap upper-bound estimate used to avoid pinning very large payloads. */
function estimateBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'object') return 8;
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  // structuredClone retains the entire backing buffer, including bytes outside
  // a small view. Estimate the bytes that actually remain resident.
  if (ArrayBuffer.isView(value)) return value.buffer.byteLength;
  if (value instanceof Date) return 8;
  if (value instanceof RegExp) return estimateBytes(value.source) + estimateBytes(value.flags);
  if (seen.has(value)) return Infinity;
  seen.add(value);
  let total = 0;
  if (value instanceof Map) {
    for (const [key, child] of value) {
      total += estimateBytes(key, seen) + estimateBytes(child, seen);
      if (total > MAX_ENTRY_BYTES) break;
    }
  } else if (value instanceof Set) {
    for (const child of value) {
      total += estimateBytes(child, seen);
      if (total > MAX_ENTRY_BYTES) break;
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return Infinity;
    for (const [key, child] of Object.entries(value)) {
      total += estimateBytes(key) + estimateBytes(child, seen);
      if (total > MAX_ENTRY_BYTES) break;
    }
  }
  seen.delete(value);
  return total;
}
