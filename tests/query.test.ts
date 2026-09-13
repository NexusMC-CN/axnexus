import test from 'node:test';
import assert from 'node:assert/strict';
import { appendQuery, resolveURL, serializeParams } from '../dist/utils/query.js';

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

test('inserts query parameters before a URL fragment', () => {
  assert.equal(appendQuery('https://example.test/items#section', { page: 2 }), 'https://example.test/items?page=2#section');
});

test('omits null and undefined values inside repeated query arrays', () => {
  assert.equal(serializeParams({ tag: ['a', null, undefined, 'b'] as never }), 'tag=a&tag=b');
});
