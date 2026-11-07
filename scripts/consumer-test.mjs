import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, access, realpath, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli || !/^pnpm\.(?:cjs|mjs|js)$/i.test(basename(pnpmCli))) {
  throw new Error('Run this consumer test with pnpm test:consumer so pnpm provides its CLI through npm_execpath.');
}
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const temporary = await mkdtemp(join(tmpdir(), 'axnexus-consumer-'));
const run = (script, args, cwd = temporary) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed (${result.signal ?? result.status})\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const pnpm = (args, cwd) => run(pnpmCli, args, cwd);
const packageName = '@nexusmc-cn/axnexus';

try {
  let tarball;
  if (process.argv[2]) {
    // Release CI must test the exact artifact that npm will publish.
    const supplied = resolve(process.argv[2]);
    tarball = join(temporary, basename(supplied));
    await copyFile(supplied, tarball);
  } else {
    // The ordinary CI path uses the already-built dist directory.
    const packed = JSON.parse(pnpm(['--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', temporary], root));
    assert.equal(packed.name, packageName);
    tarball = resolve(temporary, packed.filename);
    assert.equal(dirname(tarball), resolve(temporary));
  }
  await access(tarball);
  const manifest = { name: 'axnexus-consumer', private: true, type: 'module',
    dependencies: { [packageName]: `file:./${basename(tarball)}` } };
  const install = async () => {
    await writeFile(join(temporary, 'package.json'), JSON.stringify(manifest));
    pnpm(['install', '--ignore-scripts', '--no-frozen-lockfile', '--config.auto-install-peers=false',
      '--config.confirmModulesPurge=false']);
  };
  await install();
  const packageRoot = await realpath(join(temporary, 'node_modules', packageName));
  const published = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(published.name, packageName);
  const files = new Set((await readdir(packageRoot, { recursive: true })).map(path => path.replaceAll('\\', '/')));
  assert(files.has('dist/stream/index.js'));
  assert(files.has('src/index.ts'), 'Missing source for published source maps');
  assert(![...files].some(path => /^(?:docs|tests|scripts)(?:\/|$)/.test(path)), 'Unexpected development files in tarball');
  for (const entry of Object.values(published.exports)) {
    if (typeof entry === 'string') {
      assert(files.has(entry.replace(/^\.\//, '')), `Missing export: ${entry}`);
      continue;
    }
    for (const target of [entry.types, entry.import, entry.default]) {
      assert.equal(typeof target, 'string', 'Missing export condition');
      assert(files.has(target.replace(/^\.\//, '')), `Missing export: ${target}`);
    }
  }
  for (const path of files) {
    if (!path.startsWith('dist/') || !path.endsWith('.js')) continue;
    for (const companion of [path + '.map', path.slice(0, -3) + '.d.ts', path.slice(0, -3) + '.d.ts.map']) {
      assert(files.has(companion), `Missing published build output: ${companion}`);
    }
  }
  for (const path of files) {
    if (!path.startsWith('dist/') || !path.endsWith('.map')) continue;
    const mapPath = join(packageRoot, path);
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    for (const source of map.sources) {
      const resolved = resolve(dirname(mapPath), map.sourceRoot ?? '', source);
      assert(resolved.startsWith(join(packageRoot, 'src') + (process.platform === 'win32' ? '\\' : '/')),
        `Source map points outside published sources: ${path}`);
      await access(resolved);
    }
  }
  const requireFromPackage = createRequire(join(packageRoot, 'package.json'));
  for (const dependency of ['@opentelemetry/api', '@tanstack/query-core', '@orpc/client', 'fastify']) {
    await assert.rejects(access(join(temporary, 'node_modules', dependency)));
    assert.throws(() => requireFromPackage.resolve(dependency), { code: 'MODULE_NOT_FOUND' });
  }
  const core = `import { createRequire } from 'node:module';
import { createHttpClient, HttpError, SchemaValidationError } from '${packageName}';
import { parseSSE } from '${packageName}/stream';
import { createFetchHandler } from '${packageName}/fetch';
import { defineEndpoint } from '${packageName}/contracts';
import { defineSelectionResource, leaf, createSelectionClient, defineSelectionPlan, describeSelectionResource, inspectSelection } from '${packageName}/selection';
import { implementSelection, createSelectionHandler, paginateSelection, createSelectionBatchLoader, withSelectionLoaders } from '${packageName}/selection/server';
import { createRequestLogger } from '${packageName}/observability';
const require = createRequire(import.meta.url);
const metadata = require('${packageName}/package.json');
if (metadata.name !== '${packageName}') throw new Error('Package metadata export failed');
for (const entry of Object.keys(metadata.exports)) {
  require.resolve(entry === '.' ? '${packageName}' : '${packageName}' + entry.slice(1));
}
if ([createHttpClient,HttpError,SchemaValidationError,parseSSE,createFetchHandler,defineEndpoint,defineSelectionResource,leaf,createSelectionClient,defineSelectionPlan,describeSelectionResource,inspectSelection,implementSelection,createSelectionHandler,paginateSelection,createSelectionBatchLoader,withSelectionLoaders,createRequestLogger].some(value => typeof value !== 'function')) throw new Error('Missing export');
const client = createHttpClient({adapter: async () => new Response('{"ok":true}')});
const value = await client.get('https://consumer.test/');
if (!value.ok) throw new Error('Consumer request failed');
await client.close();`;
  await writeFile(join(temporary, 'consumer.mjs'), core);
  run(join(temporary, 'consumer.mjs'), []);

  const fixtures = ['tests/types/schema.ts', 'tests/types/contracts.ts', 'tests/types/selection.ts',
    'tests/types/selection-plans.ts', 'tests/types/selection-loaders.ts', 'tests/stream/types.ts'];
  const rewrite = source => source
    .replaceAll('../../src/core/client.js', packageName)
    .replaceAll('../../src/core/types.js', packageName)
    .replaceAll('../../src/core/schema.js', packageName)
    .replaceAll('../../src/server/json.js', packageName)
    .replaceAll('../../src/index.js', packageName)
    .replaceAll('../../src/contracts/index.js', `${packageName}/contracts`)
    .replaceAll('../../src/selection/index.js', `${packageName}/selection`)
    .replaceAll('../../src/selection/contract.js', `${packageName}/selection`)
    .replaceAll('../../src/selection/plans.js', `${packageName}/selection`)
    .replaceAll('../../src/selection/server/batch-loader.js', `${packageName}/selection/server`)
    .replaceAll('../../src/selection/server/index.js', `${packageName}/selection/server`)
    .replaceAll('../../src/integrations/fastify.js', `${packageName}/fastify`)
    .replaceAll('../../src/bridges/index.js', `${packageName}/fetch`)
    .replaceAll('../../src/stream/index.js', `${packageName}/stream`)
    .replaceAll('../../src/plugins/index.js', `${packageName}/plugins`)
    .replaceAll('../../src/integrations/tanstack-query.js', `${packageName}/tanstack-query`);
  await mkdir(join(temporary, 'types'));
  for (const [index, path] of fixtures.entries()) {
    await writeFile(join(temporary, 'types', `${index}.ts`), rewrite(await readFile(join(root, path), 'utf8')));
  }
  const config = { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true, skipLibCheck: false, noEmit: true }, include: ['types/*.ts'] };
  const check = async () => {
    await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify(config));
    run(tsc, ['-p', 'tsconfig.json']);
    run(tsc, ['-p', 'tsconfig.json', '--module', 'ESNext', '--moduleResolution', 'Bundler']);
  };
  await check();
  manifest.dependencies['@opentelemetry/api'] = '1.9.0';
  manifest.dependencies['@tanstack/query-core'] = '5.104.5';
  manifest.dependencies.fastify = '5.12.8';
  manifest.devDependencies = { '@types/node': '22.20.5' };
  await install();
  await writeFile(join(temporary, 'types', 'integrations.ts'), rewrite(await readFile(join(root, 'tests/types/integrations.ts'), 'utf8')));
  await writeFile(join(temporary, 'types', 'fastify.ts'), rewrite(await readFile(join(root, 'tests/types/fastify.ts'), 'utf8')));
  await check();
  await writeFile(join(temporary, 'optional.mjs'), `import {createOpenTelemetryPlugin} from '${packageName}/opentelemetry';
import {createQueryOptions} from '${packageName}/tanstack-query';
import {createFastifySelectionPlugin,toWebRequest,sendWebResponse} from '${packageName}/fastify';
import Fastify from 'fastify';
if([createOpenTelemetryPlugin,createQueryOptions,createFastifySelectionPlugin,toWebRequest,sendWebResponse].some(value => typeof value !== 'function')) throw new Error('Optional export failed');
const app = Fastify();
app.get('/bridge', async (request, reply) => sendWebResponse(reply, new Response(JSON.stringify({url: toWebRequest(request, {reply}).url}), {headers: {'content-type': 'application/json'}})));
const response = await app.inject({method: 'GET', url: '/bridge'});
if(response.statusCode !== 200 || response.json().url !== 'http://axnexus.invalid/bridge') throw new Error('Minimum Fastify peer bridge failed');
await app.close();`);
  run(join(temporary, 'optional.mjs'), []);
  console.log('Tarball consumer passed: public exports and metadata, source maps, core without peers, optional entries, minimum Fastify peer, NodeNext and Bundler types.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
