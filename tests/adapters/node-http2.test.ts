import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createNodeHttp2Adapter } from '../../dist/adapters/node-http2.js';

class MockStream extends EventEmitter {
  responseHeaders?: Record<string, string | number>;
  requestHeaders?: Record<string, string>;
  endBody?: unknown;
  closeCode?: number;
  respond() {}
  end(body?: unknown) {
    this.endBody = body;
    queueMicrotask(() => {
      this.emit('response', { ':status': 200, 'content-type': 'application/json' });
      this.emit('data', Buffer.from('{"ok":true}'));
      this.emit('end');
    });
  }
  close(code?: number) { this.closeCode = code; }
}

class MockSession extends EventEmitter {
  streams: MockStream[] = [];
  request(headers: Record<string, string>) {
    const stream = new MockStream();
    stream.requestHeaders = headers;
    this.streams.push(stream);
    return stream;
  }
  close() {}
}

test('http2 adapter reuses session and returns h2 metadata', async () => {
  const sessions: MockSession[] = [];
  const module = {
    connect() {
      const session = new MockSession();
      sessions.push(session);
      return session;
    },
    constants: { NGHTTP2_CANCEL: 8 },
  };
  const adapter = createNodeHttp2Adapter({ module });
  const config = { url: 'https://example.test/api?q=1', method: 'GET', headers: new Headers() } as never;
  const first = await adapter(config);
  const second = await adapter({ ...config, url: 'https://example.test/other' } as never);
  assert.equal(sessions.length, 1);
  assert.equal(first.metadata?.protocol, 'h2');
  assert.equal(first.response.status, 200);
  assert.deepEqual(await first.response.json(), { ok: true });
  assert.equal(second.response.status, 200);
  assert.equal(sessions[0].streams[1].requestHeaders?.[':path'], '/other');
});

test('http2 adapter removes abort side effects after response body completes', async () => {
  const session = new MockSession();
  const controller = new AbortController();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const result = await adapter({
    url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal,
  } as never);
  await result.response.text();
  controller.abort();
  assert.equal(session.streams[0].closeCode, undefined);
});
