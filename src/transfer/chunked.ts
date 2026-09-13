export interface ChunkUploadPart {
  index: number;
  start: number;
  end: number;
  body: Uint8Array;
  total: number;
  signal?: AbortSignal;
}

export type ChunkRetryDelay =
  | number
  | ((attempt: number, error: unknown, part: ChunkUploadPart) => number | Promise<number>);

export interface ChunkPartErrorContext {
  part: ChunkUploadPart;
  error: unknown;
  /** One-based number of the failed attempt, including the initial attempt. */
  attempt: number;
  /** The orchestration signal, when the caller supplied one. */
  signal?: AbortSignal;
}

export interface ChunkUploadOptions<T> {
  chunkSize: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  /** Number of additional attempts allowed for an individual failed part. */
  retry?: number;
  /** Delay before an individual part retry, in milliseconds. */
  retryDelay?: ChunkRetryDelay;
  /** Called after each failed part attempt, including the final failure. */
  onPartError?: (context: ChunkPartErrorContext) => void | Promise<void>;
  upload: (part: ChunkUploadPart) => Promise<T>;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}

/**
 * Stop waiting for user-provided async hooks when orchestration is canceled.
 * The original promise is still observed so a late rejection cannot become
 * an unhandled rejection; canceling the wait cannot cancel arbitrary user IO.
 */
function raceWithSignal<T>(value: PromiseLike<T> | T, signal: AbortSignal | undefined): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) {
    pending.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      pending.catch(() => undefined);
      return;
    }
    pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function waitForRetry(delay: number, signal: AbortSignal | undefined): Promise<void> {
  if (isAborted(signal)) return Promise.reject(abortError());
  if (delay <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort can happen between the initial check and listener registration.
    if (isAborted(signal)) onAbort();
  });
}

function normalizeRetryCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
  return Math.max(1, Math.floor(normalized));
}

async function resolveRetryDelay(
  retryDelay: ChunkRetryDelay | undefined,
  attempt: number,
  error: unknown,
  part: ChunkUploadPart,
): Promise<number> {
  const value = typeof retryDelay === 'function'
    ? await retryDelay(attempt, error, part)
    : retryDelay ?? 0;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Math.max(0, normalized) : 0;
}

export async function uploadChunks<T>(source: Uint8Array, options: ChunkUploadOptions<T>): Promise<T[]> {
  const chunkSize = normalizePositiveInteger(options.chunkSize, 1);
  const concurrency = normalizePositiveInteger(options.concurrency, 1);
  const maxRetries = normalizeRetryCount(options.retry);
  const total = source.byteLength;
  const count = Math.ceil(total / chunkSize);
  const results = new Array<T>(count);
  let next = 0;
  let loaded = 0;
  let failed = false;

  const worker = async () => {
    while (true) {
      if (isAborted(options.signal)) throw abortError();
      if (failed) return;
      const index = next++;
      if (index >= count) return;
      const start = index * chunkSize;
      const end = Math.min(total, start + chunkSize);
      const body = source.slice(start, end);
      const part: ChunkUploadPart = { index, start, end, body, total, signal: options.signal };
      let attempt = 0;

      while (true) {
        if (isAborted(options.signal)) throw abortError();
        if (failed) return;
        attempt += 1;

        try {
          const result = await raceWithSignal(options.upload(part), options.signal);
          // Cancellation wins over a late upload resolution. Do not publish
          // a completed result or progress event after the orchestration
          // signal has already been aborted.
          if (isAborted(options.signal)) throw abortError();
          results[index] = result;
        } catch (error) {
          // Cancellation is a control signal, not a transient part failure.
          if (isAborted(options.signal)) throw abortError();

          await raceWithSignal(options.onPartError?.({ part, error, attempt, signal: options.signal }), options.signal);
          if (isAborted(options.signal)) throw abortError();
          if (failed) return;

          if (attempt > maxRetries) {
            failed = true;
            throw error;
          }

          const delay = await raceWithSignal(resolveRetryDelay(options.retryDelay, attempt, error, part), options.signal);
          await waitForRetry(delay, options.signal);
          continue;
        }

        // Progress is reported only after a successful upload. Errors from the
        // observer itself are intentionally allowed to propagate, rather than
        // being treated as another upload attempt.
        loaded += body.byteLength;
        options.onProgress?.(loaded, total);
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, count)) }, () => worker()));
  return results;
}
