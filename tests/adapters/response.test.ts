import { strict as assert } from 'node:assert';
import test from 'node:test';
import { HttpError, readResponse } from '../../dist/index.js';

test('enforces max response body size before parsing', async () => {
  await assert.rejects(
    readResponse(new Response('12345'), 'text', 3),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_MAX_BODY_SIZE',
  );
});
