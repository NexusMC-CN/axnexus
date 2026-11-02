import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createSelectionHandler } from '../selection/server/index.js';
import type { SelectionImplementation } from '../selection/server/index.js';
import type { SelectionLimits } from '../selection/validation.js';
import type { SelectionPlan } from '../selection/plans.js';
import type { SelectionObserver } from '../selection/inspector.js';

type MaybePromise<T> = T | Promise<T>;

export interface FastifyWebRequestOptions {
  /** A trusted origin; defaults to an internal placeholder rather than the request Host header. */
  readonly origin?: string;
  /** Override only the path used by the Web handler, for routes mounted under a Fastify prefix. */
  readonly path?: string;
  /** Supply raw bytes explicitly when another Fastify parser has already consumed the body. */
  readonly body?: BodyInit | Uint8Array | ArrayBuffer | null;
}

function rawBody(value: unknown): value is BodyInit | Uint8Array | ArrayBuffer {
  return typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer
    || value instanceof URLSearchParams || value instanceof Blob || value instanceof FormData
    || value instanceof ReadableStream;
}

/** Adapt one Fastify request without silently reserializing parsed JSON or multipart data. */
export function toWebRequest(request: FastifyRequest, options: FastifyWebRequestOptions = {}): Request {
  const origin = new URL(options.origin ?? 'http://axnexus.invalid');
  if (!['http:', 'https:'].includes(origin.protocol)) throw new TypeError('Web request origin must use HTTP(S)');
  const path = options.path ?? request.raw.url ?? '/';
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('Web request path must be relative to its origin');
  const url = new URL(path, origin.origin);
  if (url.origin !== origin.origin) throw new TypeError('Web request path must stay on its origin');
  const headers = new Headers();
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) headers.append(rawHeaders[index]!, rawHeaders[index + 1]!);
  const supplied = Object.hasOwn(options, 'body');
  const body = supplied ? options.body : request.body;
  if (body !== undefined && body !== null && !rawBody(body)) {
    throw new TypeError('Fastify request body must be raw bytes or explicitly supplied');
  }
  if (supplied) {
    headers.delete('content-length');
    if (body instanceof FormData || body instanceof URLSearchParams || body instanceof Blob) {
      headers.delete('content-type');
    }
  }
  const method = request.method.toUpperCase();
  if ((method === 'GET' || method === 'HEAD') && body != null) throw new TypeError('GET and HEAD requests cannot have a body');
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: request.signal };
  if (body != null) {
    init.body = body as BodyInit;
    if (body instanceof ReadableStream) init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Preserve status and headers for Fastify hooks, then stream the Web response body. */
export function sendWebResponse(reply: FastifyReply, response: Response): FastifyReply {
  reply.code(response.status);
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  if (!response.body) return reply.send();
  return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
}

export interface FastifySelectionOptions<Context, Loaders = unknown> {
  readonly resources: readonly SelectionImplementation<any, any, Context, Loaders>[];
  readonly limits: SelectionLimits;
  readonly endpoint?: string;
  readonly plans?: readonly SelectionPlan[];
  readonly allowDynamic?: boolean;
  readonly createLoaders?: (input: { context: Context; signal: AbortSignal }) => MaybePromise<Loaders>;
  readonly observe?: SelectionObserver;
  readonly getContext: (request: FastifyRequest, reply: FastifyReply) => MaybePromise<Context>;
}

/** Register one isolated Selection POST route without changing sibling Fastify routes. */
export function createFastifySelectionPlugin<Context, Loaders = unknown>(
  options: FastifySelectionOptions<Context, Loaders>,
): FastifyPluginAsync {
  if (!options || typeof options.getContext !== 'function') throw new TypeError('Fastify Selection context factory required');
  const endpoint = options.endpoint ?? '/__axnexus/select';
  const handler = createSelectionHandler({
    resources: options.resources, limits: options.limits, endpoint, plans: options.plans,
    allowDynamic: options.allowDynamic, createLoaders: options.createLoaders, observe: options.observe,
  });
  return async (fastify) => {
    fastify.removeContentTypeParser('application/json');
    fastify.addContentTypeParser('application/json',
      { parseAs: 'buffer', bodyLimit: options.limits.maxRequestBytes },
      (_request, body, done) => done(null, body));
    fastify.post(endpoint, {
      bodyLimit: options.limits.maxRequestBytes,
      onRequest: async (request, reply) => {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
          reply.code(400).header('cache-control', 'no-store').send({
            error: { code: 'INVALID_REQUEST', message: 'JSON content type required' },
          });
        }
      },
      errorHandler: (error, _request, reply) => {
        if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
          reply.code(413).header('cache-control', 'no-store').send({
            error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeded limit' },
          });
          return;
        }
        reply.send(error);
      },
    }, async (request, reply) => {
      const context = await options.getContext(request, reply);
      const webRequest = toWebRequest(request, { path: endpoint });
      return sendWebResponse(reply, await handler(webRequest, context));
    });
  };
}
