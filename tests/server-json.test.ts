import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosHeaders, HttpError } from '../dist/index.js';
import { fetchJson, fetchJsonResult } from '../dist/server/json.js';

test('fetchJson forwards cookies and normalizes JSON responses', async () => {
  let receivedCookie = '';
  const data = await fetchJson<{ ok: boolean }>('https://api.example.test/health', {
    cookie: 'session=abc',
    fetch: async (_input, init) => {
      receivedCookie = new Headers(init?.headers).get('cookie') || '';
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(receivedCookie, 'session=abc');
  assert.deepEqual(data, { ok: true });
});

test('fetchJsonResult preserves status and Headers instance values', async () => {
  let seenHeaders: Headers | undefined;
  const result = await fetchJsonResult<{ ok: boolean }>('https://api.example.test/missing', {
    headers: new Headers({ 'X-Test': 'yes' }),
    cookie: 'sid=abc',
    fetch: async (_url, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response('{"ok":false}', { status: 404 });
    },
  });

  assert.equal(result.status, 404);
  assert.equal(result.data, null);
  assert.equal(seenHeaders?.get('x-test'), 'yes');
  assert.equal(seenHeaders?.get('cookie'), 'sid=abc');
});

test('fetchJson accepts AxiosHeaders and enforces maxBodySize', async () => {
  let seenHeaders: Headers | undefined;
  await assert.rejects(
    fetchJson('https://api.example.test/large', {
      headers: new AxiosHeaders({ 'X-Test': 'yes' }),
      maxBodySize: 3,
      fetch: async (_url, init) => {
        seenHeaders = new Headers(init?.headers);
        return new Response('{"ok":true}', { status: 200 });
      },
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_MAX_BODY_SIZE',
  );
  assert.equal(seenHeaders?.get('x-test'), 'yes');
});

test('fetchJson does not parse non-success payloads', async () => {
  let parserCalls = 0;
  const result = await fetchJsonResult('https://api.example.test/missing', {
    parseJson: () => {
      parserCalls += 1;
      throw new Error('must not parse');
    },
    fetch: async () => new Response('{broken', { status: 500 }),
  });
  assert.equal(result.data, null);
  assert.equal(result.status, 500);
  assert.equal(parserCalls, 0);
});

test('fetchJson preserves external cancellation during parsing', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2);
  await assert.rejects(
    fetchJson('https://api.example.test/cancelled', {
      signal: controller.signal,
      fetch: async () => new Response('{}', { status: 200 }),
      parseJson: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof DOMException, true);
      assert.equal((error as DOMException).name, 'AbortError');
      return true;
    },
  );
});

test('fetchJson accepts the AVMCBBS-compatible timeoutMs alias', async () => {
  await assert.rejects(
    fetchJson('https://api.example.test/slow', {
      timeoutMs: 1,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('fetchJson aborts a response body read when timeout expires', async () => {
  await assert.rejects(
    Promise.race([
      fetchJson('https://api.example.test/slow-body', {
        timeout: 5,
        fetch: async () => new Response(new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => {}),
        }), { status: 200 }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('body read hung')), 100)),
    ]),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('fetchJson aborts a pending JSON parser when timeout expires', async () => {
  await assert.rejects(
    Promise.race([
      fetchJson('https://api.example.test/slow-parser', {
        timeout: 5,
        fetch: async () => new Response('{}', { status: 200 }),
        parseJson: async () => new Promise(() => undefined),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('parser hung')), 100)),
    ]),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('fetchJson maps parser failures to ERR_BAD_PAYLOAD', async () => {
  await assert.rejects(
    fetchJson('https://api.example.test/invalid', {
      fetch: async () => new Response('{"broken":true}', { status: 200 }),
      parseJson: () => { throw new Error('parser failed'); },
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_BAD_PAYLOAD',
  );
});

test('fetchJson validates parsed JSON with a Standard Schema', async () => {
  const schema = {
    '~standard': {
      validate(value: unknown) {
        return typeof value === 'object' && value !== null && 'ok' in value
          ? { value }
          : { issues: [{ message: 'expected an ok property' }] };
      },
    },
  };
  const data = await fetchJson<{ ok: boolean }>('https://api.example.test/schema', {
    fetch: async () => new Response('{"ok":true}', { status: 200 }),
    schema,
  });
  assert.deepEqual(data, { ok: true });
});

test('fetchJson maps Standard Schema failures to ERR_SCHEMA_VALIDATION', async () => {
  const schema = {
    '~standard': {
      validate: async () => ({ issues: [{ message: 'invalid payload' }] }),
    },
  };
  await assert.rejects(
    fetchJson('https://api.example.test/schema-error', {
      fetch: async () => new Response('{"ok":false}', { status: 200 }),
      schema,
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'ERR_SCHEMA_VALIDATION',
  );
});

test('fetchJson reports missing fetch implementations clearly', async () => {
  const originalFetch = globalThis.fetch;
  try {
    Reflect.deleteProperty(globalThis, 'fetch');
    await assert.rejects(
      fetchJson('https://api.example.test/missing-fetch'),
      (error: unknown) => error instanceof HttpError && error.code === 'ERR_UNSUPPORTED_ADAPTER',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
