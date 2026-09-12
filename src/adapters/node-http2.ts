import { HttpError } from '../core/errors.js';
import type { AdapterConfig, AdapterResult, HttpAdapterFactory } from './types.js';

interface Http2Stream {
  on(event: string, listener: (...args: any[]) => void): this;
  end(body?: unknown): void;
  close?(code?: number): void;
  write?(chunk: unknown): boolean;
}

interface Http2Session {
  request(headers: Record<string, string>): Http2Stream;
  on?(event: string, listener: (...args: any[]) => void): this;
  close?(): void;
}

interface Http2Module {
  connect(origin: string): Http2Session;
  constants?: { NGHTTP2_CANCEL?: number };
}

export interface NodeHttp2AdapterOptions {
  module?: Http2Module;
}

function loadHttp2(): Promise<Http2Module> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Http2Module>;
  return dynamicImport('node:http2');
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  return new TextEncoder().encode(String(chunk));
}

async function endRequest(stream: Http2Stream, body: unknown): Promise<void> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        stream.write?.(result.value);
      }
      stream.end();
    } finally {
      reader.releaseLock();
    }
    return;
  }
  if (body instanceof ArrayBuffer) {
    stream.end(new Uint8Array(body));
    return;
  }
  stream.end(body);
}

export function createNodeHttp2Adapter(options: NodeHttp2AdapterOptions = {}): HttpAdapterFactory {
  const sessions = new Map<string, Http2Session>();
  let modulePromise: Promise<Http2Module> | undefined;
  const getModule = () => modulePromise ??= Promise.resolve(options.module ?? loadHttp2());

  return async (config: AdapterConfig): Promise<AdapterResult> => {
    const http2 = await getModule();
    const target = new URL(config.url);
    const origin = target.origin;
    let session = sessions.get(origin);
    if (!session) {
      session = http2.connect(origin);
      sessions.set(origin, session);
      const discard = () => {
        if (sessions.get(origin) === session) sessions.delete(origin);
      };
      session.on?.('close', discard);
      session.on?.('error', discard);
    }
    const requestHeaders: Record<string, string> = {
      ':method': config.method,
      ':path': `${target.pathname || '/'}${target.search}`,
      ':authority': target.host,
    };
    config.headers.forEach((value, name) => {
      if (!name.startsWith(':')) requestHeaders[name.toLowerCase()] = value;
    });
    const stream = session.request(requestHeaders);
    const cancelCode = http2.constants?.NGHTTP2_CANCEL ?? 8;
    let settled = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyClosed = false;
    let onAbort: (() => void) | undefined;
    const cleanupAbort = () => {
      if (onAbort) config.signal?.removeEventListener('abort', onAbort);
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        stream.on('data', (chunk: unknown) => controller.enqueue(toBytes(chunk)));
        stream.on('end', () => {
          if (!bodyClosed) controller.close();
          bodyClosed = true;
          cleanupAbort();
        });
        stream.on('error', (error: unknown) => {
          if (!bodyClosed) controller.error(error);
          bodyClosed = true;
          cleanupAbort();
        });
        stream.on('aborted', () => {
          if (!bodyClosed) controller.error(new Error('HTTP/2 stream aborted'));
          bodyClosed = true;
          cleanupAbort();
        });
      },
      cancel() {
        stream.close?.(cancelCode);
      },
    });
    const requestBody = endRequest(stream, config.body);
    const responsePromise = new Promise<Response>((resolve, reject) => {
      const onResponse = (headers: Record<string, string | number>) => {
        if (settled) return;
        settled = true;
        const status = Number(headers[':status']) || 200;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(headers)) {
          if (!name.startsWith(':')) responseHeaders.append(name, String(value));
        }
        resolve(new Response(body, { status, headers: responseHeaders }));
      };
      stream.on('response', onResponse);
      stream.on('error', (error: unknown) => {
        if (!settled) reject(new HttpError('HTTP/2 stream failed', { code: 'ERR_NETWORK', retryable: true, cause: error }));
        else bodyController?.error(error);
      });
      onAbort = () => {
        stream.close?.(cancelCode);
        if (!settled) reject(new HttpError('Request canceled', { code: 'ERR_CANCELED', isAbort: true }));
      };
      config.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const [response] = await Promise.all([responsePromise, requestBody]);
    return { response, metadata: { protocol: 'h2', timings: { startedAt: Date.now() } } };
  };
}

export const nodeHttp2Adapter = createNodeHttp2Adapter();
