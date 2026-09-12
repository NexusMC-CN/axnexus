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
  run: () => Promise<T> | T;
  options: RateLimitOptions;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  sequence: number;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  abort?: () => void;
}

interface LimitState {
  active: number;
  requestTimes: number[];
  byteTokens: number;
  byteUpdatedAt: number;
}

export class RateLimiter {
  private readonly defaults: RateLimitOptions;
  private readonly queue: Task<unknown>[] = [];
  private sequence = 0;
  private pumping = false;
  private readonly states = new Map<string, LimitState>();

  constructor(options: RateLimitOptions = {}) {
    this.defaults = { ...options };
  }

  run<T>(run: () => Promise<T> | T, options: RateLimitOptions = {}): Promise<T> {
    const merged = { ...this.defaults, ...options };
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { run, options: merged, resolve, reject, sequence: this.sequence += 1, settled: false };
      const abort = () => {
        if (task.settled) return;
        const index = this.queue.indexOf(task as Task<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        reject(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
      };
      task.abort = abort;
      if (merged.signal?.aborted) return abort();
      merged.signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(task as Task<unknown>);
      if (merged.queueTimeout && merged.queueTimeout > 0) {
        task.timer = setTimeout(() => {
          if (task.settled) return;
          const index = this.queue.indexOf(task as Task<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          task.settled = true;
          merged.signal?.removeEventListener('abort', abort);
          reject(new HttpError('Rate limit queue timed out', { code: 'ERR_RATE_LIMIT_QUEUE_TIMEOUT' }));
        }, merged.queueTimeout);
      }
      this.pump();
    });
  }

  async consume(bytes: number, options: RateLimitOptions = {}): Promise<void> {
    const merged = { ...this.defaults, ...options };
    const bytesPerSecond = Number(merged.bytesPerSecond);
    const amount = Math.max(0, Number(bytes) || 0);
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || amount === 0) return;
    const key = merged.resourceGroup || '__global__';
    const state = this.states.get(key) ?? { active: 0, requestTimes: [], byteTokens: bytesPerSecond, byteUpdatedAt: Date.now() };
    this.states.set(key, state);
    while (true) {
      const now = Date.now();
      const elapsed = Math.max(0, now - state.byteUpdatedAt) / 1000;
      state.byteTokens = Math.min(bytesPerSecond, state.byteTokens + elapsed * bytesPerSecond);
      state.byteUpdatedAt = now;
      if (state.byteTokens >= amount) {
        state.byteTokens -= amount;
        return;
      }
      const deficit = amount - state.byteTokens;
      state.byteTokens = 0;
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
        }, Math.max(1, Math.ceil((deficit / bytesPerSecond) * 1000)));
        merged.signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (amount > bytesPerSecond) return;
    }
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => (Number(b.options.priority) || 0) - (Number(a.options.priority) || 0) || a.sequence - b.sequence);
        const now = Date.now();
        let selected = -1;
        let retryAfter = Infinity;
        for (let index = 0; index < this.queue.length; index += 1) {
          const candidate = this.queue[index];
          if (candidate.settled) continue;
          const key = candidate.options.resourceGroup || '__global__';
          const state = this.states.get(key) ?? { active: 0, requestTimes: [], byteTokens: 0, byteUpdatedAt: Date.now() };
          this.states.set(key, state);
          const limit = Math.max(1, Math.floor(Number(candidate.options.maxConcurrent ?? this.defaults.maxConcurrent) || Infinity));
          if (state.active >= limit) continue;
          const interval = Math.max(0, Number(candidate.options.interval ?? this.defaults.interval) || 0);
          const maxRequests = Math.max(0, Math.floor(Number(candidate.options.requestsPerInterval ?? this.defaults.requestsPerInterval) || 0));
          while (state.requestTimes.length && now - state.requestTimes[0] >= interval) state.requestTimes.shift();
          if (maxRequests > 0 && interval > 0 && state.requestTimes.length >= maxRequests) {
            retryAfter = Math.min(retryAfter, Math.max(1, interval - (now - state.requestTimes[0])));
            continue;
          }
          selected = index;
          break;
        }
        if (selected < 0) {
          if (retryAfter < Infinity) setTimeout(() => this.pump(), retryAfter);
          break;
        }
        const [task] = this.queue.splice(selected, 1);
        if (!task || task.settled) continue;
        const key = task.options.resourceGroup || '__global__';
        const state = this.states.get(key) as LimitState;
        state.requestTimes.push(now);
        state.active += 1;
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
          state.active -= 1;
          if (task.abort) task.options.signal?.removeEventListener('abort', task.abort);
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}
