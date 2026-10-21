import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpClient } from '../../dist/core/client.js';
import { HttpError, isHttpError, toError, responseInterceptorError } from '../../dist/core/errors.js';
import * as schemaModule from '../../dist/core/schema.js';
import { fetchJsonResult } from '../../dist/server/json.js';

const config = { url: '/duplicate', method: 'GET', headers: new Headers() };
const otherErrors = await import(new URL('../../dist/core/errors.js?duplicate-core-test', import.meta.url).href);

test('same-version duplicate HttpError modules preserve classification through normalization and interceptors', () => {
  const raw = new Response('');
  const response = { data: null, status: 200, statusText: 'OK', headers: new Headers(), config, raw, protocol: 'unknown', timings: {} };
  for (const flags of [{}, { isAbort: true }, { isTimeout: true }]) {
    const foreign = new otherErrors.HttpError('schema', { code: 'ERR_SCHEMA_VALIDATION', status: 200, response, retryable: false, ...flags });
    assert.equal(isHttpError(foreign), true);
    assert.equal(foreign instanceof HttpError, true);
    const normalized = toError(foreign, config, false, false);
    assert.equal(normalized.code, 'ERR_SCHEMA_VALIDATION');
    assert.equal(normalized.status, 200);
    assert.equal(normalized.response, response);
    assert.equal(normalized.isAbort, Boolean(flags.isAbort));
    assert.equal(normalized.isTimeout, Boolean(flags.isTimeout));
    assert.equal(normalized.retryable, false);
    assert.equal(responseInterceptorError(foreign, config).code, 'ERR_SCHEMA_VALIDATION');
  }
});

test('duplicate module subclasses are recognized without widening local subclass instanceof', () => {
  class LocalError extends HttpError {}
  class ForeignError extends otherErrors.HttpError {}
  const foreign = new ForeignError('foreign', { code: 'ERR_NETWORK' });
  assert.equal(foreign instanceof HttpError, true);
  assert.equal(foreign instanceof LocalError, false);
  assert.equal(new HttpError('base', { code: 'ERR_NETWORK' }) instanceof LocalError, false);
  assert.equal(new LocalError('local', { code: 'ERR_NETWORK' }) instanceof HttpError, true);
  assert.equal(isHttpError({ name: 'HttpError', code: 'ERR_NETWORK', constructor: otherErrors.HttpError }), false);
  assert.equal(isHttpError(Object.assign(new Error('fake'), { name: 'HttpError', code: 'ERR_NETWORK' })), false);
});

test('foreign schema and abort errors do not become retryable network errors', async () => {
  for (const options of [{ code: 'ERR_SCHEMA_VALIDATION', retryable: false }, { code: 'ERR_CANCELED', isAbort: true }]) {
    let calls = 0;
    const client = createHttpClient({ retry: { limit: 1, delay: 0 }, adapter: async () => { calls += 1; throw new otherErrors.HttpError('foreign', options); } });
    await assert.rejects(client.get('/duplicate'), (error) => isHttpError(error) && error.code === options.code);
    assert.equal(calls, 1);
  }
});

test('response interceptor foreign errors preserve their classification and stay non-retryable', async () => {
  let calls = 0;
  const client = createHttpClient({ retry: { limit: 1, delay: 0 }, adapter: async () => { calls += 1; return new Response('{}'); } });
  client.interceptors.response.use(() => { throw new otherErrors.HttpError('foreign interceptor', { code: 'ERR_SCHEMA_VALIDATION', status: 200, retryable: true }); });
  await assert.rejects(client.get('/interceptor'), (error) => isHttpError(error) && error.code === 'ERR_SCHEMA_VALIDATION' && error.status === 200 && !error.retryable);
  assert.equal(calls, 1);
});

test('invalid validator results fail with public typed schema diagnostics', async () => {
  assert.equal(typeof schemaModule.SchemaValidationError, 'function');
  assert.equal(typeof schemaModule.isSchemaValidationError, 'function');
  for (const result of [{}, null, undefined, { issues: null }, { issues: 'wrong' }, { issues: [null] }]) {
    await assert.rejects(schemaModule.validateStandardSchema('input', { '~standard': { validate: () => result } }), (error) => {
      assert.equal(schemaModule.isSchemaValidationError(error), true);
      assert.ok(Array.isArray(error.issues));
      return true;
    });
  }
  assert.equal(await schemaModule.validateStandardSchema('input', { '~standard': { validate: () => ({ value: undefined }) } }), undefined);
});

test('standard schema success, asynchronous conversion, and empty issue failures remain distinct', async () => {
  assert.equal(await schemaModule.validateStandardSchema('42', { '~standard': { version: 1, vendor: 'fixture', validate: async (value) => ({ value: Number(value) }) } }), 42);
  await assert.rejects(schemaModule.validateStandardSchema('x', { '~standard': { validate: () => ({ issues: [] }) } }), (error) => {
    assert.equal(schemaModule.isSchemaValidationError(error), true);
    assert.deepEqual(error.issues, []);
    return true;
  });
});

test('schema diagnostic guards recognize duplicate modules and preserve subclass semantics', async () => {
  const otherSchema = await import(new URL('../../dist/core/schema.js?duplicate-schema-test', import.meta.url).href);
  class LocalValidationError extends schemaModule.SchemaValidationError {}
  class ForeignValidationError extends otherSchema.SchemaValidationError {}
  const foreign = new ForeignValidationError([{ message: 'foreign issue', path: ['id'] }]);
  assert.equal(schemaModule.isSchemaValidationError(foreign), true);
  assert.equal(foreign instanceof LocalValidationError, false);
  assert.equal(schemaModule.isSchemaValidationError({ name: 'SchemaValidationError', issues: [], constructor: otherSchema.SchemaValidationError }), false);
});

test('schema failures retain response metadata and issues without retaining raw payload data', async () => {
  const issues = [{ message: 'Expected integer', path: [{ key: 'id' }] }];
  const schema = { '~standard': { validate: () => ({ issues }) } };
  const adapter = async () => new Response('{"secret":"private"}', { status: 201, headers: { 'x-context': 'kept' } });
  const verify = (error) => {
    assert.equal(isHttpError(error), true);
    assert.equal(error.code, 'ERR_SCHEMA_VALIDATION');
    assert.equal(error.status, 201);
    assert.equal(error.response.status, 201);
    assert.equal(error.response.headers.get('x-context'), 'kept');
    assert.equal(error.response.data, null);
    assert.equal(schemaModule.isSchemaValidationError(error.cause), true);
    assert.deepEqual(error.cause.issues, issues);
    return true;
  };
  await assert.rejects(createHttpClient({ adapter }).get('/schema', { schema }), verify);
  await assert.rejects(fetchJsonResult('/schema', { schema, fetch: adapter }), verify);
});

test('empty responses skip validators while explicit JSON null is validated', async () => {
  let calls = 0;
  const schema = { '~standard': { validate: (value) => { calls += 1; assert.equal(value, null); return { value: 'validated-null' }; } } };
  for (const response of [() => new Response(null, { status: 204 }), () => new Response('')]) {
    assert.equal(await createHttpClient({ adapter: async () => response() }).get('/empty', { schema }), null);
    assert.equal((await fetchJsonResult('/empty', { schema, fetch: async () => response() })).data, null);
  }
  assert.equal(calls, 0);
  assert.equal(await createHttpClient({ adapter: async () => new Response('null') }).get('/null', { schema }), 'validated-null');
  assert.equal((await fetchJsonResult('/null', { schema, fetch: async () => new Response('null') })).data, 'validated-null');
  assert.equal(calls, 2);
});
