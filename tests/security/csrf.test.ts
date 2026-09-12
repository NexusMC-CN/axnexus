import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createCsrfInterceptor } from '../../dist/security/csrf.js';

test('modular csrf interceptor preserves explicit headers', () => {
  const interceptor = createCsrfInterceptor({ readToken: () => 'token' });
  const result = interceptor({ method: 'POST', headers: { 'X-CSRF-Token': 'explicit' } });
  assert.equal(new Headers(result.headers).get('x-csrf-token'), 'explicit');
});
