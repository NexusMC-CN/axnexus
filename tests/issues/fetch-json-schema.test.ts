import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../../dist/index.js';

// A schema whose validation never settles. `fetchJson` must still respect its
// timeout and cancellation instead of hanging forever.
function hangingSchema(): never {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => new Promise(() => {}),
    },
  } as never;
}

function jsonFetch(body: unknown): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof globalThis.fetch;
}

test('issue 3: fetchJson applies its timeout to a hanging async schema', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = jsonFetch({ ok: true });
  const started = Date.now();
  try {
    await assert.rejects(
      fetchJson('/slow-schema', { schema: hangingSchema(), timeoutMs: 60 }),
      // Matches the existing fetchJson timeout contract (an AbortError).
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    // It must settle because of the timeout, not because the work finished.
    assert.equal(Date.now() - started < 2_000, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('issue 3: fetchJson applies an external abort to a hanging async schema', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = jsonFetch({ ok: true });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const started = Date.now();
  try {
    await assert.rejects(
      fetchJson('/aborted-schema', { schema: hangingSchema(), signal: controller.signal }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    assert.equal(Date.now() - started < 2_000, true);
  } finally {
    globalThis.fetch = original;
  }
});
