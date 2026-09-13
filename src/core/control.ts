import { combineSignals } from '../utils/signal.js';

export { combineSignals };

export const TIMEOUT_REASON = Object.freeze({ code: 'ETIMEDOUT', name: 'TimeoutError' });

export function signalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/** Race user/adapter work against a request signal without leaving listeners behind. */
export function raceWithSignal<T>(value: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) {
    // The caller no longer needs the value, but the adapter/interceptor
    // promise still needs a rejection observer. Without this branch an
    // already-aborted combined signal can leave the original rejection
    // unhandled after the raced promise has settled.
    pending.catch(() => undefined);
    return Promise.reject(signalReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signalReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}
