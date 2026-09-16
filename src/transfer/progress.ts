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
  private completed = false;

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
    // A throttled update still advances `lastLoaded`. When the byte count did
    // not change afterwards, `complete()` must still be able to publish the
    // final value, so an unchanged value only short-circuits while the transfer
    // is still running.
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
    if (this.completed) return undefined;
    this.completed = true;
    const total = Number.isFinite(this.options.total) ? Math.max(0, this.options.total as number) : undefined;
    const finalLoaded = total === undefined ? this.lastLoaded : total;
    if (finalLoaded < this.lastLoaded) {
      // A known total smaller than what was observed would regress the counter.
      return undefined;
    }
    // Publish the final byte count unless it was already reported as the last
    // event. A throttled update still advances `lastLoaded`, so without the
    // explicit final emit the last event under-reports the transferred bytes.
    if (this.lastReportedAt !== -Infinity && finalLoaded === this.lastLoadedBeforeReport) return undefined;
    return this.emitFinal(finalLoaded, timestamp);
  }

  /**
   * Emit the terminal progress event unconditionally. A throttled update may
   * have already recorded the final count, which would otherwise make the
   * "value unchanged" fast path swallow the last event.
   */
  private emitFinal(loaded: number, timestamp: number): TransferProgress {
    this.lastLoaded = Math.max(this.lastLoaded, loaded);
    const elapsed = Math.max(0, timestamp - this.startedAt) / 1000;
    const deltaTime = Math.max(0, timestamp - this.lastReportedAt) / 1000;
    if (this.lastReportedAt !== -Infinity && deltaTime > 0) {
      this.lastRate = (this.lastLoaded - this.lastLoadedBeforeReport) / deltaTime;
    }
    this.lastReportedAt = timestamp;
    this.lastLoadedBeforeReport = this.lastLoaded;
    return this.emit(this.lastLoaded, elapsed);
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
  // Cancelling the wrapper must also abort an in-flight byte-throttle wait and
  // any read still pending on the source, not just flag the stream.
  const cancelController = new AbortController();
  const innerSignal = combineWithAbort(signal, cancelController.signal);
  const releaseAll = () => {
    if (!cancelController.signal.aborted) cancelController.abort(abortReason(innerSignal));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const result = await readChunk(reader, innerSignal);
        // `cancel()` may have run while this read was pending; the source
        // closing makes the read resolve with `done: true`, which must not be
        // reported as a completed transfer.
        if (closed) return;
        if (result.done) {
          closed = true;
          tracker.complete();
          controller.close();
        } else {
          if (options.rateLimiter) {
            await options.rateLimiter.consume(result.value.byteLength, {
              ...options.rateLimit,
              signal: innerSignal,
            });
          }
          // Re-check after the throttle wait: the consumer may have canceled
          // while we were waiting for byte quota.
          if (closed) return;
          if (innerSignal?.aborted) throw abortReason(innerSignal);
          const updated = tracker.update(tracker.loaded + result.value.byteLength);
          if (closed) return;
          void updated;
          controller.enqueue(result.value);
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        // Cancellation is best-effort; a user-provided source may leave its
        // cancel promise pending. The consumer must still observe the error.
        try { void reader.cancel(error).catch(() => undefined); } catch { /* stream already closed */ }
        controller.error(error);
      }
    },
    cancel(reason) {
      if (closed) return undefined;
      closed = true;
      // Abort the internal throttle wait so it does not keep a timer and keep
      // consuming this resource group's byte quota after cancellation.
      releaseAll();
      return reader.cancel(reason);
    },
  });
}

/** Combine an outer signal with an internal cancel signal. */
function combineWithAbort(outer: AbortSignal | undefined, inner: AbortSignal): AbortSignal {
  if (!outer) return inner;
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(abortReason(outer));
  const onInnerAbort = () => controller.abort(inner.reason);
  outer.addEventListener('abort', onOuterAbort, { once: true });
  inner.addEventListener('abort', onInnerAbort, { once: true });
  if (outer.aborted) onOuterAbort();
  return controller.signal;
}
