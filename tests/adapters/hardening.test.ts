import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, createFetchAdapter, createXhrAdapter, HttpError } from '../../dist/index.js';
import { fetchJson } from '../../dist/server/json.js';
import { readResponse } from '../../dist/utils/response.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

for (const method of ['TRACE', 'CONNECT', 'TRACK']) {
  test(`Fetch/XHR reject ${method} before transport without retry`, async () => {
    let calls = 0;
    const adapter = createFetchAdapter(async () => { calls++; return new Response('{}'); });
    const client = createHttpClient({ adapter, retry: { limit: 2, methods: [method], delay: 0 } });
    await assert.rejects(client.request({ url: 'https://example.test', method }), code('ERR_UNSUPPORTED_METHOD'));
    assert.equal(calls, 0);
    await assert.rejects(createXhrAdapter()({ url: 'https://example.test', method, headers: new Headers() } as never), code('ERR_UNSUPPORTED_METHOD'));
    const custom = createHttpClient({ adapter: async () => new Response('{}') });
    assert.deepEqual(await custom.request({ url: 'https://example.test', method }), {});
  });
}

test('strict maxBodySize validation covers raw, bodyless and helper paths', async () => {
  for (const value of [-1, NaN, Infinity, 1.5, null, false, '10', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readResponse(new Response(null, { status: 204 }), 'json', value as number), code('ERR_INVALID_CONFIG'));
    await assert.rejects(readResponse(new Response('{}'), 'response', value as number), code('ERR_INVALID_CONFIG'));
    await assert.rejects(fetchJson('https://example.test', { maxBodySize: value as number, fetch: async () => new Response('{}') }), code('ERR_INVALID_CONFIG'));
  }
});

for (const responseType of ['json', 'response'] as const) {
  test(`Fetch compressed length does not reject small decoded ${responseType} body`, async () => {
    const client = createHttpClient({ adapter: createFetchAdapter(async () => new Response('{}', { headers: { 'content-encoding': 'gzip', 'content-length': '22' } })) });
    const result = await client.getResponse('https://example.test', { maxBodySize: 10, responseType });
    assert.deepEqual(responseType === 'response' ? await (result.data as Response).json() : result.data, {});
  });
}

test('helper decoded length and optional HTTP errors retain status/raw response', async () => {
  assert.deepEqual(await fetchJson('https://example.test', { maxBodySize: 10, fetch: async () => new Response('{}', { headers: { 'content-encoding': 'gzip', 'content-length': '22' } }) }), {});
  const raw = new Response('{"error":"missing"}', { status: 404 });
  await assert.rejects(fetchJson('https://example.test', { throwHttpErrors: true, fetch: async () => raw }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.equal(error.response?.raw, raw);
    assert.equal(error.response?.status, 404);
    return true;
  });
});

for (const wrapped of [false, true]) {
  test(`late adapter ${wrapped ? 'AdapterResult' : 'Response'} body canceled`, async () => {
    let finish!: (value: any) => void;
    let canceled = 0;
    const client = createHttpClient({ adapter: () => new Promise((resolve) => { finish = resolve; }), timeout: 5, retry: 0 });
    await assert.rejects(client.get('https://example.test'), code('ETIMEDOUT'));
    const response = new Response(new ReadableStream({ cancel() { canceled++; } }));
    finish(wrapped ? { response } : response);
    await tick();
    assert.equal(canceled, 1);
  });
}

test('status policy exceptions release unread response body', async () => {
  let canceled = 0;
  const client = createHttpClient({ adapter: async () => new Response(new ReadableStream({ cancel() { canceled++; } })), validateStatus: () => { throw new Error('bad policy'); } });
  await assert.rejects(client.get('https://example.test'), code('ERR_INVALID_STATUS_POLICY'));
  assert.equal(canceled, 1);
});

test('helper cancellation races injected fetch and releases late response', async () => {
  let finish!: (value: Response) => void;
  let canceled = 0;
  const controller = new AbortController();
  const pending = fetchJson('https://example.test', { signal: controller.signal, fetch: () => new Promise((resolve) => { finish = resolve; }) });
  controller.abort();
  const outcome = await Promise.race([pending.then(() => 'resolved', () => 'rejected'), tick().then(() => 'pending')]);
  const response = new Response(new ReadableStream({ cancel() { canceled++; } }));
  finish(response);
  assert.equal(outcome, 'rejected');
  await tick();
  assert.equal(canceled, 1);
});

test('native Fetch gzip enforces decoded bytes for JSON, raw and helper responses', async () => {
  const { createServer } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const server = createServer((request, response) => {
    const bytes = gzipSync(request.url === '/large' ? JSON.stringify('x'.repeat(1000)) : '{}');
    response.writeHead(request.url === '/error' ? 400 : 200, { 'content-encoding': 'gzip', 'content-length': bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const client = createHttpClient();
    assert.deepEqual(await client.get(url, { maxBodySize: 10, onDownloadProgress() {} }), {});
    const raw = await client.get<Response>(url, { maxBodySize: 10, responseType: 'response' });
    assert.deepEqual(await raw.json(), {});
    assert.deepEqual(await fetchJson(url, { maxBodySize: 10 }), {});
    await assert.rejects(client.get(url + '/large', { maxBodySize: 100 }), code('ERR_MAX_BODY_SIZE'));
    const largeRaw = await client.get<Response>(url + '/large', { maxBodySize: 100, responseType: 'response' });
    await assert.rejects(largeRaw.text(), code('ERR_MAX_BODY_SIZE'));
    await assert.rejects(fetchJson(url + '/large', { maxBodySize: 100 }), code('ERR_MAX_BODY_SIZE'));
    await assert.rejects(client.get(url + '/error', { maxBodySize: 10 }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.deepEqual(error.response?.data, {});
      return true;
    });
    // Native HTTP/2 adapters expose encoded bytes, so an unmarked response must
    // retain its declared-size guard even when Content-Encoding is present.
    await assert.rejects(readResponse(new Response('{}', { headers: { 'content-encoding': 'gzip', 'content-length': '22' } }), 'json', 10), code('ERR_MAX_BODY_SIZE'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      // Register close before forcing connections shut: Bun also stops the
      // listener in closeAllConnections(), unlike Node's implementation.
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test('external abort and retry success dispose abandoned transport results', async () => {
  for (const retry of [false, true]) {
    let finish!: (value: Response) => void;
    let canceled = 0;
    let calls = 0;
    const controller = new AbortController();
    const client = createHttpClient({ adapter: () => {
      calls++;
      return calls === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(new Response('{}'));
    }, timeout: retry ? 5 : 0, retry: retry ? { limit: 1, delay: 0, retryOnTimeout: true } : 0 });
    const pending = client.get('https://example.test', { signal: controller.signal });
    if (retry) assert.deepEqual(await pending, {});
    else {
      await tick();
      controller.abort();
      await assert.rejects(pending, code('ERR_CANCELED'));
    }
    finish(new Response(new ReadableStream({ cancel() { canceled++; } })));
    await tick();
    assert.equal(canceled, 1);
  }
});

test('helper timeout settles even when injected fetch ignores its signal', async () => {
  let finish!: (value: Response) => void;
  let canceled = 0;
  const pending = fetchJson('https://example.test', { timeoutMs: 5, fetch: () => new Promise((resolve) => { finish = resolve; }) });
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
  finish(new Response(new ReadableStream({ cancel() { canceled++; } })));
  await tick();
  assert.equal(canceled, 1);
});

test('XHR rejects redirect policies it cannot enforce', async () => {
  for (const redirect of ['error', 'manual']) {
    await assert.rejects(createXhrAdapter()({ url: 'https://example.test', method: 'GET', headers: new Headers(), redirect } as never), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, 'ERR_UNSUPPORTED_ADAPTER');
      assert.match(error.message, /redirect/);
      assert.equal(error.retryable, false);
      return true;
    });
  }
});

test('XHR uses bounded timers instead of overflowing native timeout fields', async () => {
  const original = globalThis.XMLHttpRequest;
  let nativeTimeout = 0;
  let aborted = 0;
  class FakeXHR {
    readyState = 0;
    status = 204;
    statusText = '';
    response = null;
    responseType = '';
    withCredentials = false;
    onreadystatechange?: () => void;
    onabort?: () => void;
    set timeout(value: number) { nativeTimeout = value; }
    open() {}
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() {
      if (nativeTimeout > 100) throw new Error('native timeout overflow');
    }
    abort() { aborted++; this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeXHR as never;
  try {
    const controller = new AbortController();
    const pending = createXhrAdapter()({ url: 'https://example.test', method: 'GET', headers: new Headers(), timeout: 2 ** 40, signal: controller.signal } as never);
    const rejected = assert.rejects(pending, code('ERR_CANCELED'));
    await tick();
    controller.abort();
    await rejected;
    assert.equal(nativeTimeout, 0);
    await assert.rejects(createXhrAdapter()({ url: 'https://example.test', method: 'GET', headers: new Headers(), timeout: 5 } as never), code('ETIMEDOUT'));
    assert.equal(aborted, 2);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('direct XHR rejects explicit null timeout', async () => {
  await assert.rejects(createXhrAdapter()({ url: 'https://example.test', method: 'GET', headers: new Headers(), timeout: null } as never), code('ERR_INVALID_CONFIG'));
});
