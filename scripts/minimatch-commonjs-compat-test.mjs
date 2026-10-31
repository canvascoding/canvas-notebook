import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const matcher = require('minimatch');
assert.equal(typeof matcher, 'function', 'Legacy CommonJS consumers require a callable minimatch export.');
assert.equal(matcher, matcher.minimatch);
assert.equal(matcher, matcher.default);
assert.equal(matcher('Notes/😀.md', 'Notes/*.md'), true);
assert.equal(matcher('Notes/A.txt', 'Notes/*.md'), false);
assert.equal(new matcher.Minimatch('Notes/*.md').match('Notes/Ä.md'), true);
assert.deepEqual(matcher.match(['A.md', 'B.txt'], '*.md'), ['A.md']);
const esm = await import(pathToFileURL(path.join(root, 'node_modules/minimatch/dist/esm/index.js')).href);
assert.equal(esm.minimatch('Notes/😀.md', 'Notes/*.md'), true);
assert.equal(esm.minimatch('.hidden.md', '*.md'), false);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-minimatch-compat-'));
try {
  const left = path.join(temporary, 'left');
  const right = path.join(temporary, 'right');
  fs.mkdirSync(left); fs.mkdirSync(right);
  for (const directory of [left, right]) {
    fs.mkdirSync(path.join(directory, 'Nested/Deep'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'Ä.md'), '# Identical\n');
    fs.writeFileSync(path.join(directory, '.hidden.md'), '# Hidden\n');
    fs.writeFileSync(path.join(directory, 'Nested/child.md'), '# Child\n');
    fs.writeFileSync(path.join(directory, 'Nested/Deep/Ω.md'), '# Deep\n');
  }
  fs.writeFileSync(path.join(left, 'ignored.txt'), 'Left');
  fs.writeFileSync(path.join(right, 'ignored.txt'), 'Right');
  const modernGlob = require('glob');
  assert.deepEqual(modernGlob.globSync('*.md', { cwd: left }), ['Ä.md']);
  assert.deepEqual((await modernGlob.glob('*.md', { cwd: left })).sort(), ['Ä.md']);
  const matrix = [
    ['*.md', {}, ['Ä.md']],
    ['*.md', { dot: true }, ['.hidden.md', 'Ä.md']],
    ['**/*.md', {}, ['Nested/Deep/Ω.md', 'Nested/child.md', 'Ä.md']],
    ['*.{md,txt}', {}, ['ignored.txt', 'Ä.md']],
    ['Missing/*.{md,txt}', { nonull: true }, ['Missing/*.md', 'Missing/*.txt']],
    ['**/*.md', { ignore: ['Nested/**'] }, ['Ä.md']],
    ['Nested/**/?.md', {}, ['Nested/Deep/Ω.md']],
  ];
  let legacyCases = 0;
  for (const packagePath of ['@electron/asar', 'rimraf']) {
    const legacyGlob = require(path.join(root, 'node_modules', packagePath, 'node_modules/glob'));
    for (const [pattern, options, expected] of matrix) {
      const actualOptions = { cwd: left, nodir: true, ...options };
      assert.deepEqual(legacyGlob.sync(pattern, actualOptions).sort(), expected, packagePath + ' sync ' + pattern);
      assert.deepEqual((await promisify(legacyGlob)(pattern, actualOptions)).sort(), expected, packagePath + ' async ' + pattern);
      legacyCases += 2;
    }
  }
  assert.equal(require('dir-compare').compareSync(left, right, { compareContent: true, includeFilter: '*.md' }).same, true);
  const archive = path.join(temporary, 'consumer.asar');
  const extracted = path.join(temporary, 'extracted');
  const asar = require('@electron/asar');
  await asar.createPackage(left, archive);
  asar.extractAll(archive, extracted);
  assert.equal(fs.readFileSync(path.join(extracted, 'Nested/Deep/Ω.md'), 'utf8'), '# Deep\n');
  assert.equal(fs.readFileSync(path.join(extracted, '.hidden.md'), 'utf8'), '# Hidden\n');
  const cleanup = path.join(temporary, 'cleanup');
  fs.mkdirSync(cleanup);
  fs.writeFileSync(path.join(cleanup, 'retire.tmp'), 'Owned temporary');
  fs.writeFileSync(path.join(cleanup, 'keep.md'), 'Keep');
  await promisify(require('rimraf'))(path.join(cleanup, '*.tmp'));
  assert.deepEqual(fs.readdirSync(cleanup), ['keep.md']);
  fs.writeFileSync(path.join(right, 'Ä.md'), '# Different\n');
  assert.equal(require('dir-compare').compareSync(left, right, { compareContent: true, includeFilter: '*.md' }).same, false);
  console.log(JSON.stringify({ suite: 'minimatch-commonjs-compat', callableAndNamedCommonJs: true,
    nativeEsm: true, actualGlob7And14: true, legacyCases, actualDirCompareFilteredContent: true,
    actualAsarArchiveRoundTrip: true, actualRimrafScopedCleanup: true }));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
