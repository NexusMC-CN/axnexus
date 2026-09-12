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
}

export class RateLimiter {
  private readonly defaults: RateLimitOptions;
  private readonly queue: Task<unknown>[] = [];
  private active = 0;
  private sequence = 0;
  private pumping = false;
  private readonly requestTimes: number[] = [];

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

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const limit = Math.max(1, Math.floor(Number(this.defaults.maxConcurrent) || Infinity));
      while (this.active < limit && this.queue.length) {
        this.queue.sort((a, b) => (Number(b.options.priority) || 0) - (Number(a.options.priority) || 0) || a.sequence - b.sequence);
        const task = this.queue.shift();
        if (!task || task.settled) continue;
        const interval = Math.max(0, Number(task.options.interval) || 0);
        const maxRequests = Math.max(0, Math.floor(Number(task.options.requestsPerInterval) || 0));
        const now = Date.now();
        while (this.requestTimes.length && now - this.requestTimes[0] >= interval) this.requestTimes.shift();
        if (maxRequests > 0 && interval > 0 && this.requestTimes.length >= maxRequests) {
          this.queue.unshift(task);
          setTimeout(() => this.pump(), Math.max(1, interval - (now - this.requestTimes[0])));
          break;
        }
        this.requestTimes.push(now);
        this.active += 1;
        task.settled = true;
        if (task.timer) clearTimeout(task.timer);
        Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
          this.active -= 1;
          task.options.signal?.removeEventListener('abort', () => undefined);
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}
