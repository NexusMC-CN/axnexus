import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHttpClient } from '../../dist/index.js';

test('records monotonic request timing fields', async () => {
  const client = createHttpClient({ adapter: async () => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return new Response('{"ok":true}');
  } });
  const response = await client.getResponse('/timing');
  const { queuedAt, startedAt, headersAt, completedAt, duration } = response.timings;
  assert.equal(queuedAt !== undefined, true);
  assert.equal(startedAt !== undefined, true);
  assert.equal(headersAt !== undefined, true);
  assert.equal(completedAt !== undefined, true);
  assert.equal((startedAt as number) >= (queuedAt as number), true);
  assert.equal((headersAt as number) >= (startedAt as number), true);
  assert.equal((completedAt as number) >= (headersAt as number), true);
  assert.equal((duration as number) >= 0, true);
});
