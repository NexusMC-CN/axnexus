// In-process test runner.
//
// The default CLI runner executes each test file in a spawned child process
// with piped stdio. Some sandboxes deny that spawn with EPERM, which makes the
// whole suite look broken. Importing the files directly registers their tests
// with node:test in this process, and node:test's own reporters do the rest.

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const filter = process.argv[2] ?? '';

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

const files = (await collect(path.join(root, 'tests')))
  .filter((file) => file.replaceAll('\\', '/').includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`no test files matched ${filter || '(all)'}`);
  process.exit(1);
}

console.log(`importing ${files.length} test file(s) into this process...\n`);

for (const file of files) {
  await import(pathToFileURL(file).href);
}
