type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

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

export class GetRequestCache {
  readonly instanceId: string;
  private readonly responseCache = new Map<string, CacheEntry>();
  private readonly inflightRequests = new Map<string, Promise<unknown>>();
  private generation = 0;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
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
        this.responseCache.set(key, {
          expiresAt: Date.now() + ttlMs,
          value: cloneValue(value),
        });
      }
      return cloneValue(value);
    });
    this.inflightRequests.set(key, pending);
    // Clean up independently of any subscriber. A canceled subscriber must not
    // remove the shared promise while another caller is still waiting on it.
    pending.then(
      () => {
        if (this.inflightRequests.get(key) === pending) this.inflightRequests.delete(key);
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
