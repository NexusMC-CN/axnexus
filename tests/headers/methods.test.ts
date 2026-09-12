import { strict as assert } from 'node:assert';
import test from 'node:test';
import { AxiosHeaders, mergeMethodHeaders } from '../../dist/index.js';

test('merges common, method and request headers with request precedence', () => {
  const merged = mergeMethodHeaders(
    {
      common: { Accept: 'application/json' },
      get: { 'X-Mode': 'default', 'X-Shared': 'common' },
    },
    'GET',
    { 'x-mode': 'request', 'X-Request': 'yes' },
  );
  assert.deepEqual(merged.toJSON(), {
    accept: 'application/json',
    'x-mode': 'request',
    'x-shared': 'common',
    'x-request': 'yes',
  });
});

test('provides standard header method shortcuts', () => {
  const headers = new AxiosHeaders();
  headers.setAccept('application/json').setAuthorization('Bearer token');
  assert.equal(headers.getAccept(), 'application/json');
  assert.equal(headers.hasAuthorization(), true);
});
