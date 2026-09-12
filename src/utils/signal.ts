export function combineSignals(signals: Array<AbortSignal | undefined>): { signal?: AbortSignal; cleanup: () => void } {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return { cleanup: () => {} };
  const controller = new AbortController();
  const listeners = active.map((signal) => {
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return { signal, onAbort };
  });
  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach(({ signal, onAbort }) => signal.removeEventListener('abort', onAbort)),
  };
}
