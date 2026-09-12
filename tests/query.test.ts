import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveURL, serializeParams } from '../src/query.ts';

test('serializes scalar, repeated array and omits empty params', () => {
  assert.equal(
    serializeParams({ page: 1, tag: ['a', 'b'], empty: null, missing: undefined }),
    'page=1&tag=a&tag=b',
  );
});

test('joins base URL and path with one slash', () => {
  assert.equal(resolveURL('https://example.test/api/', '/users'), 'https://example.test/api/users');
});

test('rejects absolute URLs when disabled', () => {
  assert.throws(() => resolveURL('https://example.test/api', 'https://other.test/users', false));
});
