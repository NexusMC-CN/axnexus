import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCli = process.env.npm_execpath;
const version = process.env.NUXT_VERSION ?? process.argv[2] ?? '4.5.2';
const nodeBinary = process.env.AXNEXUS_NUXT_NODE ?? process.execPath;
if (!pnpmCli || !/pnpm\.(?:cjs|mjs|js)$/i.test(basename(pnpmCli))) {
  throw new Error('Run this script with pnpm run test:nuxt.');
}
if (!['4.5.2', '4.6.3'].includes(version)) throw new Error('Unsupported Nuxt smoke version: ' + version);

function run(script, args, cwd, timeout = 8 * 60_000) {
  const result = spawnSync(script, args, {
    cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(args.join(' ') + ' failed (' + (result.signal ?? result.status) + ')\n'
      + result.stdout + '\n' + result.stderr);
  }
  return result.stdout;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitReady(url, child, output) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Nitro server exited before readiness:\n' + output());
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error('Nitro server did not start:\n' + output());
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  for (let attempt = 0; attempt < 20; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await delay(250);
  }
  child.kill('SIGKILL');
}

const temporary = await mkdtemp(join(tmpdir(), 'axnexus-nuxt-'));
let child;
try {
  const packed = JSON.parse(run(process.execPath, [pnpmCli, '--config.ignore-scripts=true',
    'pack', '--json', '--pack-destination', temporary], root));
  const tarball = resolve(temporary, packed.filename);
  const app = join(temporary, 'app');
  await mkdir(app);
  await cp(join(root, 'tests/nuxt/common'), app, { recursive: true });
  await cp(join(root, 'tests/nuxt', version === '4.5.2' ? 'legacy' : 'modern'), app, { recursive: true });
  await copyFile(tarball, join(app, basename(tarball)));
  await writeFile(join(app, 'package.json'), JSON.stringify({
    name: 'axnexus-nuxt-smoke', private: true, type: 'module',
    dependencies: {
      '@nexusmc-cn/axnexus': 'file:./' + basename(tarball),
      nuxt: version,
      ...(version === '4.5.2' ? { h3: '1.15.11' } : {}),
    },
  }, null, 2));
  await writeFile(join(app, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n');
  process.stdout.write('Installing Nuxt ' + version + ' consumer fixture...\n');
  run(nodeBinary, [pnpmCli, 'install', '--no-frozen-lockfile',
    '--config.confirmModulesPurge=false'], app);
  process.stdout.write('Building Nuxt ' + version + ' Nitro fixture...\n');
  run(nodeBinary, [join(app, 'node_modules/nuxt/bin/nuxt.mjs'), 'build'], app);

  const port = await freePort();
  let serverOutput = '';
  child = spawn(nodeBinary, [join(app, '.output/server/index.mjs')], {
    cwd: app, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-16_000); });
  }
  const base = 'http://127.0.0.1:' + port;
  await waitReady(base + '/', child, () => serverOutput);

  const body = JSON.stringify({
    protocol: 'axnexus.selection', version: 1, resource: 'session.current.v1',
    args: {}, select: { actor: true },
  });
  const post = (cookie, payload = body) => fetch(base + '/api/__axnexus/select', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: payload, signal: AbortSignal.timeout(10_000),
  });
  for (const actor of ['alice', 'bob']) {
    const response = await post('session=' + actor);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse(text), { data: { actor } });
  }
  const denied = await post('');
  const deniedText = await denied.text();
  assert.equal(denied.status, 403, deniedText);
  assert.equal(JSON.parse(deniedText).error.code, 'FORBIDDEN');
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  const malformed = await post('session=alice', '{bad');
  const malformedText = await malformed.text();
  assert.equal(malformed.status, 400, malformedText);
  assert.equal(JSON.parse(malformedText).error.code, 'INVALID_REQUEST');
  assert.equal(malformed.headers.get('cache-control'), 'no-store');
  const otherPath = await fetch(base + '/__axnexus/select', { signal: AbortSignal.timeout(10_000) });
  assert.equal(otherPath.status, 404);
  await otherPath.body?.cancel();

  for (const actor of ['alice', 'bob']) {
    const response = await fetch(base + '/', {
      headers: { cookie: 'session=' + actor }, signal: AbortSignal.timeout(10_000),
    });
    const html = await response.text();
    assert.equal(response.status, 200, html.slice(-3000));
    assert.match(html, new RegExp('<main[^>]*id="actor"[^>]*>' + actor + '</main>'));
    assert.doesNotMatch(html, new RegExp('<main[^>]*id="actor"[^>]*>' + (actor === 'alice' ? 'bob' : 'alice') + '</main>'));
  }
  process.stdout.write('Nuxt ' + version + ' Nitro route and SSR consumer passed.\n');
} finally {
  await stop(child);
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
