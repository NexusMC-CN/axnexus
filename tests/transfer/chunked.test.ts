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

test('does not commit progress after a chunk resolves after cancellation', async () => {
  const controller = new AbortController();
  const progress: Array<{ loaded: number; total: number }> = [];
  let resolveUpload!: (value: string) => void;
  const pending = uploadChunks(new Uint8Array([1]), {
    chunkSize: 1,
    signal: controller.signal,
    onProgress: (loaded, total) => progress.push({ loaded, total }),
    upload: () => new Promise<string>((resolve) => {
      resolveUpload = resolve;
    }),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  resolveUpload('ok');

  await assert.rejects(pending, (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
  assert.deepEqual(progress, []);
});

test('settles orchestration cancellation when an upload callback ignores the signal', async () => {
  const controller = new AbortController();
  const pending = uploadChunks(new Uint8Array([1]), {
    chunkSize: 1,
    signal: controller.signal,
    upload: () => new Promise<string>(() => undefined),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(
    Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('upload cancellation hung')), 100)),
    ]),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('retries only the failed chunk and reports each failed attempt', async () => {
  const attempts = new Map<number, number>();
  const failures: number[] = [];
  const result = await uploadChunks(new Uint8Array([1, 2, 3, 4]), {
    chunkSize: 2,
    retry: 1,
    retryDelay: 0,
    onPartError: ({ part }) => failures.push(part.index),
    upload: async ({ index }) => {
      const next = (attempts.get(index) ?? 0) + 1;
      attempts.set(index, next);
      if (index === 1 && next === 1) throw new Error('temporary');
      return index;
    },
  });
  assert.deepEqual(result, [0, 1]);
  assert.deepEqual([...attempts.entries()], [[0, 1], [1, 2]]);
  assert.deepEqual(failures, [1]);
});

test('exposes the orchestration signal to part error hooks', async () => {
  const controller = new AbortController();
  let contextSignal: AbortSignal | undefined;
  await assert.rejects(uploadChunks(new Uint8Array([1]), {
    chunkSize: 1,
    signal: controller.signal,
    onPartError: ({ part, signal }) => {
      contextSignal = signal;
      assert.equal(part.signal, controller.signal);
    },
    upload: async () => { throw new Error('failed'); },
  }));
  assert.equal(contextSignal, controller.signal);
});
