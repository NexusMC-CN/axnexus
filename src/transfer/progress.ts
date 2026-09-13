export type TransferPhase = 'upload' | 'download';

export interface TransferProgress {
  phase: TransferPhase;
  loaded: number;
  total?: number;
  percent?: number;
  rate?: number;
  estimated?: number;
  startedAt: number;
  elapsed: number;
}

export type ProgressListener = (progress: TransferProgress) => void;

export interface ProgressTrackerOptions {
  phase: TransferPhase;
  total?: number;
  onProgress?: ProgressListener;
  progressInterval?: number;
  now?: () => number;
  signal?: AbortSignal;
  rateLimiter?: import('./rate-limiter.js').RateLimiter;
  rateLimit?: import('./rate-limiter.js').RateLimitOptions;
}

export class ProgressTracker {
  private readonly options: ProgressTrackerOptions;
  private readonly startedAt: number;
  private lastLoaded = 0;
  private lastReportedAt = -Infinity;
  private lastRate: number | undefined;

  get loaded(): number {
    return this.lastLoaded;
  }

  setTotal(total: number | undefined): void {
    this.options.total = Number.isFinite(total) && (total as number) >= 0 ? total : undefined;
  }

  constructor(options: ProgressTrackerOptions) {
    this.options = options;
    this.startedAt = (options.now ?? Date.now)();
  }

  update(loaded: number, timestamp = (this.options.now ?? Date.now)()): TransferProgress | undefined {
    if (this.options.signal?.aborted) return undefined;
    const safeLoaded = Math.max(this.lastLoaded, Number(loaded) || 0);
    if (safeLoaded === this.lastLoaded && this.lastReportedAt !== -Infinity) return undefined;
    this.lastLoaded = safeLoaded;
    const elapsed = Math.max(0, timestamp - this.startedAt) / 1000;
    const interval = Math.max(0, Number(this.options.progressInterval) || 0);
    if (timestamp - this.lastReportedAt < interval && safeLoaded !== this.options.total) return undefined;
    const deltaTime = Math.max(0, timestamp - this.lastReportedAt) / 1000;
    if (this.lastReportedAt !== -Infinity && deltaTime > 0) this.lastRate = (safeLoaded - this.lastLoadedBeforeReport) / deltaTime;
    this.lastReportedAt = timestamp;
    this.lastLoadedBeforeReport = safeLoaded;
    return this.emit(safeLoaded, elapsed);
  }

  private lastLoadedBeforeReport = 0;

  complete(timestamp = (this.options.now ?? Date.now)()): TransferProgress | undefined {
    if (this.options.signal?.aborted) return undefined;
    const total = Number.isFinite(this.options.total) ? Math.max(0, this.options.total as number) : undefined;
    return this.update(total === undefined ? this.lastLoaded : total, timestamp);
  }

  private emit(loaded: number, elapsed: number): TransferProgress {
    const total = Number.isFinite(this.options.total) ? Math.max(0, this.options.total as number) : undefined;
    const progress: TransferProgress = {
      phase: this.options.phase,
      loaded,
      ...(total === undefined ? {} : { total, percent: total === 0 ? 100 : Math.min(100, (loaded / total) * 100) }),
      ...(this.lastRate === undefined ? {} : { rate: this.lastRate }),
      ...(total !== undefined && this.lastRate && this.lastRate > 0 ? { estimated: Math.max(0, (total - loaded) / this.lastRate) } : {}),
      startedAt: this.startedAt,
      elapsed,
    };
    try {
      this.options.onProgress?.(progress);
    } catch {
      // Progress observers are non-critical and cannot fail the transfer.
    }
    return progress;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  const reason = () => abortReason(signal);
  if (signal.aborted) {
    try { void reader.cancel(reason()).catch(() => undefined); } catch { /* stream already closed */ }
    return Promise.reject(reason());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { void reader.cancel(reason()).catch(() => undefined); } catch { /* stream already closed */ }
      reject(reason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
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

export function trackReadableStream(
  stream: ReadableStream<Uint8Array>,
  options: ProgressTrackerOptions,
): ReadableStream<Uint8Array> {
  const signal = options.signal ?? options.rateLimit?.signal;
  const tracker = new ProgressTracker({ ...options, signal });
  const reader = stream.getReader();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const result = await readChunk(reader, signal);
        if (result.done) {
          closed = true;
          tracker.complete();
          controller.close();
        } else {
          if (options.rateLimiter) {
            await options.rateLimiter.consume(result.value.byteLength, {
              ...options.rateLimit,
              signal,
            });
          }
          if (signal?.aborted) throw abortReason(signal);
          tracker.update(tracker.loaded + result.value.byteLength);
          controller.enqueue(result.value);
        }
      } catch (error) {
        closed = true;
        // Cancellation is best-effort; a user-provided source may leave its
        // cancel promise pending. The consumer must still observe the error.
        try { void reader.cancel(error).catch(() => undefined); } catch { /* stream already closed */ }
        controller.error(error);
      }
    },
    cancel(reason) {
      closed = true;
      return reader.cancel(reason);
    },
  });
}
