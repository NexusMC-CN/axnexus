import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHttpClient } from '../../dist/index.js';

test('legacy root entry keeps data-returning request API', async () => {
  const client = createHttpClient({ adapter: async () => new Response('{"ok":true}') });
  assert.deepEqual(await client.get('/health'), { ok: true });
});
