import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { RPCLink } from '@orpc/client/fetch';
import { ORPCError, os, type, withEventMeta, getEventMeta } from '@orpc/server';
import { RPCHandler } from '@orpc/server/node';
import { createFetchHandler } from '../../dist/bridges/index.js';

test('real oRPC RPCLink interoperates through axnexus for JSON, errors, multipart, binary and SSE', async () => {
  let calls = 0;
  const procedure = os.input(type<unknown>()).handler(({ input }) => {
    calls++;
    return input;
  });
  const handler = new RPCHandler({
    echo: procedure,
    fail: os.handler(() => { throw new ORPCError('CONFLICT', { status: 409, data: { reason: 'duplicate' } }); }),
    events: os.handler(async function* () {
      yield withEventMeta({ value: 1 }, { id: 'first' });
      yield { value: 2 };
      return { value: 3 };
    }),
  });
  const server = createServer(async (request, response) => {
    try {
      if (!(await handler.handle(request, response)).matched) response.writeHead(404).end();
    } catch (error) { response.destroy(error as Error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const fetch = createFetchHandler();
  const link = new RPCLink({ url: `http://127.0.0.1:${address.port}`, fetch });
  try {
    assert.deepEqual(await link.call(['echo'], { text: '中文', count: 2 }, { context: {} }), { text: '中文', count: 2 });
    await assert.rejects(link.call(['fail'], undefined, { context: {} }), (error: unknown) =>
      error instanceof ORPCError && error.code === 'CONFLICT' && error.status === 409
      && (error.data as { reason: string }).reason === 'duplicate');
    const multipart = await link.call(['echo'], { name: 'upload',
      file: new File([new Uint8Array([0, 65, 255])], 'payload.bin', { type: 'application/octet-stream' }),
    }, { context: {} }) as { name: string; file: File };
    assert.equal(multipart.name, 'upload');
    const file = multipart.file;
    assert.equal(file.name, 'payload.bin');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([0, 65, 255]));
    const binary = await link.call(['echo'], new Blob([new Uint8Array([3, 4])], { type: 'application/octet-stream' }), { context: {} }) as Blob;
    assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), new Uint8Array([3, 4]));
    assert.equal(calls, 3);
    const events = await link.call(['events'], undefined, { context: {} }) as AsyncGenerator<{ value: number }, { value: number }>;
    const first = await events.next();
    assert.deepEqual(first, { value: { value: 1 }, done: false });
    assert.equal(getEventMeta(first.value)?.id, 'first');
    assert.deepEqual(await events.next(), { value: { value: 2 }, done: false });
    assert.deepEqual(await events.next(), { value: { value: 3 }, done: true });
  } finally {
    await fetch.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
