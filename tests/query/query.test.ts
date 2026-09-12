import { strict as assert } from 'node:assert';
import test from 'node:test';
import { serializeParams } from '../../dist/utils/query.js';

test('modular query utility keeps repeated array encoding', () => {
  assert.equal(serializeParams({ tag: ['a', 'b'] }), 'tag=a&tag=b');
});
