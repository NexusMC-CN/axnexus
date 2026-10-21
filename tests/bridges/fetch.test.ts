import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createFetchHandler } from '../../dist/bridges/index.js';
import { HttpError } from '../../dist/core/errors.js';
import { AxiosHeaders } from '../../dist/headers/headers.js';

async function serve(run: (url: string) => Promise<void>) {
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/echo' }).end();
      return;
    }
    if (request.url === '/slow') return;
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      const timer = setTimeout(() => response.end('data: last\n\n'), 20);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(request.url === '/failure' ? 409 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('Fetch bridge preserves a Request and applies init overrides without JSON encoding its body', async () => {
  await serve(async (url) => {
    const fetch = createFetchHandler();
    try {
      const request = new Request(`${url}/echo`, { method: 'POST', headers: { 'x-old': 'old' }, body: 'original' });
      const response = await fetch(request, { method: 'PUT', headers: { 'x-new': 'new' }, body: 'replacement' });
      const data = await response.json();
      assert.equal(data.method, 'PUT');
      assert.equal(data.headers['x-new'], 'new');
      assert.equal(data.headers['x-old'], undefined);
      assert.equal(data.body, 'replacement');
    } finally { await fetch.close(); }
  });
});

test('Fetch bridge preserves multipart boundary and binary upload bytes', async () => {
  await serve(async (url) => {
    const fetch = createFetchHandler();
    try {
      const form = new FormData();
      form.set('name', '桥接');
      form.set('file', new Blob(['binary payload']), 'data.bin');
      const request = new Request(`${url}/echo`, { method: 'POST', body: form });
      const contentType = request.headers.get('content-type');
      const multipart = await (await fetch(request)).json();
      assert.equal(multipart.headers['content-type'], contentType);
      const boundary = contentType!.split('boundary=')[1];
      assert.ok(multipart.body.includes(`--${boundary}`));
      assert.ok(multipart.body.includes('name="name"'));
      assert.ok(multipart.body.includes('桥接'));
      assert.ok(multipart.body.includes('binary payload'));
      const binary = await (await fetch(new URL(`${url}/echo`), { method: 'POST', body: new Uint8Array([0, 65, 66]) })).json();
      assert.equal(binary.body, '\0AB');
    } finally { await fetch.close(); }
  });
});

test('Fetch bridge hands manual redirects and non-2xx bodies back to its caller', async () => {
  await serve(async (url) => {
    const fetch = createFetchHandler();
    try {
      const redirect = await fetch(`${url}/redirect`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), '/echo');
      await redirect.body?.cancel();
      const failure = await fetch(`${url}/failure`);
      assert.equal(failure.status, 409);
      assert.equal(failure.bodyUsed, false);
      assert.equal((await failure.json()).method, 'GET');
    } finally { await fetch.close(); }
  });
});

test('Fetch bridge returns SSE before EOF and does not consume its body', async () => {
  await serve(async (url) => {
    const fetch = createFetchHandler();
    try {
      const response = await fetch(`${url}/events`);
      assert.equal(response.bodyUsed, false);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
      await reader.cancel();
    } finally { await fetch.close(); }
  });
});

test('Fetch bridge cancellation reaches the transport and used bodies reject before I/O', async () => {
  await serve(async (url) => {
    const fetch = createFetchHandler();
    try {
      const controller = new AbortController();
      const pending = fetch(new Request(`${url}/slow`, { signal: controller.signal }));
      controller.abort();
      await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.isAbort);
      const request = new Request(`${url}/echo`, { method: 'POST', body: 'once' });
      await request.text();
      await assert.rejects(fetch(request), TypeError);
    } finally { await fetch.close(); }
  });
});

test('Fetch bridge forces one attempt, raw responses, no cache and closes its adapter', async () => {
  let calls = 0;
  let closed = 0;
  const adapter = Object.assign(async () => {
    calls++;
    return new Response('busy', { status: 503 });
  }, { closeTransport() { closed++; } });
  const fetch = createFetchHandler({ adapter });
  assert.equal(await (await fetch('https://bridge.example.test/')).text(), 'busy');
  assert.equal(await (await fetch('https://bridge.example.test/')).text(), 'busy');
  assert.equal(calls, 2);
  await fetch.close();
  assert.equal(closed, 1);
});

test('Fetch bridge releases stream resources after cancellation and EOF', async () => {
  let released = 0;
  let canceled = 0;
  const adapter = Object.assign(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('one')); },
    cancel() { canceled++; },
  })), { releaseStream() { released++; } });
  const fetch = createFetchHandler({ adapter });
  const response = await fetch('https://bridge.example.test/');
  assert.equal(released, 0);
  await response.body!.cancel();
  assert.equal(canceled, 1);
  assert.equal(released, 1);
  await fetch.close();
  let eofReleased = 0;
  const eofFetch = createFetchHandler({ adapter: Object.assign(async () => new Response('done'), {
    releaseStream() { eofReleased++; },
  }) });
  assert.equal(await (await eofFetch('https://bridge.example.test/')).text(), 'done');
  assert.equal(eofReleased, 1);
  await eofFetch.close();
});

test('Fetch init signal overrides a Request signal and preserves native request policies', async () => {
  const controller = new AbortController();
  controller.abort();
  let seen: unknown;
  const fetch = createFetchHandler({ adapter: async (config) => {
    seen = { redirect: config.redirect, cache: config.fetchCache, credentials: config.credentials,
      referrerPolicy: config.referrerPolicy, aborted: config.signal?.aborted };
    return new Response('ok');
  } });
  const request = new Request('https://bridge.example.test/', { signal: controller.signal,
    redirect: 'follow', cache: 'force-cache', credentials: 'include' });
  const response = await fetch(request, { signal: new AbortController().signal,
    redirect: 'manual', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(seen, { redirect: 'manual', cache: 'no-store', credentials: 'omit',
    referrerPolicy: 'no-referrer', aborted: false });
  await fetch.close();
});

test('Fetch bridge transmits a one-shot request stream exactly once', async () => {
  await serve(async (url) => {
    let reads = 0;
    const body = new ReadableStream({ pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode('streamed'));
      controller.close();
    } });
    const fetch = createFetchHandler();
    try {
      const request = new Request(`${url}/echo`, { method: 'POST', body, duplex: 'half' } as RequestInit);
      assert.equal((await (await fetch(request)).json()).body, 'streamed');
      assert.equal(reads, 1);
      await assert.rejects(fetch(request), TypeError);
    } finally { await fetch.close(); }
  });
});

test('untyped Fetch options cannot install body-consuming schema or transforms', async () => {
  const fetch = createFetchHandler({ adapter: async () => new Response('raw body'),
    schema: { '~standard': { validate() { throw new Error('must not run'); } } },
    transformResponse() { throw new Error('must not run'); },
  } as never);
  assert.equal(await (await fetch('https://bridge.example.test/')).text(), 'raw body');
  await fetch.close();
});

test('Fetch bridge keeps method-specific header defaults inside their method', async () => {
  const seen: Array<{ method: string; authorization: string | null; accept: string | null }> = [];
  const headers = { common: { 'x-common': 'shared' }, post: { Authorization: 'write-only', Accept: 'application/custom' } };
  const fetch = createFetchHandler({ headers, adapter: async (config) => {
    seen.push({ method: config.method, authorization: config.headers.get('authorization'), accept: config.headers.get('accept') });
    assert.equal(config.headers.get('x-common'), 'shared');
    return new Response('ok');
  } });
  for (const method of ['GET', 'POST']) await (await fetch('https://bridge.example.test/', { method })).text();
  assert.deepEqual(seen, [
    { method: 'GET', authorization: null, accept: null },
    { method: 'POST', authorization: 'write-only', accept: 'application/custom' },
  ]);
  assert.deepEqual(headers, { common: { 'x-common': 'shared' }, post: { Authorization: 'write-only', Accept: 'application/custom' } });
  await fetch.close();
});

test('Fetch bridge clones AxiosHeaders before suppressing its implicit JSON Accept', async () => {
  const headers = new AxiosHeaders({ 'x-client': 'value' });
  const fetch = createFetchHandler({ headers, adapter: async (config) => {
    assert.equal(config.headers.get('x-client'), 'value');
    assert.equal(config.headers.get('accept'), null);
    return new Response('ok');
  } });
  assert.equal(headers.has('Accept'), false);
  assert.equal(headers.isDisabled('Accept'), false);
  await (await fetch('https://bridge.example.test/')).text();
  assert.equal(headers.has('Accept'), false);
  assert.equal(headers.isDisabled('Accept'), false);
  await fetch.close();
});

test('Fetch bridge rejects consumed inherited bodies before I/O while allowing an explicit replacement', async () => {
  const bodies: string[] = [];
  const fetch = createFetchHandler({ adapter: async (config) => {
    bodies.push(await new Response(config.body).text());
    return new Response('ok');
  } });
  const request = new Request('https://bridge.example.test/', { method: 'POST', body: 'consumed' });
  await request.text();
  await assert.rejects(fetch(request), TypeError);
  await assert.rejects(fetch(request, { body: null }), TypeError);
  assert.deepEqual(bodies, []);
  assert.equal(await (await fetch(request, { body: 'replacement' })).text(), 'ok');
  assert.deepEqual(bodies, ['replacement']);
  await fetch.close();
});

test('Fetch bridge transfers a Request body once across handlers and rejects locked bodies', async () => {
  let calls = 0;
  const options = { adapter: async (config: { body?: BodyInit | null }) => {
    calls++;
    const text = await new Response(config.body).text();
    return new Response(text);
  } };
  const first = createFetchHandler(options);
  const second = createFetchHandler(options);
  const request = new Request('https://bridge.example.test/', { method: 'POST', body: 'once' });
  const pending = first(request);
  await assert.rejects(second(request), TypeError);
  assert.equal(await (await pending).text(), 'once');
  assert.equal(request.bodyUsed, true);
  const locked = new Request('https://bridge.example.test/', { method: 'POST', body: 'locked' });
  const reader = locked.body!.getReader();
  await assert.rejects(first(locked), TypeError);
  reader.releaseLock();
  assert.equal(calls, 1);
  await first.close();
  await second.close();
});

test('Fetch bridge applies every valid init policy override even when Request cloning omits fields', async () => {
  let seen: unknown;
  const fetch = createFetchHandler({ adapter: async (config) => {
    seen = { credentials: config.credentials, mode: config.mode, redirect: config.redirect,
      referrer: config.referrer, referrerPolicy: config.referrerPolicy, integrity: config.integrity,
      keepalive: config.keepalive, cache: config.fetchCache };
    return new Response('ok');
  } });
  const request = new Request('https://bridge.example.test/', { credentials: 'include', mode: 'cors',
    redirect: 'follow', referrer: 'https://old.example.test/', referrerPolicy: 'origin', integrity: 'old',
    keepalive: false, cache: 'force-cache' });
  const response = await fetch(request, { credentials: 'omit', mode: 'same-origin', redirect: 'manual',
    referrer: 'https://new.example.test/', referrerPolicy: 'no-referrer', integrity: 'new',
    keepalive: true, cache: 'no-store' });
  await response.text();
  assert.deepEqual(seen, { credentials: 'omit', mode: 'same-origin', redirect: 'manual',
    referrer: 'https://new.example.test/', referrerPolicy: 'no-referrer', integrity: 'new',
    keepalive: true, cache: 'no-store' });
  await fetch.close();
});
