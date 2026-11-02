import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

for (const file of ['index.js.map', 'index.d.ts.map']) {
  test(`${file} points to source included in the published package`, () => {
    assert.ok(manifest.files.includes('src'), 'Package must publish its mapped source files');
    const mapPath = resolve(root, 'dist', file);
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    assert.equal(map.sources.length, 1);
    const sourcePath = resolve(dirname(mapPath), map.sources[0]);
    assert.ok(sourcePath.startsWith(resolve(root, 'src') + sep));
    assert.ok(existsSync(sourcePath));
  });
}
