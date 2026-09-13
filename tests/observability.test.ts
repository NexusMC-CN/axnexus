import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLogger } from '../dist/observability/request-logger.js';
import { AxiosHeaders, HttpError } from '../dist/index.js';

test('request logger emits lifecycle records with redacted headers', () => {
  const records: unknown[] = [];
  const logger = createRequestLogger((record) => records.push(record), {
    redactHeaders: ['authorization', 'cookie'],
  });

  logger.start({ method: 'GET', url: 'https://api.example.test/items', headers: {
    Authorization: 'Bearer secret',
    Cookie: 'session=secret',
  } });
  logger.complete({ status: 200, duration: 12, responseBytes: 42 });

  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    phase: 'start',
    method: 'GET',
    url: 'https://api.example.test/items',
    headers: { authorization: '[REDACTED]', cookie: '[REDACTED]' },
  });
  assert.deepEqual(records[1], {
    phase: 'complete',
    status: 200,
    duration: 12,
    responseBytes: 42,
  });
});

test('logger start returns a handle that fills lifecycle identity and duration', () => {
  const records: unknown[] = [];
  let now = 100;
  const logger = createRequestLogger((record) => records.push(record), { now: () => now });
  const handle = logger.start({ method: 'post', url: '/upload' });
  now = 145;
  handle.complete({ status: 201, responseBytes: 7 });
  handle.error({ error: new Error('ignored after completion') });

  assert.deepEqual(records, [
    { phase: 'start', method: 'POST', url: '/upload', headers: {} },
    { phase: 'complete', method: 'POST', url: '/upload', headers: {}, status: 201, responseBytes: 7, duration: 45 },
  ]);
});

test('compatibility logger methods redact sensitive headers', () => {
  const records: unknown[] = [];
  const logger = createRequestLogger((record) => records.push(record));

  logger.complete({
    method: 'GET',
    url: '/private',
    headers: { Authorization: 'Bearer secret', Cookie: 'sid=secret', 'X-Trace': 'ok' },
  });
  logger.error({
    method: 'GET',
    url: '/private',
    headers: { 'Set-Cookie': 'sid=secret' },
  });

  assert.deepEqual(records, [
    {
      method: 'GET',
      url: '/private',
      headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', 'x-trace': 'ok' },
      phase: 'complete',
    },
    {
      method: 'GET',
      url: '/private',
      headers: { 'set-cookie': '[REDACTED]' },
      phase: 'error',
    },
  ]);
});

test('logger compatibility records redact sensitive headers', () => {
  const records: unknown[] = [];
  const logger = createRequestLogger((record) => records.push(record));

  logger.complete({
    method: 'GET',
    url: '/complete',
    headers: {
      Authorization: 'Bearer complete-secret',
      Cookie: 'session=complete-secret',
      'Set-Cookie': 'session=complete-secret',
    },
  });
  logger.error({
    method: 'GET',
    url: '/error',
    headers: {
      Authorization: 'Bearer error-secret',
      Cookie: 'session=error-secret',
      'Set-Cookie': 'session=error-secret',
    },
  });

  assert.deepEqual(records, [
    {
      phase: 'complete',
      method: 'GET',
      url: '/complete',
      headers: {
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        'set-cookie': '[REDACTED]',
      },
    },
    {
      phase: 'error',
      method: 'GET',
      url: '/error',
      headers: {
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        'set-cookie': '[REDACTED]',
      },
    },
  ]);
});

test('logger sanitizes nested HttpError configuration before emitting', () => {
  const records: Array<{ error?: unknown }> = [];
  const logger = createRequestLogger((record) => records.push(record));
  const error = new HttpError('forbidden', {
    code: 'ERR_BAD_RESPONSE',
    status: 403,
    config: {
      method: 'GET',
      url: 'https://api.example.test/private',
      headers: new Headers({ Authorization: 'Bearer nested-secret', Cookie: 'sid=nested-secret' }),
      body: undefined,
    },
  });

  logger.error({ method: 'GET', url: error.config?.url, error });

  const emitted = records[0]?.error as { config?: { headers?: Record<string, string> }; message?: string };
  assert.equal(emitted?.message, 'forbidden');
  assert.deepEqual(emitted?.config?.headers, {
    authorization: '[REDACTED]',
    cookie: '[REDACTED]',
  });
  assert.equal(JSON.stringify(records).includes('nested-secret'), false);
});

test('logger accepts AxiosHeaders and omits disabled header sentinels', () => {
  const records: unknown[] = [];
  const logger = createRequestLogger((record) => records.push(record));
  const headers = new AxiosHeaders({ Authorization: 'Bearer secret', Accept: false });
  logger.start({ method: 'GET', url: '/headers', headers }).complete();
  assert.deepEqual(records[0], {
    phase: 'start',
    method: 'GET',
    url: '/headers',
    headers: { authorization: '[REDACTED]' },
  });
});
