/** Largest delay supported by browser and Node timers without overflow. */
export const MAX_TIMER_DELAY = 2_147_483_647;

/** Schedule long waits in bounded segments; return an idempotent cancellation function. */
export function scheduleTimer(callback: () => void, milliseconds: number): () => void {
  // Relative waits must not change when the system wall clock is corrected.
  const deadline = performance.now() + milliseconds;
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = Math.max(0, deadline - performance.now());
    timer = setTimeout(() => {
      if (!active) return;
      if (performance.now() < deadline) schedule();
      else {
        active = false;
        callback();
      }
    }, Math.min(MAX_TIMER_DELAY, remaining));
  };
  schedule();
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
