import { raceWithSignal } from '../../core/control.js';

export interface SelectionBatchLoader<Key, Value> {
  load(key: Key): Promise<Value>;
  loadMany(keys: readonly Key[]): Promise<Value[]>;
  clear(key: Key): void;
  clearAll(): void;
}

export interface SelectionBatchOptions<Key> {
  readonly signal?: AbortSignal;
  readonly maxBatchSize?: number;
  readonly cacheKey?: (key: Key) => unknown;
}

/** Create inside a request-scoped factory; batches and memoization never outlive that factory. */
export function createSelectionBatchLoader<Key, Value>(
  batch: (keys: readonly Key[], signal?: AbortSignal) => readonly Value[] | Promise<readonly Value[]>,
  options: SelectionBatchOptions<Key> = {},
): SelectionBatchLoader<Key, Value> {
  if (typeof batch !== 'function') throw new TypeError('Batch function required');
  const maxBatchSize = options.maxBatchSize ?? 100;
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) throw new TypeError('maxBatchSize must be a positive safe integer');
  const cache = new Map<unknown, Promise<Value>>();
  type Pending = { key: Key; resolve: (value: Value) => void; reject: (error: unknown) => void };
  const pending: Pending[] = [];
  let scheduled = false;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { void flush(); });
  };
  const flush = async () => {
    scheduled = false;
    const entries = pending.splice(0, maxBatchSize);
    if (pending.length) schedule();
    if (!entries.length) return;
    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Selection request canceled');
      const values = await raceWithSignal(batch(entries.map((entry) => entry.key), options.signal), options.signal);
      if (!Array.isArray(values) || values.length !== entries.length) throw new TypeError('Batch function must return one value per key');
      entries.forEach((entry, index) => entry.resolve(values[index]!));
    } catch (error) { entries.forEach((entry) => entry.reject(error)); }
  };

  const load = (key: Key): Promise<Value> => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Selection request canceled'));
    const cacheKey = options.cacheKey ? options.cacheKey(key) : key;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const result = new Promise<Value>((resolve, reject) => { pending.push({ key, resolve, reject }); });
    cache.set(cacheKey, result);
    schedule();
    return result;
  };
  return {
    load,
    loadMany(keys) { return Promise.all(keys.map(load)); },
    clear(key) { cache.delete(options.cacheKey ? options.cacheKey(key) : key); },
    clearAll() { cache.clear(); },
  };
}
