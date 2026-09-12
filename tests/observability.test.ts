import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLogger } from '../dist/observability/request-logger.js';

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
