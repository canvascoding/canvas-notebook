import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFingerprint, buildProofName, sourceFingerprint } from './lib/owned-yjs-authority-qa';

const frozenBuildProofName = 'yjs-authority-build-proof.json';

// Independent serial reference frozen from commit 70dedc26d42621bfb6d473d28bd9a48d7a315b8b.
// Keep the original selection, guards, traversal order and full-byte digest framing here.
async function serialSourceFingerprint(repo: string): Promise<{ head: string; fingerprint: string }> {
  assert.equal(await fs.realpath(repo), repo);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(head, /^[a-f0-9]{40}$/u);
  const names = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd: repo }).toString().split('\0')
    .filter(name => /^(?:app|components|server|scripts|tests|packages|i18n|messages|public)\//u.test(name)
      || /^(?:package(?:-lock)?\.json|tsconfig\.json|next\.config\.[cm]?[jt]s|server\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s)$/u.test(name));
  const digest = createHash('sha256').update(head);
  for (const name of [...new Set(names)].sort()) {
    const filename = path.join(repo, name), stat = await fs.lstat(filename);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Build source must be a regular file (${name}).`);
    digest.update(name).update('\0').update(await fs.readFile(filename)).update('\0');
  }
  return { head, fingerprint: digest.digest('hex') };
}

async function serialBuildFingerprint(repo: string): Promise<{ buildId: string; fingerprint: string }> {
  const root = path.join(repo, '.next'), digest = createHash('sha256');
  const stat = await fs.lstat(root); assert(stat.isDirectory() && !stat.isSymbolicLink());
  const buildId = (await fs.readFile(path.join(root, 'BUILD_ID'), 'utf8')).trim(); assert(buildId && buildId.length < 256);
  let visited = 0;
  const visit = async (directory: string, logical = '', linkedPackage = false): Promise<void> => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), relative = path.posix.join(logical, name);
      if (!linkedPackage && (relative === 'cache' || relative.startsWith('cache/') || name === frozenBuildProofName || name === `${frozenBuildProofName}.writing`
        || /^trace(?:-|$)/u.test(name))) continue;
      assert(++visited < 100_000);
      const current = await fs.lstat(file);
      if (current.isSymbolicLink()) {
        const alias = !linkedPackage && relative.match(/^node_modules\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)-[a-f0-9]{16}$/u);
        assert(alias, 'Unexpected compiled artifact symlink.');
        const dependencies = path.join(repo, 'node_modules'), target = path.join(dependencies, alias[1]);
        const dependencyStat = await fs.lstat(dependencies), targetStat = await fs.lstat(target);
        assert(dependencyStat.isDirectory() && !dependencyStat.isSymbolicLink());
        assert(targetStat.isDirectory() && !targetStat.isSymbolicLink());
        assert.equal(await fs.realpath(dependencies), dependencies); assert.equal(await fs.realpath(target), target);
        const link = await fs.readlink(file);
        assert.equal(link, path.relative(path.dirname(file), target));
        const manifest = path.join(target, 'package.json'), manifestStat = await fs.lstat(manifest);
        assert(manifestStat.isFile() && !manifestStat.isSymbolicLink());
        assert.equal(JSON.parse(await fs.readFile(manifest, 'utf8')).name, alias[1]);
        digest.update('link\0').update(relative).update('\0').update(link).update('\0').update(alias[1]).update('\0');
        await visit(target, relative, true);
      } else if (current.isDirectory()) await visit(file, relative, linkedPackage);
      else if (linkedPackage || /\.(?:[cm]?js|json|map|wasm|node)$/u.test(name) || relative === 'BUILD_ID') {
        assert(current.isFile()); digest.update(relative).update('\0').update(await fs.readFile(file)).update('\0');
      }
    }
  };
  await visit(root);
  return { buildId, fingerprint: digest.digest('hex') };
}

type Bytes = string | Buffer;
type Fingerprint = { fingerprint: string };
type Fingerprinter = (repo: string) => Promise<Fingerprint>;
type Fixture = { repo: string; source: Record<string, Bytes>; compiled: Record<string, Bytes>;
  packages: Record<string, Record<string, Bytes>>; aliases: Record<string, string> };

async function put(filename: string, bytes: Bytes): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, bytes);
}

async function fixture(root: string): Promise<Fixture> {
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const source: Record<string, Bytes> = {
    'app/a-b.ts': 'source hyphen', 'app/a/child.ts': 'nested source', 'app/a.ts': 'source dot', 'app/empty.ts': Buffer.alloc(0),
    'app/line\nbreak.ts': Buffer.from([0, 1, 255, 42]), 'app/emoji-😀.ts': 'Unicode filename',
    'components/panel.tsx': 'component', 'server/entry.ts': 'server', 'scripts/fixture.ts': 'script',
    'tests/fixture.ts': 'test', 'packages/local/asset.bin': Buffer.from([0, 255, 1]),
    'i18n/config.ts': 'locale', 'messages/en.json': '{}', 'public/image.png': Buffer.from([137, 80, 78, 71]),
    'package.json': '{}', 'package-lock.json': '{}', 'tsconfig.json': '{}', 'next.config.mjs': 'next',
    'server.cjs': 'root server', 'postcss.config.js': 'postcss', 'app/tracked-ignored.tmp': 'tracked despite ignore',
  };
  for (let index = 0; index < 20; index++) source[`app/bulk/${String(index).padStart(2, '0')}.bin`] = Buffer.alloc(196_625, index);
  for (const [name, bytes] of Object.entries(source)) await put(path.join(repo, name), bytes);
  await put(path.join(repo, '.gitignore'), '.next/\nnode_modules/\napp/*.tmp\n');
  await put(path.join(repo, 'docs/unselected.md'), 'tracked but unselected');
  await put(path.join(repo, 'README.md'), 'tracked but unselected root');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['add', '-f', 'app/tracked-ignored.tmp'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fingerprint fixture', '-c', 'user.email=fingerprint@example.test', 'commit', '-qm', 'Owned synthetic fingerprint fixture'], { cwd: repo });
  source['app/untracked.ts'] = 'included untracked source';
  await put(path.join(repo, 'app/untracked.ts'), source['app/untracked.ts']);
  await put(path.join(repo, 'app/ignored.tmp'), 'excluded untracked ignored source');
  const compiled: Record<string, Bytes> = {
    BUILD_ID: '  synthetic-build\n', 'a/child.js': 'compiled nested', 'a-b.js': 'compiled hyphen', 'a.js': 'compiled dot',
    'empty.js': Buffer.alloc(0), 'manifest.json': '{}', 'nested/chunk.cjs': 'commonjs', 'nested/chunk.js.map': 'map',
    'nested/chunk.mjs': 'module', 'native.node': Buffer.from([0, 255, 1, 2]),
    'tracecontext.js': 'included near trace name', 'wasm.wasm': Buffer.from([0, 97, 115, 109]),
  };
  for (let index = 0; index < 20; index++) compiled[`bulk/${String(index).padStart(2, '0')}.js`] = Buffer.alloc(196_625, 255 - index);
  for (const [name, bytes] of Object.entries(compiled)) await put(path.join(repo, '.next', name), bytes);
  for (const name of ['cache/stale.js', 'trace', 'trace-old.json', frozenBuildProofName,
    `${frozenBuildProofName}.writing`, `nested/${frozenBuildProofName}`, 'assets/excluded.png']) {
    await put(path.join(repo, '.next', name), 'excluded compiled bytes');
  }
  const packages: Fixture['packages'] = {
    '@scope/tool': { 'a/child.txt': 'scoped nested asset', 'a-b.txt': 'scoped hyphen', 'a.txt': 'scoped dot',
      'assets/picture.png': Buffer.from([0, 255, 13, 10]), bare: 'extensionless scoped asset',
      'cache/not-skipped.txt': 'linked cache bytes', 'empty.bin': Buffer.alloc(0), 'index.cjs': 'scoped entry',
      'package.json': JSON.stringify({ name: '@scope/tool', version: '1.0.0' }),
      trace: 'linked trace bytes', [frozenBuildProofName]: 'linked proof name bytes' },
    plain: { 'index.mjs': 'plain entry', 'package.json': JSON.stringify({ name: 'plain', version: '1.0.0' }),
      'runtime.node': Buffer.from([0, 1, 2, 255]), 'style.css': 'body { color: red; }', 'z.bin': Buffer.alloc(131_073, 37) },
  };
  const aliases: Fixture['aliases'] = { 'node_modules/@scope/tool-0123456789abcdef': '@scope/tool', 'node_modules/plain-fedcba9876543210': 'plain' };
  for (const [name, files] of Object.entries(packages)) {
    for (const [relative, bytes] of Object.entries(files)) await put(path.join(repo, 'node_modules', name, relative), bytes);
  }
  for (const [relative, name] of Object.entries(aliases)) {
    const link = path.join(repo, '.next', relative); await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(path.relative(path.dirname(link), path.join(repo, 'node_modules', name)), link);
  }
  return { repo, source, compiled, packages, aliases };
}

function expectedSource(head: string, files: Record<string, Bytes>): string {
  const digest = createHash('sha256').update(head);
  for (const name of Object.keys(files).sort()) digest.update(name).update('\0').update(files[name]).update('\0');
  return digest.digest('hex');
}

function expectedBuild(value: Fixture): string {
  const digest = createHash('sha256');
  const addFile = (relative: string, bytes: Bytes) => digest.update(relative).update('\0').update(bytes).update('\0');
  // Explicit DFS order: a/child precedes a-b and a.js; sorting flattened paths would differ.
  for (const relative of ['BUILD_ID', 'a/child.js', 'a-b.js', 'a.js',
    ...Array.from({ length: 20 }, (_, index) => `bulk/${String(index).padStart(2, '0')}.js`),
    'empty.js', 'manifest.json', 'native.node', 'nested/chunk.cjs', 'nested/chunk.js.map', 'nested/chunk.mjs']) {
    addFile(relative, value.compiled[relative]);
  }
  const linkedOrder: Record<string, string[]> = {
    '@scope/tool': ['a/child.txt', 'a-b.txt', 'a.txt', 'assets/picture.png', 'bare', 'cache/not-skipped.txt', 'empty.bin', 'index.cjs',
      'package.json', 'trace', frozenBuildProofName],
    plain: ['index.mjs', 'package.json', 'runtime.node', 'style.css', 'z.bin'],
  };
  for (const [relative, name] of Object.entries(value.aliases)) {
    const link = path.relative(path.dirname(path.join(value.repo, '.next', relative)), path.join(value.repo, 'node_modules', name));
    digest.update('link\0').update(relative).update('\0').update(link).update('\0').update(name).update('\0');
    for (const targetRelative of linkedOrder[name]) addFile(path.posix.join(relative, targetRelative), value.packages[name][targetRelative]);
  }
  addFile('tracecontext.js', value.compiled['tracecontext.js']); addFile('wasm.wasm', value.compiled['wasm.wasm']);
  return digest.digest('hex');
}

async function equivalent(repo: string): Promise<{ source: Awaited<ReturnType<typeof sourceFingerprint>>;
  built: Awaited<ReturnType<typeof buildFingerprint>> }> {
  const source = await sourceFingerprint(repo), built = await buildFingerprint(repo);
  assert.deepEqual(source, await serialSourceFingerprint(repo));
  assert.deepEqual(built, await serialBuildFingerprint(repo));
  return { source, built };
}

async function rejectsBoth(repo: string, original: Fingerprinter, optimized: Fingerprinter, label: string): Promise<void> {
  const errors: Array<{ name: string; code?: string }> = [];
  for (const [name, operation] of [['serial', original], ['optimized', optimized]] as const) {
    await assert.rejects(operation(repo), error => {
      assert(error instanceof Error, `${label}: ${name} must reject with an error`);
      errors.push({ name: error.name, code: (error as Error & { code?: string }).code });
      return true;
    }, `${label}: ${name} must reject`);
  }
  assert.deepEqual(errors[1], errors[0], `${label}: preserve the original error class and code`);
}

async function changedFile(filename: string, bytes: Bytes, run: () => Promise<void>): Promise<void> {
  const original = await fs.readFile(filename); await fs.writeFile(filename, bytes);
  try { await run(); } finally { await fs.writeFile(filename, original); }
}

async function removedFile(filename: string, run: () => Promise<void>): Promise<void> {
  const original = await fs.readFile(filename); await fs.unlink(filename);
  try { await run(); } finally { await fs.writeFile(filename, original); }
}

async function replacedPath(filename: string, replacement: () => Promise<void>, run: () => Promise<void>): Promise<void> {
  const held = `${filename}.held-for-fingerprint-test`; await fs.rename(filename, held);
  try { await replacement(); await run(); }
  finally { await fs.rm(filename, { recursive: true, force: true }); await fs.rename(held, filename); }
}

async function sourceCases(value: Fixture): Promise<void> {
  const { repo } = value, baseline = await equivalent(repo);
  assert.equal(baseline.source.fingerprint, expectedSource(baseline.source.head, value.source));
  assert.equal(baseline.built.fingerprint, expectedBuild(value));
  assert.equal(baseline.built.buildId, 'synthetic-build');
  for (const name of ['app/untracked.ts', 'app/tracked-ignored.tmp', 'public/image.png', 'app/bulk/19.bin']) {
    await changedFile(path.join(repo, name), 'changed source bytes\0', async () => {
      const changed = await equivalent(repo); assert.notEqual(changed.source.fingerprint, baseline.source.fingerprint);
      assert.deepEqual(changed.built, baseline.built);
    });
  }
  for (const name of ['app/ignored.tmp', 'docs/unselected.md', 'README.md']) {
    await changedFile(path.join(repo, name), 'changed excluded bytes', async () => {
      assert.deepEqual(await sourceFingerprint(repo), baseline.source);
      assert.deepEqual(await serialSourceFingerprint(repo), baseline.source);
    });
  }
  const extra = path.join(repo, 'tests/extra-untracked.txt'); await put(extra, 'new selected untracked file');
  try { assert.notEqual((await equivalent(repo)).source.fingerprint, baseline.source.fingerprint); }
  finally { await fs.unlink(extra); }
  await rejectsBoth(`${repo}/../repo`, serialSourceFingerprint, sourceFingerprint, 'noncanonical source path');
  const linkedRepo = path.join(path.dirname(repo), 'linked-repo'); await fs.symlink(repo, linkedRepo);
  try { await rejectsBoth(linkedRepo, serialSourceFingerprint, sourceFingerprint, 'symlinked source root'); }
  finally { await fs.unlink(linkedRepo); }
  await removedFile(path.join(repo, 'app/a.ts'), async () => {
    await rejectsBoth(repo, serialSourceFingerprint, sourceFingerprint, 'missing tracked source');
  });
  await replacedPath(path.join(repo, 'app/a.ts'), () => fs.symlink('a-b.ts', path.join(repo, 'app/a.ts')), async () => {
    await rejectsBoth(repo, serialSourceFingerprint, sourceFingerprint, 'symlinked source');
  });
  execFileSync('git', ['-c', 'user.name=Fingerprint fixture', '-c', 'user.email=fingerprint@example.test', 'commit', '--allow-empty', '-qm', 'Different synthetic source HEAD'], { cwd: repo });
  try {
    const changed = await equivalent(repo); assert.notEqual(changed.source.head, baseline.source.head);
    assert.notEqual(changed.source.fingerprint, baseline.source.fingerprint); assert.deepEqual(changed.built, baseline.built);
  } finally { execFileSync('git', ['reset', '-q', '--soft', baseline.source.head], { cwd: repo }); }
}

async function buildCases(value: Fixture): Promise<void> {
  const { repo } = value, baseline = await buildFingerprint(repo);
  for (const name of ['.next/a.js', '.next/nested/chunk.mjs', '.next/wasm.wasm', '.next/native.node', '.next/bulk/19.js',
    'node_modules/@scope/tool/assets/picture.png', 'node_modules/@scope/tool/bare', 'node_modules/@scope/tool/cache/not-skipped.txt',
    `node_modules/@scope/tool/${frozenBuildProofName}`, 'node_modules/@scope/tool/trace', 'node_modules/plain/style.css', 'node_modules/plain/z.bin']) {
    await changedFile(path.join(repo, name), Buffer.from([0, 255, 254, 128, 13, 10]), async () => {
      const result = await buildFingerprint(repo); assert.deepEqual(result, await serialBuildFingerprint(repo));
      assert.notEqual(result.fingerprint, baseline.fingerprint, `${name}: all target bytes must participate`);
    });
  }
  for (const name of ['cache/stale.js', 'trace', 'trace-old.json', frozenBuildProofName,
    `${frozenBuildProofName}.writing`, `nested/${frozenBuildProofName}`, 'assets/excluded.png']) {
    await changedFile(path.join(repo, '.next', name), 'changed skipped artifact', async () => {
      assert.deepEqual(await buildFingerprint(repo), baseline); assert.deepEqual(await serialBuildFingerprint(repo), baseline);
    });
  }
  for (const name of ['trace', frozenBuildProofName]) {
    await replacedPath(path.join(repo, '.next', name), () => fs.symlink('missing-skipped-target', path.join(repo, '.next', name)), async () => {
      assert.deepEqual(await buildFingerprint(repo), baseline); assert.deepEqual(await serialBuildFingerprint(repo), baseline);
    });
  }
  const reject = (label: string) => rejectsBoth(repo, serialBuildFingerprint, buildFingerprint, label);
  for (const bytes of ['', ' '.repeat(257), 'x'.repeat(256)]) await changedFile(path.join(repo, '.next/BUILD_ID'), bytes, () => reject('invalid build ID'));
  await removedFile(path.join(repo, '.next/BUILD_ID'), () => reject('missing build ID'));
  await replacedPath(path.join(repo, '.next'), () => fs.symlink('.next.held-for-fingerprint-test', path.join(repo, '.next')), () => reject('symlinked build root'));
  await replacedPath(path.join(repo, '.next'), () => fs.writeFile(path.join(repo, '.next'), 'file instead of build root'), () => reject('file build root'));
  for (const relative of ['unexpected.js', 'assets/excluded.png.link', 'node_modules/plain-bad',
    'nested/node_modules/plain-0123456789abcdef', 'node_modules/Plain-0123456789abcdef']) {
    const link = path.join(repo, '.next', relative); await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(path.join(repo, 'node_modules/plain'), link);
    try { await reject(`unexpected compiled symlink ${relative}`); } finally { await fs.unlink(link); }
  }
  await replacedPath(path.join(repo, '.next/assets/excluded.png'), () => fs.symlink('../a.js', path.join(repo, '.next/assets/excluded.png')),
    () => reject('nonhashed compiled file still rejects arbitrary symlink'));
  const alias = path.join(repo, '.next/node_modules/plain-fedcba9876543210'), target = path.join(repo, 'node_modules/plain');
  for (const link of [target, path.relative(path.dirname(alias), path.dirname(repo)), `${path.relative(path.dirname(alias), target)}/.`]) {
    await replacedPath(alias, () => fs.symlink(link, alias), () => reject('alias link text must be exact'));
  }
  await replacedPath(path.join(repo, 'node_modules'), () => fs.symlink('node_modules.held-for-fingerprint-test', path.join(repo, 'node_modules')),
    () => reject('symlinked node_modules'));
  await replacedPath(target, () => fs.symlink('plain.held-for-fingerprint-test', target), () => reject('symlinked package target'));
  await replacedPath(target, () => fs.writeFile(target, 'file target'), () => reject('file package target'));
  await replacedPath(target, async () => {}, () => reject('missing package target'));
  const scoped = path.join(repo, 'node_modules/@scope');
  await replacedPath(scoped, () => fs.symlink('@scope.held-for-fingerprint-test', scoped), () => reject('noncanonical scoped target'));
  const manifest = path.join(target, 'package.json');
  for (const bytes of ['{', JSON.stringify({ name: 'other-package' }), JSON.stringify({ version: '1' })]) {
    await changedFile(manifest, bytes, () => reject('package manifest mismatch'));
  }
  await removedFile(manifest, () => reject('missing package manifest'));
  await replacedPath(manifest, () => fs.symlink('package.json.held-for-fingerprint-test', manifest), () => reject('symlinked package manifest'));
  await replacedPath(manifest, () => fs.mkdir(manifest), () => reject('directory package manifest'));
  const internal = path.join(target, 'internal.txt'); await fs.symlink('index.mjs', internal);
  try { await reject('nested target link'); } finally { await fs.unlink(internal); }
  const nestedAlias = path.join(target, 'node_modules/plain-0123456789abcdef'); await fs.mkdir(path.dirname(nestedAlias), { recursive: true });
  await fs.symlink(target, nestedAlias);
  try { await reject('alias-looking link inside linked package'); } finally { await fs.unlink(nestedAlias); }
  assert.deepEqual(await buildFingerprint(repo), baseline);
}

type IoMetrics = { opened: number; closed: number; active: number; highWater: number; reads: number;
  reading: number; readHighWater: number; maxBuffer: number };
type IoFailure = { file: string; phase: 'open' | 'stat' | 'first-read' | 'later-read' | 'close' | 'read-and-close' | 'later-read-and-close' };

function errorMessages(error: unknown): string {
  return error instanceof AggregateError ? [error.message, ...error.errors.map(errorMessages)].join('\n') : String(error);
}

async function instrumentReads(repo: string, run: (metrics: IoMetrics) => Promise<void>, failure?: IoFailure): Promise<void> {
  const originalOpen = fs.open, metrics: IoMetrics = { opened: 0, closed: 0, active: 0, highWater: 0, reads: 0, reading: 0, readHighWater: 0, maxBuffer: 0 };
  const injected = new Error(`Synthetic fingerprint ${failure?.phase ?? 'unused'} failure`);
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === failure?.file && failure.phase === 'open') throw injected;
    const handle = await Reflect.apply(originalOpen, fs, args) as Awaited<ReturnType<typeof fs.open>>;
    if (typeof args[0] !== 'string' || !args[0].startsWith(`${repo}${path.sep}`)) return handle;
    const filename = args[0], originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle), originalStat = handle.stat.bind(handle);
    metrics.opened++; metrics.active++; metrics.highWater = Math.max(metrics.highWater, metrics.active);
    let closed = false, fileReads = 0, closeAttempts = 0, firstBuffer: Buffer | undefined;
    handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
      if (filename === failure?.file && failure.phase === 'stat') throw injected;
      return Reflect.apply(originalStat, handle, statArgs);
    }) as typeof handle.stat;
    handle.read = (async (...readArgs: unknown[]) => {
      fileReads++; metrics.reads++; metrics.reading++; metrics.readHighWater = Math.max(metrics.readHighWater, metrics.reading);
      assert(Buffer.isBuffer(readArgs[0]), 'Fingerprint reads must use bounded byte buffers');
      if (firstBuffer) assert.equal(readArgs[0], firstBuffer, 'Each open file must reuse its single chunk buffer');
      else firstBuffer = readArgs[0];
      metrics.maxBuffer = Math.max(metrics.maxBuffer, readArgs[0].byteLength);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (filename === failure?.file && ((failure.phase === 'first-read' || failure.phase === 'read-and-close') && fileReads === 1
          || (failure.phase === 'later-read' || failure.phase === 'later-read-and-close') && fileReads === 2)) throw injected;
        return await Reflect.apply(originalRead, handle, readArgs);
      } finally { metrics.reading--; }
    }) as typeof handle.read;
    handle.close = async () => {
      assert(!closed, 'Each fingerprint file handle must close once'); closeAttempts++;
      assert(closeAttempts <= 2, 'A failed close may use only one bounded retry');
      if (filename === failure?.file && ['close', 'read-and-close', 'later-read-and-close'].includes(failure.phase) && closeAttempts === 1) {
        throw new Error('Synthetic fingerprint close failure');
      }
      await originalClose(); closed = true; metrics.closed++; metrics.active--;
    };
    return handle;
  }) as typeof fs.open;
  try { await run(metrics); }
  finally {
    fs.open = originalOpen;
    assert.equal(metrics.active, 0, 'Every opened fingerprint handle must close, including prefetched reads');
    assert.equal(metrics.closed, metrics.opened);
    assert.equal(metrics.reading, 0, 'Fingerprint must settle all active reads before returning');
  }
}

async function ioCases(value: Fixture): Promise<void> {
  for (const [operation, serial, failure] of [[sourceFingerprint, serialSourceFingerprint, 'app/bulk/08.bin'],
    [buildFingerprint, serialBuildFingerprint, '.next/bulk/08.js']] as const) {
    const expected = await serial(value.repo);
    await instrumentReads(value.repo, async metrics => {
      assert.deepEqual(await operation(value.repo), expected);
      assert(metrics.highWater > 1 && metrics.highWater <= 8, 'Fingerprint file reads must overlap within the eight-file limit');
      assert(metrics.readHighWater > 1 && metrics.readHighWater <= 8, 'Concurrent reads must be bounded by the file window');
      assert(metrics.maxBuffer > 0 && metrics.maxBuffer <= 64 * 1024, 'Per-read buffer must be at most 64 KiB');
    });
    for (const phase of ['open', 'stat', 'first-read', 'later-read', 'close', 'read-and-close', 'later-read-and-close'] as const) {
      const unhandled: unknown[] = [], listener = (error: unknown) => { unhandled.push(error); };
      process.on('unhandledRejection', listener);
      try {
        await instrumentReads(value.repo, async metrics => {
          await assert.rejects(operation(value.repo), error => {
            const messages = errorMessages(error);
            assert.match(messages, new RegExp(`Synthetic fingerprint ${phase} failure`, 'u'));
            if (phase.includes('and-close')) assert.match(messages, /Synthetic fingerprint close failure/u);
            return true;
          });
          assert.equal(metrics.active, 0);
          const reads = metrics.reads; await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(metrics.reads, reads, 'No prefetched file read may continue after rejection');
        }, { file: path.join(value.repo, failure), phase });
        await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
      } finally { process.off('unhandledRejection', listener); }
    }
  }
  for (const [operation, relative] of [[sourceFingerprint, 'app/bulk/18.bin'], [buildFingerprint, '.next/bulk/18.js']] as const) {
    const originalLstat = fs.lstat;
    await instrumentReads(value.repo, async () => {
      fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === path.join(value.repo, relative)) throw new Error('Synthetic fingerprint metadata failure');
        return Reflect.apply(originalLstat, fs, args);
      }) as typeof fs.lstat;
      try { await assert.rejects(operation(value.repo), /Synthetic fingerprint metadata failure/u); }
      finally { fs.lstat = originalLstat; }
    });
  }
  for (const [operation, queuedFailure, metadataFailure] of [[sourceFingerprint, 'app/bulk/02.bin', 'app/bulk/03.bin'],
    [buildFingerprint, '.next/bulk/01.js', '.next/bulk/02.js']] as const) {
    const originalLstat = fs.lstat;
    await instrumentReads(value.repo, async () => {
      fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === path.join(value.repo, metadataFailure)) throw new Error('Synthetic earlier iterator failure');
        return Reflect.apply(originalLstat, fs, args);
      }) as typeof fs.lstat;
      try {
        await assert.rejects(operation(value.repo), error => {
          const messages = errorMessages(error);
          assert.match(messages, /Synthetic earlier iterator failure/u);
          assert.match(messages, /Synthetic fingerprint read-and-close failure/u);
          assert.match(messages, /Synthetic fingerprint close failure/u);
          return true;
        });
      } finally { fs.lstat = originalLstat; }
    }, { file: path.join(value.repo, queuedFailure), phase: 'read-and-close' });
  }
  for (const operation of [sourceFingerprint, buildFingerprint]) {
    const originalLstat = fs.lstat; let pending = 0, highWater = 0;
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      if (typeof args[0] !== 'string' || !args[0].startsWith(`${value.repo}${path.sep}`)) return Reflect.apply(originalLstat, fs, args);
      pending++; highWater = Math.max(highWater, pending);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        return await Reflect.apply(originalLstat, fs, args);
      } finally { pending--; }
    }) as typeof fs.lstat;
    try {
      await operation(value.repo);
      assert(highWater > 1 && highWater <= 8, 'Metadata reads must overlap within one eight-entry batch across recursive descent');
      assert.equal(pending, 0);
    } finally { fs.lstat = originalLstat; }
  }
  for (const [operation, relative] of [[sourceFingerprint, 'app/bulk/18.bin'], [buildFingerprint, '.next/bulk/18.js']] as const) {
    const filename = path.join(value.repo, relative), original = await fs.readFile(filename);
    for (const mutation of ['symlink', 'missing', 'directory'] as const) {
      try {
        await instrumentReads(value.repo, async () => {
          const trackedOpen = fs.open; let mutated = false;
          fs.open = (async (...args: Parameters<typeof fs.open>) => {
            if (!mutated && args[0] === filename) {
              mutated = true; await fs.unlink(filename);
              if (mutation === 'symlink') await fs.symlink(path.join(value.repo, 'package.json'), filename);
              else if (mutation === 'directory') await fs.mkdir(filename);
            }
            return Reflect.apply(trackedOpen, fs, args);
          }) as typeof fs.open;
          try { await assert.rejects(operation(value.repo)); assert(mutated, 'Mutation must occur between metadata validation and open'); }
          finally { fs.open = trackedOpen; }
        });
      } finally { await fs.rm(filename, { recursive: true, force: true }); await fs.writeFile(filename, original); }
    }
  }
}

async function visitLimitCase(root: string): Promise<void> {
  const repo = path.join(root, 'visit-limit-repo'), directory = path.join(repo, '.next/limit');
  await put(path.join(repo, '.next/BUILD_ID'), 'synthetic-limit'); await fs.mkdir(directory);
  const physical = path.join(root, 'synthetic-ignored-entry.txt'); await fs.writeFile(physical, 'not compiled');
  const stat = await fs.lstat(physical), originalReaddir = fs.readdir, originalLstat = fs.lstat;
  // Preserve the frozen v1 100,000-visit rejection independently of capacity v2.
  // Ignored entries still count, but this complete 100,002-entry tree now fits.
  const names = Array.from({ length: 100_000 }, (_, index) => `${String(index).padStart(6, '0')}.txt`);
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => args[0] === directory ? names : Reflect.apply(originalReaddir, fs, args)) as typeof fs.readdir;
  fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => typeof args[0] === 'string' && args[0].startsWith(`${directory}${path.sep}`)
    ? stat : Reflect.apply(originalLstat, fs, args)) as typeof fs.lstat;
  try {
    await assert.rejects(serialBuildFingerprint(repo), { name: 'AssertionError', code: 'ERR_ASSERTION' }, 'Frozen v1 visit limit must still reject.');
    assert.deepEqual(await buildFingerprint(repo), { buildId: 'synthetic-limit',
      fingerprint: createHash('sha256').update('BUILD_ID\0synthetic-limit\0').digest('hex') });
  }
  finally { fs.readdir = originalReaddir; fs.lstat = originalLstat; }
}

async function main(): Promise<void> {
  assert.equal(buildProofName, frozenBuildProofName);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-yjs-fingerprint-')));
  try {
    const value = await fixture(root);
    await sourceCases(value); await buildCases(value); await ioCases(value); await visitLimitCase(root);
    await equivalent(value.repo);
    console.log('Owned Yjs fingerprints passed: frozen serial equivalence, sorted DFS/link tuples, source selection, all linked asset bytes, path/package/visit guards, bounded reads and failure cleanup.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
