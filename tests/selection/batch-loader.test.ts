import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionBatchLoader } from '../../dist/selection/server/index.js';

test('request batch loader coalesces keys, caches duplicates and preserves order', async () => {
  const batches: readonly number[][] = [];
  const loader = createSelectionBatchLoader<number, string>(async (keys) => {
    (batches as number[][]).push([...keys]);
    return keys.map((key) => String(key));
  });
  assert.deepEqual(await Promise.all([loader.load(2), loader.load(1), loader.load(2)]), ['2', '1', '2']);
  assert.deepEqual(batches, [[2, 1]]);
  assert.equal(await loader.load(1), '1');
  const { loadMany } = loader;
  assert.deepEqual(await loadMany([1, 2]), ['1', '2']);
  loader.clear(1);
  assert.equal(await loader.load(1), '1');
  assert.deepEqual(batches, [[2, 1], [1]]);
});

test('batch loader caps batch size and rejects misaligned results', async () => {
  const batches: number[][] = [];
  const loader = createSelectionBatchLoader<number, number>(async (keys) => { batches.push([...keys]); return [...keys]; }, { maxBatchSize: 2 });
  assert.deepEqual(await loader.loadMany([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(batches, [[1, 2], [3]]);
  const broken = createSelectionBatchLoader<number, number>(async () => []);
  await assert.rejects(broken.load(1), /one value per key/i);
});

test('a canceled request rejects queued loads without dispatching', async () => {
  const controller = new AbortController();
  let called = 0;
  const loader = createSelectionBatchLoader<number, number>(async (keys) => { called++; return [...keys]; }, { signal: controller.signal });
  const work = loader.load(1);
  controller.abort();
  await assert.rejects(work);
  assert.equal(called, 0);
});
