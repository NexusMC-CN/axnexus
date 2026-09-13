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

test('provides explicit AxiosHeaders/native Headers conversion helpers', () => {
  const source = new Headers({ 'X-Trace': 'trace-1' });
  const headers = AxiosHeaders.from(source);
  assert.equal(headers.get('x-trace'), 'trace-1');
  assert.equal(AxiosHeaders.from(headers), headers);
  assert.equal(headers.toHeaders().get('X-Trace'), 'trace-1');
});

test('supports parameter parsing, raw header blocks and standard shortcuts', () => {
  const headers = new AxiosHeaders();
  headers.set('Content-Type: multipart/form-data; boundary="a,b"');
  assert.equal(headers.get('content-type', /boundary=(?:"([^"]+)"|([^;]+))/)?.[0], 'boundary="a,b"');
  assert.deepEqual({ ...headers.get('content-type', AxiosHeaders.parseParameters) }, {
    boundary: 'a,b',
  });
  assert.deepEqual({ ...headers.get('content-type', true) }, {
    'multipart/form-data': undefined,
    boundary: 'a,b',
  });
  headers.setContentLength('12').setContentEncoding('gzip');
  assert.equal(headers.getContentLength(), '12');
  assert.equal(headers.hasContentEncoding(), true);
});

test('accepts iterable header inputs including Map values', () => {
  const map = new Map<string, string>([['X-Trace', 'trace-1'], ['Accept', 'application/json']]);
  const headers = new AxiosHeaders(map);
  headers.set(new Map([['X-Trace-2', 'trace-2']]));
  const combined = AxiosHeaders.concat(map, { 'X-Trace-3': 'trace-3' });
  assert.equal(headers.get('x-trace'), 'trace-1');
  assert.equal(headers.get('x-trace-2'), 'trace-2');
  assert.equal(combined.get('x-trace-3'), 'trace-3');
});

test('keeps false as an explicit opt-out sentinel and parses whitespace tokens', () => {
  const headers = new AxiosHeaders({ Accept: false, 'Content-Type': false });
  headers.set('X-Parameters', 'foo=bar baz=qux');
  assert.equal(headers.has('accept'), true);
  assert.equal(headers.get('accept'), undefined);
  assert.deepEqual({ ...headers.get('x-parameters', true) }, { foo: 'bar', baz: 'qux' });
  assert.equal('accept' in headers.toJSON(true), false);
});

test('clear matchers are evaluated against header names', () => {
  const headers = new AxiosHeaders({ Secret: 'keep-me', Public: 'remove-me' });
  assert.equal(headers.clear((value) => value === 'remove-me'), false);
  assert.equal(headers.has('public'), true);
  assert.equal(headers.clear((_, name) => name.toLowerCase() === 'public'), true);
  assert.equal(headers.has('public'), false);
});

test('resets global matcher state between header checks', () => {
  const headers = new AxiosHeaders({ First: 'one', Second: 'two' });
  const matcher = /first/gi;
  assert.equal(headers.has('FIRST', matcher), true);
  assert.equal(headers.has('FIRST', matcher), true);
  assert.equal(headers.has('SECOND', matcher), false);
});

test('accepts numeric and boolean header values and resets parser regex state', () => {
  const headers = new AxiosHeaders({ 'Content-Length': 12, 'X-Enabled': true });
  assert.equal(headers.get('content-length'), '12');
  assert.equal(headers.get('x-enabled'), 'true');
  const parser = /12/g;
  assert.equal(headers.get('content-length', parser)?.[0], '12');
  assert.equal(headers.get('content-length', parser)?.[0], '12');
});
