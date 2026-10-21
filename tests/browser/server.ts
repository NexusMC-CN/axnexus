import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface RequestRecord {
  method: string;
  path: string;
  cookie: string;
  requestId: string;
  preflightHeaders: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function createChannel() {
  return { started: deferred(), closed: deferred() };
}

type Channel = ReturnType<typeof createChannel>;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function json(response: ServerResponse, data: unknown, noStore: boolean): void {
  response.setHeader('Content-Type', 'application/json');
  // Avoid native browser cache hits while permitting the explicit client TTL.
  response.setHeader('Cache-Control', noStore ? 'no-store' : 'private, max-age=0, must-revalidate');
  response.end(JSON.stringify(data));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function startBrowserServers() {
  const requests: RequestRecord[] = [];
  const channels = new Map<string, Channel>();
  const counts = new Map<string, number>();
  const app = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname.startsWith('/dist/') && /^\/dist\/[a-zA-Z0-9_./-]+\.js$/.test(pathname)
          && !pathname.split('/').includes('..')) {
        const path = fileURLToPath(new URL(`../..${pathname}`, import.meta.url));
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(path));
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><title>axnexus browser contracts</title></head><body></body></html>');
    })().catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const appOrigin = await listen(app);
  const api = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const record: RequestRecord = {
        method: request.method ?? 'GET',
        path,
        cookie: request.headers.cookie ?? '',
        requestId: String(request.headers['x-request-id'] ?? ''),
        preflightHeaders: String(request.headers['access-control-request-headers'] ?? ''),
      };
      requests.push(record);
      response.setHeader('Access-Control-Allow-Origin', appOrigin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        response.setHeader('Access-Control-Allow-Headers', 'content-type, x-request-id');
        response.setHeader('Access-Control-Max-Age', '0');
        response.writeHead(204).end();
        return;
      }
      const channel = channels.get(path);
      if (channel) {
        response.setHeader('Content-Type', 'text/plain');
        response.setHeader('Cache-Control', 'no-store');
        response.on('close', () => channel.closed.resolve());
        response.write('ready\n');
        channel.started.resolve();
        // The body remains open until the browser cancels or aborts it.
        return;
      }
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      const body = await readBody(request);
      json(response, { ...record, count, data: body ? JSON.parse(body) : null }, path.startsWith('/no-store-'));
    })().catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  let apiOrigin: string;
  try { apiOrigin = await listen(api); }
  catch (error) { await close(app); throw error; }
  return {
    appOrigin,
    apiOrigin,
    requests,
    openChannel(path: string): Channel {
      const channel = createChannel();
      channels.set(path, channel);
      return channel;
    },
    async close(): Promise<void> {
      await Promise.all([close(app), close(api)]);
    },
  };
}
