import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, RateLimiter, createHttpClient } from '../../dist/index.js';
import { createNodeHttp2Adapter } from '../../dist/adapters/node-http2.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// #5 — a large chunked wait must be charged once, not repeatedly amplified.
// This deliberately waits ~9s of byte time, so it needs an explicit timeout:
// Bun's default per-test timeout is 5s and would otherwise abort it.
test('issue 5: a large byte wait is not amplified by the wait loop', { timeout: 30_000 }, async () => {
  const limiter = new RateLimiter();
  const started = Date.now();
  // 1000 B/s and 10000 B: the first 1000 consume the bucket, the remaining
  // 9000 must take ~9s, not the ~45s the repeated-rescaling bug produced.
  await limiter.consume(10_000, { bytesPerSecond: 1_000, resourceGroup: 'large-wait' });
  const elapsed = Date.now() - started;
  assert.equal(elapsed >= 8_500, true, `expected ~9s, took ${elapsed}ms`);
  assert.equal(elapsed < 12_000, true, `expected ~9s, took ${elapsed}ms`);
});

// #8 — HTTP/2 uploads must respect write backpressure instead of buffering the
// whole body: after a write reports `false`, the adapter waits for `drain`.
test('issue 8: an HTTP/2 upload waits for drain under backpressure', async () => {
  const session = new ScriptedSession();
  const adapter = createNodeHttp2Adapter({
    module: { connect: () => session, constants: { NGHTTP2_CANCEL: 8 } },
  });

  // A streamed body is what goes through write() and can hit backpressure.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.close();
    },
  });
  const pending = adapter({
    url: 'https://example.test/upload',
    method: 'POST',
    headers: new Headers(),
    body,
  } as never);

  // Let the writer reach the backpressure point.
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  const stream = session.streams[0];
  // Only the first chunk was written; the adapter is waiting for `drain`.
  assert.equal(stream.writes, 1, 'the adapter must stop writing until drain');

  stream.emitDrain();
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  // After drain the remaining chunk is sent.
  assert.equal(stream.writes >= 2, true, 'the upload must resume after drain');

  stream.emit('response', { ':status': 200 });
  stream.emit('end');
  const result = await pending;
  assert.equal(result.response.status, 200);
});

// #30 — concurrent GET de-duplication must not impose another caller's retry.
test('issue 30: a shared GET load does not borrow another caller retry policy', async () => {
  // If the two callers shared a single load, the non-retrying caller would
  // receive the value produced for the retrying one with no request of its own.
  // A correct implementation keeps them separate.
  for (const retryFirst of [true, false]) {
    let calls = 0;
    const client = createHttpClient({
      adapter: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ nope: true }, 503)
          : jsonResponse({ ok: true });
      },
    });

    const retrying = () => client.get('/shared', { retry: { limit: 1, delay: 0, statusCodes: [503] } as never } as never)
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    const plain = () => client.get('/shared', { retry: 0 } as never)
      .then((value) => ({ value }), (error: unknown) => ({ error }));

    const [first, second] = retryFirst
      ? await Promise.all([retrying(), plain()])
      : await Promise.all([plain(), retrying()]);
    const plainResult = retryFirst ? second : first;
    const retryResult = retryFirst ? first : second;

    // The retrying caller always ends up with the retried success.
    assert.deepEqual('value' in retryResult ? retryResult.value : undefined, { ok: true });

    // The plain caller must never receive a value fetched under the other
    // caller's retry policy without issuing its own request.
    const callsForPlain = retryFirst ? 3 : 2;
    assert.equal(calls, callsForPlain, `unexpected adapter call count (retryFirst=${retryFirst})`);
    if (!retryFirst) {
      // It ran first and observed the original 503 rather than waiting for the
      // retrying caller's second attempt.
      assert.equal('error' in plainResult, true);
    }
  }
});

// #47 — a failed serialization must not run the same serializer twice.
test('issue 47: a throwing serializer is invoked once', async () => {
  let serializeCalls = 0;
  const client = createHttpClient({
    adapter: async () => jsonResponse({ ok: true }),
    stringifyJson: () => {
      serializeCalls += 1;
      throw new Error('serializer exploded');
    },
  });

  await assert.rejects(
    client.post('/serialize', { a: 1 } as never),
    (error: unknown) => (error as { code?: string }).code === 'ERR_TRANSFORM_REQUEST',
  );
  assert.equal(serializeCalls, 1, 'the serializer must not be re-run on the error path');
});

// #49 — the request-level `requestCache` alias must win over `fetchCache`.
test('issue 49: requestCache overrides a client fetchCache default', async () => {
  const seen: Array<RequestCache | undefined> = [];
  const client = createHttpClient({
    fetchCache: 'force-cache',
    adapter: async (config) => {
      seen.push((config as { fetchCache?: RequestCache }).fetchCache);
      return jsonResponse({ ok: true });
    },
  });

  await client.get('/alias', { requestCache: 'no-store' } as never);
  assert.deepEqual(seen, ['no-store']);
});

/** Minimal scriptable HTTP/2 session. */
class ScriptedSession {
  streams: ScriptedStream[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  request(): ScriptedStream {
    const stream = new ScriptedStream();
    this.streams.push(stream);
    return stream;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  close(): void { /* no-op */ }
  destroy(): void { /* no-op */ }
  unref(): void { /* no-op */ }
}

class ScriptedStream {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  writes = 0;
  awaitingDrain = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  emitDrain(): void {
    this.awaitingDrain = false;
    this.emit('drain');
  }

  write(): boolean {
    this.writes += 1;
    // Always report backpressure so each chunk must wait for `drain`.
    return false;
  }

  end(body?: unknown): void {
    if (body !== undefined) this.writes += 1;
  }

  close(): void { /* no-op */ }
  pause(): void { /* no-op */ }
  resume(): void { /* no-op */ }
}
