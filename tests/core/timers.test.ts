import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMER_DELAY, scheduleTimer } from '../../dist/core/lifecycle/timers.js';

test('segments waits beyond the timer limit and supports cancellation', () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { callback: () => void; at: number }>();
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    assert.ok(delay <= MAX_TIMER_DELAY);
    const id = ++sequence;
    timers.set(id, { callback, at: now + delay });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  const tick = (milliseconds: number) => {
    now += milliseconds;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  try {
    let calls = 0;
    scheduleTimer(() => { calls += 1; }, MAX_TIMER_DELAY + 100);
    tick(MAX_TIMER_DELAY);
    assert.equal(calls, 0);
    tick(100);
    assert.equal(calls, 1);
    const cancel = scheduleTimer(() => { calls += 1; }, MAX_TIMER_DELAY + 100);
    cancel();
    cancel();
    tick(MAX_TIMER_DELAY + 100);
    assert.equal(calls, 1);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor);
    else Reflect.deleteProperty(performance, 'now');
  }
});

test('a wall-clock correction does not extend a relative timeout', async () => {
  const nativeNow = Date.now;
  let fired = false;
  const cancel = scheduleTimer(() => { fired = true; }, 10);
  const before = Date.now();
  Date.now = () => before - 60_000;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(fired, true);
  } finally {
    Date.now = nativeNow;
    cancel();
  }
});
