import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, realpath, rm } from 'node:fs/promises';
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
  // pnpm pack returns one object and accepts ignore-scripts as a config option.
  const packed = JSON.parse(pnpm(['--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', temporary], root));
  assert.equal(packed.name, packageName);
  const tarball = resolve(temporary, packed.filename);
  assert.equal(dirname(tarball), resolve(temporary));
  await access(tarball);
  assert(packed.files.some(file => file.path === 'dist/stream/index.js'));
  assert(!packed.files.some(file => /^(?:docs|tests|scripts)\//.test(file.path)));
  const manifest = { name: 'axnexus-consumer', private: true, type: 'module',
    dependencies: { [packageName]: `file:./${basename(tarball)}` } };
  const install = async () => {
    await writeFile(join(temporary, 'package.json'), JSON.stringify(manifest));
    pnpm(['install', '--ignore-scripts', '--no-frozen-lockfile', '--config.auto-install-peers=false',
      '--config.confirmModulesPurge=false']);
  };
  await install();
  const requireFromPackage = createRequire(await realpath(join(temporary, 'node_modules', packageName, 'package.json')));
  for (const dependency of ['@opentelemetry/api', '@tanstack/query-core', '@orpc/client']) {
    await assert.rejects(access(join(temporary, 'node_modules', dependency)));
    assert.throws(() => requireFromPackage.resolve(dependency), { code: 'MODULE_NOT_FOUND' });
  }
  const core = `import { createHttpClient, HttpError, SchemaValidationError } from '${packageName}';
import { parseSSE } from '${packageName}/stream';
import { createFetchHandler } from '${packageName}/fetch';
import { defineEndpoint } from '${packageName}/contracts';
import { createRequestLogger } from '${packageName}/observability';
if ([createHttpClient,HttpError,SchemaValidationError,parseSSE,createFetchHandler,defineEndpoint,createRequestLogger].some(value => typeof value !== 'function')) throw new Error('Missing export');
const client = createHttpClient({adapter: async () => new Response('{"ok":true}')});
const value = await client.get('https://consumer.test/');
if (!value.ok) throw new Error('Consumer request failed');
await client.close();`;
  await writeFile(join(temporary, 'consumer.mjs'), core);
  run(join(temporary, 'consumer.mjs'), []);

  const fixtures = ['tests/types/schema.ts', 'tests/types/contracts.ts', 'tests/stream/types.ts'];
  const rewrite = source => source
    .replaceAll('../../src/core/client.js', packageName)
    .replaceAll('../../src/core/types.js', packageName)
    .replaceAll('../../src/core/schema.js', packageName)
    .replaceAll('../../src/server/json.js', packageName)
    .replaceAll('../../src/index.js', packageName)
    .replaceAll('../../src/contracts/index.js', `${packageName}/contracts`)
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
  await install();
  await writeFile(join(temporary, 'types', 'integrations.ts'), rewrite(await readFile(join(root, 'tests/types/integrations.ts'), 'utf8')));
  await check();
  await writeFile(join(temporary, 'optional.mjs'), `import {createOpenTelemetryPlugin} from '${packageName}/opentelemetry';
import {createQueryOptions} from '${packageName}/tanstack-query';
if(typeof createOpenTelemetryPlugin !== 'function' || typeof createQueryOptions !== 'function') throw new Error('Optional export failed');`);
  run(join(temporary, 'optional.mjs'), []);
  console.log('Tarball consumer passed: core without peers, optional entries, NodeNext and Bundler types.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
