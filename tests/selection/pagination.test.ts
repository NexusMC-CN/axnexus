import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateSelection } from '../../dist/selection/server/index.js';

test('forward page fetches one extra row and returns an end cursor', async () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const calls: unknown[] = [];
  const options = {
    maxPageSize: 2,
    decodeCursor: (cursor: string) => cursor.slice(2),
    encodeCursor: (row: { id: string }) => `c:${row.id}`,
    load: ({ after, limit }: { after: string | null; limit: number }) => {
      calls.push({ after, limit });
      return rows.filter((row) => after === null || row.id > after).slice(0, limit);
    },
  };
  assert.deepEqual(await paginateSelection({ first: 2 }, options), {
    items: [{ id: 'a' }, { id: 'b' }], pageInfo: { endCursor: 'c:b', hasNextPage: true },
  });
  assert.deepEqual(await paginateSelection({ first: 2, after: 'c:b' }, options), {
    items: [{ id: 'c' }], pageInfo: { endCursor: 'c:c', hasNextPage: false },
  });
  assert.deepEqual(calls, [{ after: null, limit: 3 }, { after: 'b', limit: 3 }]);
});

test('pagination enforces page and cursor bounds before calling data source', async () => {
  let loads = 0;
  const options = { maxPageSize: 2, decodeCursor: (value: string) => value,
    encodeCursor: (row: { id: string }) => row.id, load: () => { loads++; return []; } };
  for (const first of [0, -1, 3, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(paginateSelection({ first }, options), (error: any) => error.code === 'INVALID_PAGE');
  }
  await assert.rejects(paginateSelection({ first: 1, after: '' }, options), (error: any) => error.code === 'INVALID_CURSOR');
  await assert.rejects(paginateSelection({ first: 1, after: 'a'.repeat(2049) }, options), (error: any) => error.code === 'INVALID_CURSOR');
  assert.equal(loads, 0);
});

test('cursor decoding failures do not reveal decoder internals', async () => {
  const options = { maxPageSize: 2, decodeCursor: () => { throw new Error('private key'); },
    encodeCursor: (row: { id: string }) => row.id, load: () => [{ id: 'a' }] };
  await assert.rejects(paginateSelection({ first: 1, after: 'bad' }, options), (error: any) =>
    error.code === 'INVALID_CURSOR' && !String(error.message).includes('private key'));
});

test('pagination rejects data sources that return more than requested', async () => {
  await assert.rejects(paginateSelection({ first: 1 }, { maxPageSize: 1, decodeCursor: (x: string) => x,
    encodeCursor: (row: { id: string }) => row.id, load: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), /page source/i);
});
