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

class ManualStream extends EventEmitter {
  requestHeaders?: Record<string, string>;
  endBody?: unknown;
  closeCode?: number;
  closeCount = 0;
  writeChunks: unknown[] = [];
  end(body?: unknown) {
    this.endBody = body;
  }
  write(chunk: unknown) {
    this.writeChunks.push(chunk);
    return true;
  }
  close(code?: number) {
    this.closeCode = code;
    this.closeCount += 1;
  }
}

class SynchronousCloseStream extends ManualStream {
  override close(code?: number) {
    super.close(code);
    this.emit('close');
  }
}

class ManualSession extends EventEmitter {
  streams: ManualStream[] = [];
  request(headers: Record<string, string>) {
    const stream = new ManualStream();
    stream.requestHeaders = headers;
    this.streams.push(stream);
    return stream;
  }
}

class SynchronousCloseSession extends ManualSession {
  override request(headers: Record<string, string>) {
    const stream = new SynchronousCloseStream();
    stream.requestHeaders = headers;
    this.streams.push(stream);
    return stream;
  }
}

class SynchronousErrorStream extends ManualStream {
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === 'error') this.emit('error', new Error('synchronous stream failure'));
    return this;
  }
}

class SynchronousErrorSession extends ManualSession {
  override request(headers: Record<string, string>) {
    const stream = new SynchronousErrorStream();
    stream.requestHeaders = headers;
    this.streams.push(stream);
    return stream;
  }
}

async function rejectsWithin<T>(promise: Promise<T>, timeout = 250): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation hung')), timeout);
      }),
    ]);
    return new Error('expected rejection');
  } catch (error) {
    return error;
  } finally {
    if (timer) clearTimeout(timer);
  }
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

test('isolates a failed stream while keeping the shared session usable', async () => {
  const session = new ManualSession();
  let connectCalls = 0;
  const adapter = createNodeHttp2Adapter({
    module: {
      connect: () => {
        connectCalls += 1;
        return session;
      },
      constants: { NGHTTP2_CANCEL: 8 },
    },
  });

  const firstPromise = adapter({ url: 'https://example.test/first', method: 'GET', headers: new Headers() } as never);
  const secondPromise = adapter({ url: 'https://example.test/second', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.streams.length, 2);

  session.streams[0].emit('response', { ':status': 200 });
  session.streams[1].emit('response', { ':status': 200 });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  session.streams[0].emit('error', new Error('first stream failed'));
  session.streams[1].emit('data', Buffer.from('second response'));
  session.streams[1].emit('end');

  await assert.rejects(first.response.text(), /HTTP\/2 stream failed/);
  assert.equal(await second.response.text(), 'second response');

  const thirdPromise = adapter({ url: 'https://example.test/third', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 1);
  session.streams[2].emit('response', { ':status': 200 });
  session.streams[2].emit('end');
  const third = await thirdPromise;
  assert.equal(await third.response.text(), '');
});

test('fails in-flight streams when the shared session itself errors and reconnects', async () => {
  const sessions: ManualSession[] = [];
  let connectCalls = 0;
  const adapter = createNodeHttp2Adapter({
    module: {
      connect: () => {
        connectCalls += 1;
        const session = new ManualSession();
        sessions.push(session);
        return session;
      },
      constants: { NGHTTP2_CANCEL: 8 },
    },
  });

  const first = adapter({ url: 'https://example.test/first', method: 'GET', headers: new Headers() } as never);
  const second = adapter({ url: 'https://example.test/second', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].streams.length, 2);

  sessions[0].emit('error', new Error('session failed'));

  const [firstError, secondError] = await Promise.all([
    rejectsWithin(first),
    rejectsWithin(second),
  ]);
  assert.equal((firstError as { code?: string }).code, 'ERR_NETWORK');
  assert.equal((secondError as { code?: string }).code, 'ERR_NETWORK');

  const third = adapter({ url: 'https://example.test/third', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 2);
  sessions[1].streams[0].emit('response', { ':status': 200 });
  sessions[1].streams[0].emit('end');
  const thirdResult = await third;
  assert.equal(thirdResult.response.status, 200);
});

test('fails in-flight streams when the shared session closes before response headers', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({
    module: {
      connect: () => session,
      constants: { NGHTTP2_CANCEL: 8 },
    },
  });

  const pending = adapter({ url: 'https://example.test/close', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.emit('close');

  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_NETWORK');
});

test('keeps a pending request body attached after an early bodyless response', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({
    module: {
      connect: () => session,
      constants: { NGHTTP2_CANCEL: 8 },
    },
  });
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });

  const pending = adapter({
    url: 'https://example.test/early-response',
    method: 'POST',
    headers: new Headers(),
    body,
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.streams[0].emit('response', { ':status': 204 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.emit('close');

  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_NETWORK');
});

test('aborts a pending request body when the shared session errors after an early bodyless response', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({
    module: {
      connect: () => session,
      constants: { NGHTTP2_CANCEL: 8 },
    },
  });
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });

  const pending = adapter({
    url: 'https://example.test/early-error',
    method: 'POST',
    headers: new Headers(),
    body,
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.streams[0].emit('response', { ':status': 204 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.emit('error', new Error('session failed'));

  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_NETWORK');
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

test('http2 adapter rejects an already-aborted request before opening a session', async () => {
  const controller = new AbortController();
  controller.abort();
  let connectCalls = 0;
  const adapter = createNodeHttp2Adapter({ module: {
    connect: () => {
      connectCalls += 1;
      return new ManualSession();
    },
    constants: { NGHTTP2_CANCEL: 8 },
  } });
  const error = await rejectsWithin(adapter({
    url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal,
  } as never));
  assert.equal((error as { code?: string }).code, 'ERR_CANCELED');
  assert.equal(connectCalls, 0);
});

test('http2 adapter preserves timeout classification from an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort({ code: 'ETIMEDOUT', name: 'TimeoutError' });
  const adapter = createNodeHttp2Adapter({ module: {
    connect: () => new ManualSession(),
    constants: { NGHTTP2_CANCEL: 8 },
  } });
  const error = await rejectsWithin(adapter({
    url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal,
  } as never));
  assert.equal((error as { code?: string }).code, 'ETIMEDOUT');
  assert.equal((error as { isTimeout?: boolean }).isTimeout, true);
});

test('http2 adapter settles when the stream is aborted before response headers', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.streams[0].emit('aborted');
  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_NETWORK');
});

test('http2 adapter keeps cancellation classification when close is synchronous', async () => {
  const session = new SynchronousCloseSession();
  const controller = new AbortController();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({
    url: 'https://example.test/', method: 'GET', headers: new Headers(), signal: controller.signal,
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_CANCELED');
});

test('http2 adapter settles when the stream errors before response headers', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.streams[0].emit('error', new Error('socket failed'));
  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_NETWORK');
});

test('http2 adapter returns a null body for bodyless status codes', async () => {
  for (const status of [204, 205, 304]) {
    const session = new ManualSession();
    const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
    const resultPromise = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stream = session.streams[0];
    stream.emit('response', { ':status': status });
    stream.emit('end');
    const result = await resultPromise;
    assert.equal(result.response.status, status);
    assert.equal(result.response.body, null);
  }
});

test('http2 adapter records startedAt before connecting and does not close a canceled body twice', async () => {
  const session = new ManualSession();
  let connectAt = Number.POSITIVE_INFINITY;
  const adapter = createNodeHttp2Adapter({ module: {
    connect: () => {
      connectAt = Date.now();
      return session;
    },
    constants: { NGHTTP2_CANCEL: 8 },
  } });
  const resultPromise = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stream = session.streams[0];
  stream.emit('response', { ':status': 200 });
  const result = await resultPromise;
  assert.ok((result.metadata?.timings?.startedAt ?? Number.POSITIVE_INFINITY) <= connectAt);
  await result.response.body?.cancel();
  stream.emit('end');
  assert.equal(stream.closeCount, 1);
});

test('http2 adapter rejects a response body when the stream closes before end', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const resultPromise = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stream = session.streams[0];
  stream.emit('response', { ':status': 200 });
  const result = await resultPromise;
  stream.emit('close');
  await assert.rejects(result.response.text(), /HTTP\/2 stream failed/);
});

test('http2 adapter rejects malformed response statuses without hanging', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.streams[0].emit('response', { ':status': 99 });
  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_NETWORK');
});

test('http2 adapter settles when a stream errors while listeners are being attached', async () => {
  const session = new SynchronousErrorSession();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({ url: 'https://example.test/', method: 'GET', headers: new Headers() } as never);
  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_NETWORK');
});

test('http2 adapter cancels a pending request-body read when the signal aborts', async () => {
  const session = new ManualSession();
  let bodyCanceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      bodyCanceled = true;
    },
  });
  const controller = new AbortController();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({
    url: 'https://example.test/', method: 'POST', headers: new Headers(), body, signal: controller.signal,
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const error = await rejectsWithin(pending);
  assert.equal((error as { code?: string }).code, 'ERR_CANCELED');
  assert.equal(bodyCanceled, true);
  assert.equal(session.streams[0].closeCount, 1);
});

test('http2 adapter serializes Blob and URLSearchParams request bodies', async () => {
  const session = new ManualSession();
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const blobPromise = adapter({
    url: 'https://example.test/blob', method: 'POST', headers: new Headers(),
    body: new Blob(['hello'], { type: 'text/plain' }),
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const blobStream = session.streams[0];
  blobStream.emit('response', { ':status': 200 });
  blobStream.emit('end');
  await blobPromise;
  assert.deepEqual(Array.from(blobStream.endBody as Uint8Array), Array.from(new TextEncoder().encode('hello')));
  assert.equal(blobStream.requestHeaders?.['content-type'], 'text/plain');

  const paramsPromise = adapter({
    url: 'https://example.test/params', method: 'POST', headers: new Headers(),
    body: new URLSearchParams({ q: 'a b' }),
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const paramsStream = session.streams[1];
  paramsStream.emit('response', { ':status': 200 });
  paramsStream.emit('end');
  await paramsPromise;
  assert.equal(typeof paramsStream.endBody === 'string' ? paramsStream.endBody : new TextDecoder().decode(paramsStream.endBody as Uint8Array), 'q=a+b');
  assert.match(paramsStream.requestHeaders?.['content-type'] ?? '', /^application\/x-www-form-urlencoded/);
});

test('http2 adapter encodes web body types for Node streams', async () => {
  const form = new FormData();
  form.set('name', 'Ada');
  const cases: Array<{ body: BodyInit; expected: string; contentType?: string }> = [
    { body: new Blob(['blob-body'], { type: 'text/plain' }), expected: 'blob-body', contentType: 'text/plain' },
    { body: new URLSearchParams({ q: 'hello world' }), expected: 'q=hello+world', contentType: 'application/x-www-form-urlencoded;charset=UTF-8' },
    { body: form, expected: 'Ada', contentType: 'multipart/form-data;' },
  ];

  for (const item of cases) {
    const session = new ManualSession();
    const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
    const headers = new Headers();
    const pending = adapter({
      url: 'https://example.test/', method: 'POST', headers, body: item.body,
    } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stream = session.streams[0];
    stream.emit('response', { ':status': 200 });
    stream.emit('end');
    const result = await pending;
    assert.equal(await result.response.text(), '');
    const sent = stream.endBody instanceof Uint8Array ? new TextDecoder().decode(stream.endBody) : String(stream.endBody ?? '');
    assert.match(sent, new RegExp(item.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (item.contentType) assert.match(stream.requestHeaders?.['content-type'] || '', new RegExp(item.contentType));
  }
});

test('http2 adapter reports upload progress for streamed request bodies', async () => {
  const session = new ManualSession();
  const events: Array<{ loaded: number; total?: number }> = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({
    url: 'https://example.test/upload', method: 'POST', headers: new Headers({ 'content-length': '3' }), body,
    onUploadProgress: (event) => events.push({ loaded: event.loaded, total: event.total }),
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stream = session.streams[0];
  stream.emit('response', { ':status': 200 });
  stream.emit('end');
  await pending;
  assert.deepEqual(events, [{ loaded: 2, total: 3 }, { loaded: 3, total: 3 }]);
  assert.deepEqual((stream.writeChunks as Uint8Array[]).map((chunk) => Array.from(chunk)), [[1, 2], [3]]);
});

test('http2 adapter reports download progress for response streams', async () => {
  const session = new ManualSession();
  const events: Array<{ loaded: number; total?: number }> = [];
  const adapter = createNodeHttp2Adapter({ module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } } });
  const pending = adapter({
    url: 'https://example.test/download', method: 'GET', headers: new Headers(),
    onDownloadProgress: (event) => events.push({ loaded: event.loaded, total: event.total }),
  } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stream = session.streams[0];
  stream.emit('response', { ':status': 200, 'content-length': '3' });
  const result = await pending;
  stream.emit('data', Buffer.from([1, 2]));
  stream.emit('data', Buffer.from([3]));
  stream.emit('end');
  assert.deepEqual(Array.from(new Uint8Array(await result.response.arrayBuffer())), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.loaded), [2, 3]);
  assert.deepEqual(events.map((event) => event.total), [3, 3]);
});
