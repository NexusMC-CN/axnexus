import { strict as assert } from 'node:assert';
import test from 'node:test';
import { HttpError } from '../../dist/index.js';
import { createHttp3Adapter } from '../../dist/adapters/node-http3.js';

test('http3 adapter requires an injected transport', () => {
  assert.throws(() => createHttp3Adapter(), (error: unknown) => error instanceof HttpError && error.code === 'ERR_UNSUPPORTED_ADAPTER');
});

test('http3 adapter marks injected transport responses as h3', async () => {
  const adapter = createHttp3Adapter({
    request: async () => ({ status: 204, headers: { 'x-protocol': 'h3' }, body: '' }),
  });
  const result = await adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  assert.equal(result.metadata?.protocol, 'h3');
  assert.equal(result.response.status, 204);
});
