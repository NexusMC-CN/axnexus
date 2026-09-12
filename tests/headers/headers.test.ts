import { strict as assert } from 'node:assert';
import test from 'node:test';
import { AxiosHeaders, HttpError } from '../../dist/index.js';

test('stores and reads headers case-insensitively', () => {
  const headers = new AxiosHeaders({ 'Content-Type': 'application/json' });
  headers.set('content-type', 'text/plain');
  assert.equal(headers.get('CONTENT-TYPE'), 'text/plain');
  assert.equal(headers.has('Content-Type'), true);
  assert.deepEqual(headers.toJSON(), { 'content-type': 'text/plain' });
});

test('supports rewrite rules, normalization and serialization', () => {
  const headers = new AxiosHeaders({ accept: 'application/json', 'x-test': 'one' });
  headers.set('Accept', 'text/plain', false);
  headers.set('X-Test', 'two', (value) => value === 'one');
  headers.normalize(true);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('x-test'), 'two');
  assert.match(headers.toString(), /Accept: application\/json/);
  assert.deepEqual([...headers], [['Accept', 'application/json'], ['X-Test', 'two']]);
});

test('deletes and clears selected headers', () => {
  const headers = new AxiosHeaders({ accept: 'application/json', authorization: 'Bearer token' });
  assert.equal(headers.delete('authorization'), true);
  assert.equal(headers.clear(/^accept$/), true);
  assert.equal(headers.has('accept'), false);
  assert.equal(headers.has('authorization'), false);
});

test('rejects control characters in header names and values', () => {
  assert.throws(() => new AxiosHeaders({ 'x\r\n-test': 'value' }), (error: unknown) => {
    return error instanceof HttpError && error.code === 'ERR_INVALID_HEADER';
  });
  assert.throws(() => new AxiosHeaders().set('x-test', 'a\nb'), (error: unknown) => {
    return error instanceof HttpError && error.code === 'ERR_INVALID_HEADER';
  });
});
