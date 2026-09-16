import { HttpError } from '../core/errors.js';

export interface RateLimitOptions {
  bytesPerSecond?: number;
  requestsPerInterval?: number;
  interval?: number;
  maxConcurrent?: number;
  priority?: number;
  queueTimeout?: number;
  resourceGroup?: string;
  signal?: AbortSignal;
}

interface Task<T> {
  run: (release: () => void) => Promise<T> | T;
  options: RateLimitOptions;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  sequence: number;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  abort?: () => void;
  /** Set once the concurrency slot has been handed back. */
  released?: boolean;
}

/** One request-rate window observed for a resource group. */
interface RequestWindow {
  interval: number;
  times: number[];
}

interface LimitState {
  active: number;
  /**
   * Request timestamps per window length. A group can be limited with several
   * different `interval` values, and a short window must not discard records
   * that a concurrently configured long window still needs.
   */
  windows: RequestWindow[];
  byteTokens: number;
  byteUpdatedAt: number;
  byteRate: number;
}

/** Idle groups are reclaimed so dynamic group names cannot grow without bound. */
const GROUP_IDLE_MS = 300_000;

interface GroupMeta {
  lastUsed: number;
}

export class RateLimiter {
  private readonly defaults: RateLimitOptions;
  private readonly queue: Task<unknown>[] = [];
  private sequence = 0;
  private pumping = false;
  private readonly states = new Map<string, LimitState>();
  private readonly groupMeta = new Map<string, GroupMeta>();
  /** A single coalesced wake-up timer for the whole scheduler. */
  private wakeTimer?: ReturnType<typeof setTimeout>;

  constructor(options: RateLimitOptions = {}) {
    this.defaults = { ...options };
  }

  /** Number of resource groups currently tracked. Exposed for diagnostics/tests. */
  groupCount(): number {
    return this.states.size;
  }

  /**
   * Schedule `run` under the configured limits. `run` receives a `release`
   * callback that returns its concurrency slot early; call it before awaiting
   * work that may itself need a slot from this limiter.
   */
  run<T>(run: (release: () => void) => Promise<T> | T, options: RateLimitOptions = {}): Promise<T> {
    const merged = { ...this.defaults, ...options };
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { run, options: merged, resolve, reject, sequence: this.sequence += 1, settled: false };
      const abort = () => {
        if (task.settled) return;
        const index = this.queue.indexOf(task as Task<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        merged.signal?.removeEventListener('abort', abort);
        reject(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
        this.pump();
      };
      task.abort = abort;
      if (merged.signal?.aborted) return abort();
      merged.signal?.addEventListener('abort', abort, { once: true });
      if (merged.signal?.aborted) {
        abort();
        return;
      }
      this.queue.push(task as Task<unknown>);
      if (merged.queueTimeout && merged.queueTimeout > 0) {
        task.timer = setTimeout(() => {
          if (task.settled) return;
          const index = this.queue.indexOf(task as Task<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          task.settled = true;
          merged.signal?.removeEventListener('abort', abort);
          reject(new HttpError('Rate limit queue timed out', { code: 'ERR_RATE_LIMIT_QUEUE_TIMEOUT' }));
          this.pump();
        }, merged.queueTimeout);
      }
      this.pump();
    });
  }

  async consume(bytes: number, options: RateLimitOptions = {}): Promise<void> {
    const merged = { ...this.defaults, ...options };
    if (merged.signal?.aborted) {
      throw new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true });
    }
    const bytesPerSecond = Number(merged.bytesPerSecond);
    let remaining = Math.max(0, Number(bytes) || 0);
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || remaining === 0) return;
    const key = merged.resourceGroup || '__global__';
    const now = Date.now();
    const state = this.states.get(key) ?? {
      active: 0,
      windows: [],
      byteTokens: bytesPerSecond,
      byteUpdatedAt: now,
      byteRate: bytesPerSecond,
    };
    this.states.set(key, state);
    this.touchGroup(key, now);
    if (state.byteRate !== bytesPerSecond) {
      // Keep the already-earned tokens when the configured rate changes.
      // Refilling to a full second of quota would hand out a fresh burst on
      // every rate switch and let alternating rates bypass the limit.
      const elapsed = Math.max(0, now - state.byteUpdatedAt) / 1000;
      const carried = Math.min(state.byteTokens + elapsed * state.byteRate, state.byteRate);
      state.byteTokens = Math.min(carried, bytesPerSecond);
      state.byteRate = bytesPerSecond;
      state.byteUpdatedAt = now;
    }
    while (true) {
      const now = Date.now();
      const elapsed = Math.max(0, now - state.byteUpdatedAt) / 1000;
      state.byteTokens = Math.min(bytesPerSecond, state.byteTokens + elapsed * bytesPerSecond);
      state.byteUpdatedAt = now;
      const consume = Math.min(state.byteTokens, remaining);
      if (consume > 0) {
        state.byteTokens -= consume;
        remaining -= consume;
        if (remaining <= 0) return;
      }
      // The bucket holds at most one second of quota, so a chunk larger than
      // that can never be satisfied in a single wait. Sleeping for the whole
      // remaining deficit would over-wait: the tokens earned during that sleep
      // are capped at one second's worth, and the leftover deficit would then
      // be waited for a second time. Wait only until the next refill can supply
      // more tokens, then re-evaluate.
      const needed = remaining - state.byteTokens;
      const waitMs = Math.max(
        1,
        Math.ceil(Math.min(needed, bytesPerSecond) / bytesPerSecond * 1000),
      );
      state.byteTokens = 0;
      state.byteUpdatedAt = now;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          merged.signal?.removeEventListener('abort', onAbort);
          reject(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
        };
        if (merged.signal?.aborted) return onAbort();
        timer = setTimeout(() => {
          merged.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        merged.signal?.addEventListener('abort', onAbort, { once: true });
        if (merged.signal?.aborted) onAbort();
      });
    }
  }

  /** Drop groups that have been idle and have no active tasks. */
  private evictIdleGroups(now: number): void {
    if (this.states.size === 0) return;
    for (const [key, meta] of this.groupMeta) {
      if (now - meta.lastUsed < GROUP_IDLE_MS) continue;
      const state = this.states.get(key);
      if (state && state.active > 0) continue;
      if (this.queue.some((task) => (task.options.resourceGroup || '__global__') === key)) continue;
      this.states.delete(key);
      this.groupMeta.delete(key);
    }
  }

  private touchGroup(key: string, now: number): void {
    const meta = this.groupMeta.get(key);
    if (meta) meta.lastUsed = now;
    else this.groupMeta.set(key, { lastUsed: now });
    // Opportunistic reclamation keeps dynamic group names bounded.
    if (this.groupMeta.size > 64) this.evictIdleGroups(now);
  }

  private stateFor(key: string, now: number, byteRate: number): LimitState {
    const existing = this.states.get(key);
    if (existing) {
      this.touchGroup(key, now);
      return existing;
    }
    const created: LimitState = {
      active: 0,
      windows: [],
      byteTokens: byteRate,
      byteUpdatedAt: now,
      byteRate,
    };
    this.states.set(key, created);
    this.groupMeta.set(key, { lastUsed: now });
    return created;
  }

  private windowFor(state: LimitState, interval: number): RequestWindow {
    let window = state.windows.find((candidate) => candidate.interval === interval);
    if (!window) {
      window = { interval, times: [] };
      state.windows.push(window);
    }
    return window;
  }

  /** Coalesce wake-ups: many queued tasks must not create many timers. */
  private scheduleWake(delayMs: number): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, Math.max(1, delayMs));
    // Do not keep the event loop alive for a scheduler-only wake-up.
    (this.wakeTimer as { unref?: () => void }).unref?.();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      this.evictIdleGroups(Date.now());
      while (this.queue.length) {
        this.queue.sort((a, b) => (Number(b.options.priority) || 0) - (Number(a.options.priority) || 0) || a.sequence - b.sequence);
        const now = Date.now();
        let selected = -1;
        let retryAfter = Infinity;
        for (let index = 0; index < this.queue.length; index += 1) {
          const candidate = this.queue[index];
          if (candidate.settled) continue;
          const key = candidate.options.resourceGroup || '__global__';
          const byteRate = Math.max(0, Number(candidate.options.bytesPerSecond ?? this.defaults.bytesPerSecond) || 0);
          const state = this.stateFor(key, now, byteRate);
          const limit = Math.max(1, Math.floor(Number(candidate.options.maxConcurrent ?? this.defaults.maxConcurrent) || Infinity));
          if (state.active >= limit) continue;
          const interval = Math.max(0, Number(candidate.options.interval ?? this.defaults.interval) || 0);
          const maxRequests = Math.max(0, Math.floor(Number(candidate.options.requestsPerInterval ?? this.defaults.requestsPerInterval) || 0));
          // Only this candidate's own window is trimmed. Trimming every window
          // with the candidate's interval would let a short window delete
          // history that a longer window still needs.
          const window = interval > 0 ? this.windowFor(state, interval) : undefined;
          if (window) {
            while (window.times.length && now - window.times[0] >= interval) window.times.shift();
            if (maxRequests > 0 && window.times.length >= maxRequests) {
              retryAfter = Math.min(retryAfter, Math.max(1, interval - (now - window.times[0])));
              continue;
            }
          }
          selected = index;
          break;
        }
        if (selected < 0) {
          if (retryAfter < Infinity) this.scheduleWake(retryAfter);
          break;
        }
        const [task] = this.queue.splice(selected, 1);
        if (!task || task.settled) continue;
        const key = task.options.resourceGroup || '__global__';
        const state = this.states.get(key) as LimitState;
        const interval = Math.max(0, Number(task.options.interval ?? this.defaults.interval) || 0);
        if (interval > 0) this.windowFor(state, interval).times.push(now);
        state.active += 1;
        this.touchGroup(key, now);
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        // A running task can hand its concurrency slot back early. This lets a
        // task whose network work is finished run user callbacks (such as
        // response interceptors or retry hooks) that may themselves need a
        // slot, without deadlocking a `maxConcurrent: 1` scheduler.
        const release = () => {
          if (task.released) return;
          task.released = true;
          state.active = Math.max(0, state.active - 1);
          this.touchGroup(key, Date.now());
          this.pump();
        };
        const cleanup = () => {
          release();
          if (task.abort) task.options.signal?.removeEventListener('abort', task.abort);
          this.pump();
        };
        void Promise.resolve()
          .then(() => task.run(release))
          .then(task.resolve, task.reject)
          .then(cleanup, cleanup);
      }
    } finally {
      this.pumping = false;
    }
  }
}
