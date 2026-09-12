import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHttpClient } from '../../dist/index.js';

test('client applies default rate limit to complete requests', async () => {
  let active = 0;
  let peak = 0;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response('{"ok":true}');
    },
  });
  await Promise.all([client.get('/one'), client.get('/two')]);
  assert.equal(peak, 1);
});

test('client request rate limit can override the default concurrency', async () => {
  let active = 0;
  let peak = 0;
  const client = createHttpClient({
    rateLimit: { maxConcurrent: 1 },
    adapter: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return new Response('{"ok":true}');
    },
  });
  await Promise.all([
    client.get('/one', { rateLimit: { maxConcurrent: 2 } }),
    client.get('/two', { rateLimit: { maxConcurrent: 2 } }),
  ]);
  assert.equal(peak, 2);
});
