import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { startBrowserServers } from './server.js';

const test = base.extend<{}, { servers: Awaited<ReturnType<typeof startBrowserServers>> }>({
  servers: [async ({}, use) => {
    const servers = await startBrowserServers();
    try { await use(servers); }
    finally { await servers.close(); }
  }, { scope: 'worker' }],
});

test.beforeEach(async ({ page, servers }) => {
  await page.goto(servers.appOrigin);
});

test('the published root ESM entry imports and performs a browser request', async ({ page, servers }) => {
  const result = await page.evaluate(async (apiOrigin) => {
    const entry = '/dist/index.js';
    const { createHttpClient, createFetchAdapter, createXhrAdapter } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin });
    try {
      const response = await client.getResponse('/root-import');
      return {
        status: response.status,
        method: response.data.method,
        fetchAdapter: typeof createFetchAdapter,
        xhrAdapter: typeof createXhrAdapter,
      };
    } finally { await client.close(); }
  }, servers.apiOrigin);
  expect(result).toEqual({ status: 200, method: 'GET', fetchAdapter: 'function', xhrAdapter: 'function' });
});

for (const transport of ['fetch', 'xhr'] as const) {
  test(`${transport}: cross-origin credentials default to same-origin and allow explicit include`, async ({ page, context, servers }) => {
    await context.addCookies([{ name: 'session', value: 'browser-session', url: servers.apiOrigin }]);
    const result = await page.evaluate(async ({ apiOrigin, transport }) => {
      const entry = '/dist/index.js';
      const { createHttpClient, createXhrAdapter } = await import(entry);
      const client = createHttpClient({
        baseURL: apiOrigin,
        ...(transport === 'xhr' ? { adapter: createXhrAdapter() } : {}),
      });
      try {
        const defaultResult = await client.get('/credentials-default');
        const included = await client.get('/credentials-include', { credentials: 'include' });
        return { defaultCookie: defaultResult.cookie, includedCookie: included.cookie };
      } finally { await client.close(); }
    }, { apiOrigin: servers.apiOrigin, transport });
    expect(result).toEqual({ defaultCookie: '', includedCookie: 'session=browser-session' });
  });
}

test('default GET avoids preflight while opt-in request IDs produce the CORS header and preflight', async ({ page, servers }) => {
  const prefix = `/request-id-${randomUUID()}`;
  const result = await page.evaluate(async ({ apiOrigin, prefix }) => {
    const entry = '/dist/index.js';
    const { createHttpClient } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin });
    try {
      const plain = await client.get(`${prefix}/plain`);
      const traced = await client.get(`${prefix}/traced`, { requestId: () => 'browser-request-id' });
      return { plain: plain.requestId, traced: traced.requestId };
    } finally { await client.close(); }
  }, { apiOrigin: servers.apiOrigin, prefix });
  expect(result).toEqual({ plain: '', traced: 'browser-request-id' });
  const plain = servers.requests.filter((request) => request.path === `${prefix}/plain`);
  expect(plain.map((request) => request.method)).toEqual(['GET']);
  const traced = servers.requests.filter((request) => request.path === `${prefix}/traced`);
  expect(traced.map((request) => request.method)).toEqual(['OPTIONS', 'GET']);
  expect(traced[0].preflightHeaders.split(',').map((header) => header.trim())).toContain('x-request-id');
});

test('XHR posts JSON through the real browser adapter', async ({ page, servers }) => {
  const result = await page.evaluate(async (apiOrigin) => {
    const entry = '/dist/index.js';
    const { createHttpClient, createXhrAdapter } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin, adapter: createXhrAdapter() });
    try {
      const response = await client.postResponse('/xhr-json', { message: '浏览器', count: 2 });
      return { status: response.status, method: response.data.method, data: response.data.data };
    } finally { await client.close(); }
  }, servers.apiOrigin);
  expect(result).toEqual({ status: 200, method: 'POST', data: { message: '浏览器', count: 2 } });
});

test('XHR abort rejects with ERR_CANCELED and closes the server response', async ({ page, servers }) => {
  const path = `/xhr-abort-${randomUUID()}`;
  const channel = servers.openChannel(path);
  await page.exposeFunction('waitForServerRequest', () => channel.started.promise);
  const result = await page.evaluate(async ({ apiOrigin, path }) => {
    const entry = '/dist/index.js';
    const { createHttpClient, createXhrAdapter } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin, adapter: createXhrAdapter() });
    const controller = new AbortController();
    try {
      const pending = client.get(path, { signal: controller.signal }).then(
        () => ({ code: 'unexpected-success', isAbort: false }),
        (error: { code: string; isAbort: boolean }) => ({ code: error.code, isAbort: error.isAbort }),
      );
      await (globalThis as unknown as { waitForServerRequest(): Promise<void> }).waitForServerRequest();
      controller.abort();
      return await pending;
    } finally { await client.close(); }
  }, { apiOrigin: servers.apiOrigin, path });
  expect(result).toEqual({ code: 'ERR_CANCELED', isAbort: true });
  await channel.closed.promise;
});

test('canceling a raw Fetch response reader reaches the server', async ({ page, servers }) => {
  const path = `/raw-cancel-${randomUUID()}`;
  const channel = servers.openChannel(path);
  const result = await page.evaluate(async ({ apiOrigin, path }) => {
    const entry = '/dist/index.js';
    const { createHttpClient } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin });
    try {
      const response = await client.get(path, { responseType: 'response' });
      const reader = response.body.getReader();
      const first = await reader.read();
      await reader.cancel('consumer finished');
      const afterCancel = await reader.read();
      return { first: new TextDecoder().decode(first.value), done: afterCancel.done };
    } finally { await client.close(); }
  }, { apiOrigin: servers.apiOrigin, path });
  expect(result).toEqual({ first: 'ready\n', done: true });
  await channel.closed.promise;
});

test('AbortSignal remains active after raw Fetch response headers arrive', async ({ page, servers }) => {
  const path = `/raw-abort-${randomUUID()}`;
  const channel = servers.openChannel(path);
  const result = await page.evaluate(async ({ apiOrigin, path }) => {
    const entry = '/dist/index.js';
    const { createHttpClient } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin });
    const controller = new AbortController();
    try {
      const response = await client.get(path, { responseType: 'response', signal: controller.signal });
      const reader = response.body.getReader();
      const first = await reader.read();
      const pending = reader.read().then(
        () => 'unexpected-success',
        (error: Error) => error.name,
      );
      controller.abort();
      return { first: new TextDecoder().decode(first.value), errorName: await pending };
    } finally { await client.close(); }
  }, { apiOrigin: servers.apiOrigin, path });
  expect(result).toEqual({ first: 'ready\n', errorName: 'AbortError' });
  await channel.closed.promise;
});

test('ambient cookies bypass unpartitioned cache and explicit partitions isolate cached sessions', async ({ page, servers }) => {
  const path = `/cache-session-${randomUUID()}`;
  const result = await page.evaluate(async ({ apiOrigin, path }) => {
    const entry = '/dist/index.js';
    const { createHttpClient } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin, credentials: 'include', cache: { ttl: 60_000 } });
    try {
      document.cookie = 'session=alpha; Path=/; SameSite=Lax';
      const alpha = await client.get(path);
      document.cookie = 'session=beta; Path=/; SameSite=Lax';
      const beta = await client.get(path);
      const betaCached = await client.get(path, { cache: { ttl: 60_000, partition: 'beta' } });
      const betaHit = await client.get(path, { cache: { ttl: 60_000, partition: 'beta' } });
      document.cookie = 'session=gamma; Path=/; SameSite=Lax';
      const gamma = await client.get(path, { cache: { ttl: 60_000, partition: 'gamma' } });
      const betaPartition = await client.get(path, { cache: { ttl: 60_000, partition: 'beta' } });
      return [alpha, beta, betaCached, betaHit, gamma, betaPartition].map(
        ({ cookie, count }: { cookie: string; count: number }) => ({ cookie, count }),
      );
    } finally { await client.close(); }
  }, { apiOrigin: servers.apiOrigin, path });
  expect(result).toEqual([
    { cookie: 'session=alpha', count: 1 },
    { cookie: 'session=beta', count: 2 },
    { cookie: 'session=beta', count: 3 },
    { cookie: 'session=beta', count: 3 },
    { cookie: 'session=gamma', count: 4 },
    { cookie: 'session=beta', count: 3 },
  ]);
  expect(servers.requests.filter((request) => request.path === path && request.method === 'GET')).toHaveLength(4);
});

test('browser Fetch snapshots respect server no-store responses', async ({ page, servers }) => {
  const path = `/no-store-${randomUUID()}`;
  const result = await page.evaluate(async ({ apiOrigin, path }) => {
    const entry = '/dist/index.js';
    const { createHttpClient } = await import(entry);
    const client = createHttpClient({ baseURL: apiOrigin, credentials: 'omit', cache: { ttl: 60_000 } });
    try {
      return [(await client.get(path)).count, (await client.get(path)).count];
    } finally { await client.close(); }
  }, { apiOrigin: servers.apiOrigin, path });
  expect(result).toEqual([1, 2]);
  expect(servers.requests.filter((request) => request.path === path && request.method === 'GET')).toHaveLength(2);
});
