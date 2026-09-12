import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../dist/index.js';

test('exports createHttpClient', () => {
  assert.equal(typeof createHttpClient, 'function');
});
