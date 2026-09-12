import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/index.ts';

test('exports createHttpClient', () => {
  assert.equal(typeof createHttpClient, 'function');
});
