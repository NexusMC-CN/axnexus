import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, createRequestLogger } from '../../dist/index.js';
import { attachRequestLogger } from '../../dist/observability/index.js';
import { createOpenTelemetryPlugin } from '../../dist/integrations/opentelemetry.js';
import { createRequestLoggerPlugin } from '../../dist/observability/index.js';
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';

test('automatic logs finish once and retain existing URL redaction', async () => {
  const records: any[] = [];
  const client = createHttpClient({ adapter: async () => new Response('{}') });
  const dispose = attachRequestLogger(client, createRequestLogger(record => records.push(record)));
  await client.get('https://example.test/data?token=secret-value&sort=asc');
  assert.deepEqual(records.map(record => record.phase), ['start', 'complete']);
  assert(!JSON.stringify(records).includes('secret-value'));
  assert(records[1].url.includes('sort=asc'));
  await dispose();
  await client.get('https://example.test/other');
  assert.equal(records.length, 2);
  await client.close();
});

test('OpenTelemetry creates parented attempts and closes streaming span at EOF', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  let tries = 0;
  const client = createHttpClient({
    plugins: [createOpenTelemetryPlugin({ tracer: provider.getTracer('test') })],
    retry: 1,
    adapter: async () => new Response('{}', { status: ++tries === 1 ? 503 : 200 }),
  });
  await client.get('https://example.test/items?token=private');
  const spans = exporter.getFinishedSpans();
  const request = spans.find(span => span.name === 'HTTP GET');
  const attempts = spans.filter(span => span.name.startsWith('HTTP attempt'));
  assert(request);
  assert.equal(attempts.length, 2);
  assert(attempts.every(span => span.parentSpanContext?.spanId === request.spanContext().spanId));
  assert(!JSON.stringify(spans.map(span => span.attributes)).includes('private'));
  exporter.reset();
  const raw = await client.get<Response>('https://example.test/stream', { responseType: 'response' });
  assert(!exporter.getFinishedSpans().some(span => span.name === 'HTTP GET'));
  await raw.text();
  assert(exporter.getFinishedSpans().some(span => span.name === 'HTTP GET'));
  await client.close();
  await provider.shutdown();
});

test('shared built-in plugin instances keep each client lifecycle independent', async () => {
  const records: any[] = [];
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const plugins = [createRequestLoggerPlugin(createRequestLogger(record => records.push(record))),
    createOpenTelemetryPlugin({ tracer: provider.getTracer('shared') })];
  const a = createHttpClient({ plugins });
  const b = createHttpClient({ plugins, adapter: async () => new Response('value') });
  const response = await b.get<Response>('https://example.test/shared', { responseType: 'response' });
  await a.close();
  assert.equal(records.filter(record => record.phase === 'error').length, 0);
  assert.equal(exporter.getFinishedSpans().filter(span => span.name === 'HTTP GET').length, 0);
  await response.text();
  assert.equal(records.filter(record => record.phase === 'complete').length, 1);
  await b.close(); await provider.shutdown();
});

test('failed HTTP statuses remain available to automatic logs and spans', async () => {
  const records: any[] = [];
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const client = createHttpClient({ adapter: async () => new Response('{}', { status: 503 }),
    plugins: [createRequestLoggerPlugin(createRequestLogger(record => records.push(record))),
      createOpenTelemetryPlugin({ tracer: provider.getTracer('failed') })],
  });
  await assert.rejects(client.get('https://example.test/failure'));
  assert.equal(records.at(-1).status, 503);
  assert(exporter.getFinishedSpans().every(span => span.attributes['http.response.status_code'] === 503));
  await client.close(); await provider.shutdown();
});

test('OpenTelemetry records queue, retry and raw body durations without request secrets', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  let attempts = 0;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const client = createHttpClient({ retry: { limit: 1, delay: 20, jitter: false },
    plugins: [createOpenTelemetryPlugin({ tracer: provider.getTracer('timings') })],
    adapter: async () => ++attempts === 1 ? new Response('{}', { status: 503 })
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })),
  });
  const response = await client.get<Response>('https://example.test/body?token=private-secret', {
    responseType: 'response', context: { private: 'private-secret' }, headers: { Authorization: 'private-secret' },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  body.close();
  await response.text();
  const spans = exporter.getFinishedSpans();
  const request = spans.find(span => span.name === 'HTTP GET')!;
  assert(request);
  for (const name of ['queue:end', 'retry:end', 'body:end']) {
    const event = request.events.find(event => event.name === name);
    assert(event, `missing ${name}`);
    const duration = event.attributes?.['axnexus.duration_ms'];
    assert.equal(typeof duration, 'number');
    assert((duration as number) >= (name === 'queue:end' ? 0 : 10));
  }
  assert(request.events.some(event => event.name === 'body:start'));
  assert(spans.filter(span => span.name.startsWith('HTTP attempt'))
    .every(span => span.parentSpanContext?.spanId === request.spanContext().spanId));
  assert(!JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events }))).includes('private-secret'));
  await client.close(); await provider.shutdown();
});
