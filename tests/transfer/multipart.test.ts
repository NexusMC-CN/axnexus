import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createFormData } from '../../dist/index.js';

test('creates multipart form data without buffering fields', () => {
  const form = createFormData({ title: 'demo', count: 2 });
  assert.equal(form.get('title'), 'demo');
  assert.equal(form.get('count'), '2');
});
