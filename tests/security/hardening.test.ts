import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, createCsrfInterceptor, AxiosHeaders, HttpError } from '../../dist/index.js';
import { resolveURL } from '../../dist/utils/query.js';
import { createRequestLogger } from '../../dist/observability/request-logger.js';

for (const path of ['h\tttp://evil.test', 'h\nttp://evil.test', '/\r/evil.test', '\thttps://evil.test']) {
  test(`rejects URL controls ${JSON.stringify(path)}`, () => {
    assert.throws(() => resolveURL('', path, false), /control/i);
    assert.throws(() => resolveURL(path, '/safe'), /control/i);
  });
}

test('csrf defaults to trusted base origin and allows explicitly listed origins', () => {
  const interceptor = createCsrfInterceptor({ readToken: () => 'private', allowedOrigins: ['https://partner.test'] });
  for (const [url, expected] of [['https://evil.test/x', undefined], ['/local', 'private'], ['https://partner.test/x', 'private']]) {
    const result = interceptor({ method: 'POST', baseURL: 'https://api.test', url, credentials: 'omit' });
    assert.equal(AxiosHeaders.from(result.headers).get('X-CSRF-Token'), expected);
  }
  assert.equal(AxiosHeaders.from(interceptor({ method: 'POST', url: 'https://unknown.test' }).headers).get('X-CSRF-Token'), undefined);
});

test('csrf refresh removes empty tokens on retry and sends no internal marker', async () => {
  let token = 'old';
  const sent: Headers[] = [];
  const client = createHttpClient({ baseURL: 'https://api.test', retry: { limit: 1, beforeRetry: () => { token = ''; } }, retryUnsafeMethods: true, adapter: async (config) => {
    sent.push(new Headers(config.headers));
    return new Response('{}', { status: sent.length === 1 ? 503 : 200 });
  } });
  client.interceptors.request.use(createCsrfInterceptor({ readToken: () => token }));
  await client.post('/local');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].get('X-CSRF-Token'), 'old');
  assert.equal(sent[1].has('X-CSRF-Token'), false);
  assert.equal(sent.some((headers) => headers.has('x-csrf-token-injected')), false);
});

test('csrf removes its token when a retry changes origin or method but preserves explicit tokens', () => {
  const interceptor = createCsrfInterceptor({ readToken: () => 'private' });
  const initial = interceptor({ method: 'POST', baseURL: 'https://api.test', url: '/local' });
  for (const patch of [{ url: 'https://evil.test' }, { method: 'GET' }]) {
    assert.equal(AxiosHeaders.from(interceptor({ ...initial, ...patch }).headers).get('X-CSRF-Token'), undefined);
  }
  assert.equal(AxiosHeaders.from(interceptor({ method: 'POST', url: '/x', headers: { 'X-CSRF-Token': 'explicit' } }).headers).get('X-CSRF-Token'), 'explicit');
});

test('logger redacts encoded repeated query secrets across every emission and nested errors', () => {
  const records: any[] = [];
  const logger = createRequestLogger((record) => records.push(record), { redactQueryParams: ['private_key'], redactError: (error) => typeof error === 'object' && error ? { ...error, message: String(error.message).replaceAll('custom-secret', '[REDACTED]') } : error });
  const url = '/x?TOKEN=secret-one&%74oken=secret-two&private_key=secret-three&page=2';
  logger.start({ method: 'GET', url }).complete();
  logger.start({ method: 'GET', url }).error({ error: new Error(`failed ${url} custom-secret`) });
  logger.record({ phase: 'error', url, error: `failed ${url}` });
  logger.complete({ url });
  logger.error({ url, error: new Error(url) });
  logger.error({ url, error: new HttpError(`failed ${url}`, { config: { method: 'GET', url, headers: new Headers(), body: undefined } }) });
  const output = JSON.stringify(records);
  for (const secret of ['secret-one', 'secret-two', 'secret-three', 'custom-secret']) assert.equal(output.includes(secret), false);
  for (const record of records) assert.ok(record.url.includes('page=2'));
});


test('csrf uses client baseURL for absolute same-origin requests', async () => {
  const sent: string[] = [];
  const client = createHttpClient({ baseURL: 'https://api.test', adapter: async (config) => {
    sent.push(config.headers.get('X-CSRF-Token') ?? 'none');
    return new Response('{}');
  } });
  client.interceptors.request.use(createCsrfInterceptor({ readToken: () => 'private' }));
  await client.post('https://api.test/local');
  await client.post('https://evil.test/local');
  assert.deepEqual(sent, ['private', 'none']);
});

test('csrf browser origin and protocol-relative URLs use the resolved authority', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://app.test/home' } });
  try {
    const interceptor = createCsrfInterceptor({ readToken: () => 'private' });
    for (const [url, expected] of [['/local', 'private'], ['//app.test/x', 'private'], ['//evil.test/x', undefined], ['https://app.test.evil.test/x', undefined]]) {
      assert.equal(AxiosHeaders.from(interceptor({ method: 'POST', url }).headers).get('X-CSRF-Token'), expected);
    }
    const disabled = interceptor({ method: 'POST', url: '/x', headers: new AxiosHeaders({ 'X-CSRF-Token': false }) });
    assert.equal(AxiosHeaders.from(disabled.headers).isDisabled('X-CSRF-Token'), true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});

test('csrf final dispatch removes injected tokens after later interceptor rewrites', async () => {
  const sent: Headers[] = [];
  const client = createHttpClient({ baseURL: 'https://api.test', adapter: async (config) => {
    sent.push(new Headers(config.headers));
    return new Response('{}');
  } });
  client.interceptors.request.use(createCsrfInterceptor({ readToken: () => 'private' }));
  client.interceptors.request.use((config) => ({ ...config, url: 'https://evil.test/x' }));
  await client.post('/local');
  assert.equal(sent[0].has('X-CSRF-Token'), false);
});

test('csrf automatically injected headers cannot follow cross-origin redirects', async () => {
  const { createServer } = await import('node:http');
  let externalRequests = 0;
  const external = createServer((_request, response) => { externalRequests++; response.end('{}'); });
  await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${external.address().port}`;
  const trusted = createServer((_request, response) => { response.writeHead(302, { Location: target }); response.end(); });
  await new Promise<void>((resolve) => trusted.listen(0, '127.0.0.1', resolve));
  try {
    const client = createHttpClient({ baseURL: `http://127.0.0.1:${trusted.address().port}` });
    client.interceptors.request.use(createCsrfInterceptor({ readToken: () => 'private' }));
    client.interceptors.request.use((config) => ({ method: config.method, url: config.url, headers: config.headers }));
    await assert.rejects(client.post('/redirect'));
    assert.equal(externalRequests, 0);
  } finally {
    trusted.closeAllConnections();
    external.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => trusted.close(() => resolve())), new Promise<void>((resolve) => external.close(() => resolve()))]);
  }
});

test('csrf final origin validation accepts resolved URLs without weakening absolute URL input policy', async () => {
  const sent: string[] = [];
  const client = createHttpClient({ baseURL: 'https://api.test', allowAbsoluteURL: false, adapter: async (config) => {
    sent.push(config.headers.get('X-CSRF-Token') ?? 'none');
    assert.equal(config.url, 'https://api.test/relative');
    return new Response('{}');
  } });
  client.interceptors.request.use(createCsrfInterceptor({ readToken: () => 'private' }));
  await client.post('/relative');
  assert.deepEqual(sent, ['private']);
  await assert.rejects(client.post('https://api.test/relative'));
  await assert.rejects(client.post('https://evil.test/relative'));
  assert.equal(sent.length, 1);
});

test('csrf provenance survives interceptors returning fresh configuration objects', async () => {
  const sent: Array<{ token: string | null; redirect: string | undefined }> = [];
  const client = createHttpClient({ baseURL: 'https://api.test', adapter: async (config) => {
    sent.push({ token: config.headers.get('X-CSRF-Token'), redirect: config.redirect });
    return new Response('{}');
  } });
  client.interceptors.request.use(createCsrfInterceptor({ readToken: () => 'private' }));
  let url = 'https://evil.test/x';
  client.interceptors.request.use((config) => ({ method: config.method, url, headers: config.headers }));
  await client.post('/local');
  url = 'https://api.test/x';
  await client.post('/local');
  assert.deepEqual(sent, [{ token: null, redirect: undefined }, { token: 'private', redirect: 'error' }]);
});

test('logger redacts the entire sensitive query value when it contains literal spaces', () => {
  const records: any[] = [];
  const logger = createRequestLogger((record) => records.push(record));
  const url = '/reset?token=private first secret&page=2';
  logger.start({ method: 'GET', url }).error({ error: new Error(`failed ${url}`) });
  assert.deepEqual(records.map((record) => record.url), ['/reset?token=[REDACTED]&page=2', '/reset?token=[REDACTED]&page=2']);
  assert.equal(records[1].error.message, 'failed /reset?token=[REDACTED]&page=2');
});

test('csrf provenance survives rejected interceptors recovering with fresh configs', async () => {
  const sent: Array<{ token: string | null; redirect: string | undefined }> = [];
  const client = createHttpClient({ baseURL: 'https://api.test', adapter: async (config) => {
    sent.push({ token: config.headers.get('X-CSRF-Token'), redirect: config.redirect });
    return new Response('{}');
  } });
  let captured: any;
  let url = 'https://evil.test/recovered';
  client.interceptors.request.use(createCsrfInterceptor({ readToken: () => 'private' }));
  client.interceptors.request.use((config) => { captured = config; throw new Error('recover'); });
  client.interceptors.request.use(undefined, () => ({ method: captured.method, url, headers: captured.headers }));
  await client.post('/local');
  url = 'https://api.test/recovered';
  await client.post('/local');
  assert.deepEqual(sent, [{ token: null, redirect: undefined }, { token: 'private', redirect: 'error' }]);
});
