import test from 'node:test';
import assert from 'node:assert/strict';
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
