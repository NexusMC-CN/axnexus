import test from 'node:test';
import assert from 'node:assert/strict';
import { createCsrfInterceptor } from '../dist/security/csrf.js';

test('adds a token only to configured unsafe methods', () => {
  const interceptor = createCsrfInterceptor({
    readToken: () => 'csrf-value',
    headerName: 'X-CSRF-Token',
  });

  const getConfig = interceptor({ method: 'GET', headers: { Accept: 'application/json' } });
  const postConfig = interceptor({ method: 'POST', headers: { Accept: 'application/json' } });

  assert.equal(new Headers(getConfig.headers).has('X-CSRF-Token'), false);
  assert.equal(new Headers(postConfig.headers).get('X-CSRF-Token'), 'csrf-value');
});

test('preserves an explicit header and ignores an empty token', () => {
  const explicit = createCsrfInterceptor({
    readToken: () => 'generated',
    headerName: 'X-CSRF-Token',
  })({ method: 'DELETE', headers: { 'X-CSRF-Token': 'explicit' } });
  const empty = createCsrfInterceptor({ readToken: () => '' })({ method: 'PUT' });

  assert.equal(new Headers(explicit.headers).get('X-CSRF-Token'), 'explicit');
  assert.equal(new Headers(empty.headers).has('X-CSRF-Token'), false);
});
