import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ProgressTracker, trackReadableStream } from '../../dist/index.js';

test('calculates progress rate and final percent', async () => {
  const events: Array<{ loaded: number; percent?: number }> = [];
  const tracker = new ProgressTracker({ phase: 'download', total: 10, onProgress: (event) => events.push(event) });
  tracker.update(4, 1000);
  tracker.update(10, 2000);
  tracker.complete(2000);
  assert.equal(events.at(-1)?.loaded, 10);
  assert.equal(events.at(-1)?.percent, 100);
  assert.equal(events.at(-1)?.rate, 6);
});

test('does not invent percent for unknown total', () => {
  const events: Array<{ percent?: number }> = [];
  const tracker = new ProgressTracker({ phase: 'download', onProgress: (event) => events.push(event) });
  tracker.update(4, 1000);
  tracker.complete(1500);
  assert.equal('percent' in events[0], false);
});

test('tracks bytes through a readable stream', async () => {
  const events: number[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const tracked = trackReadableStream(stream, { phase: 'download', total: 3, onProgress: (event) => events.push(event.loaded) });
  const reader = tracked.getReader();
  while (!(await reader.read()).done) {}
  assert.deepEqual(events, [2, 3]);
});
