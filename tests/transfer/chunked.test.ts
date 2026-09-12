import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadChunks } from '../../dist/transfer/chunked.js';

test('uploads chunks with bounded concurrency and aggregates progress', async () => {
  const source = new Uint8Array(10);
  let active = 0;
  let peak = 0;
  const completed: number[] = [];
  const result = await uploadChunks(source, {
    chunkSize: 3,
    concurrency: 2,
    upload: async ({ index, body }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 5 : 1));
      active -= 1;
      completed.push(index);
      return { index, size: body.byteLength };
    },
  });

  assert.equal(peak, 2);
  assert.deepEqual(completed.sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.deepEqual(result.map((part) => part.size), [3, 3, 3, 1]);
});

test('passes the cancellation signal to each chunk upload', async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  await uploadChunks(new Uint8Array([1, 2]), {
    chunkSize: 2,
    signal: controller.signal,
    upload: async ({ signal }) => {
      receivedSignal = signal;
      return 'ok';
    },
  });
  assert.equal(receivedSignal, controller.signal);
});
