import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFingerprint } from './lib/owned-yjs-authority-qa';

// Virtual directory entries keep the boundary fixture small. Every selected
// logical file still opens, reads and closes a real file through the real hasher.
async function main(): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-artifact-budget-')));
  const repo = path.join(root, 'repo'), build = path.join(repo, '.next');
  const chunks = path.join(build, 'z-chunks'), payload = path.join(root, 'payload');
  const original = { readdir: fs.readdir, lstat: fs.lstat, open: fs.open };
  const bytes = Buffer.from('complete compiled or external bytes\n');
  const changed = Buffer.from('changed final logical file\n'), changedPayload = path.join(root, 'changed');
  const buildId = 'synthetic-two-origin-budget';
  const aliases: Array<{ name: string; packageName: string; link: string }> = [];
  const virtual = new Map<string, { names: string[]; members: Set<string> }>();
  const mutated = new Set<string>();
  const virtualDirectories = new Set<string>(), unhashedCompiledNames = new Set<string>();
  let opened = 0, closed = 0, active = 0, highWater = 0;
  const names = (count: number, extension: string) => Array.from({ length: count }, (_, index) => `${String(index).padStart(6, '0')}.${extension}`);
  const setEntries = (directory: string, entries: string[]) => virtual.set(directory, { names: entries, members: new Set(entries) });
  const isVirtual = (filename: unknown): filename is string => typeof filename === 'string'
    && Boolean(virtual.get(path.dirname(filename))?.members.has(path.basename(filename)));
  const expected = () => {
    const digest = createHash('sha256');
    const file = (relative: string, contents: Buffer | string) => digest.update(`${relative}\0`).update(contents).update('\0');
    file('BUILD_ID', buildId);
    for (const alias of aliases) {
      const relative = `node_modules/${alias.name}`;
      digest.update(`link\0${relative}\0${alias.link}\0${alias.packageName}\0`);
      const directory = path.join(repo, 'node_modules', alias.packageName, 'files');
      for (const name of virtual.get(directory)!.names) {
        file(`${relative}/files/${name}`, mutated.has(path.join(directory, name)) ? changed : bytes);
      }
      file(`${relative}/package.json`, JSON.stringify({ name: alias.packageName }));
    }
    for (const name of virtual.get(chunks)!.names) {
      if (!unhashedCompiledNames.has(name)) file(`z-chunks/${name}`, mutated.has(path.join(chunks, name)) ? changed : bytes);
    }
    return { buildId, fingerprint: digest.digest('hex') };
  };
  const addAlias = async (packageName: string, suffix: string) => {
    const name = `${packageName}-${suffix}`, filename = path.join(build, 'node_modules', name);
    const link = path.relative(path.dirname(filename), path.join(repo, 'node_modules', packageName));
    await fs.symlink(link, filename); aliases.push({ name, packageName, link });
    aliases.sort((left, right) => left.name.localeCompare(right.name));
  };
  const assertClosed = async () => {
    assert.equal(active, 0); assert.equal(opened, closed); assert(highWater <= 8);
    const observed = opened;
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(opened, observed, 'No fingerprint reads may continue after completion or rejection.');
  };
  try {
    await fs.chmod(root, 0o700);
    await fs.mkdir(chunks, { recursive: true }); await fs.mkdir(path.join(build, 'node_modules'));
    await fs.writeFile(path.join(build, 'BUILD_ID'), buildId);
    await fs.writeFile(payload, bytes); await fs.writeFile(changedPayload, changed);
    for (const packageName of ['a', 'b']) {
      const target = path.join(repo, 'node_modules', packageName);
      await fs.mkdir(path.join(target, 'files'), { recursive: true });
      await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({ name: packageName }));
      setEntries(path.join(target, 'files'), []);
    }
    await addAlias('a', '0123456789abcdef');
    const metadata = await original.lstat(payload), directoryMetadata = await original.lstat(chunks);
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
      const entries = virtual.get(String(args[0]));
      return entries ? [...entries.names] : Reflect.apply(original.readdir, fs, args);
    }) as typeof fs.readdir;
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => isVirtual(args[0])
      ? virtualDirectories.has(args[0]) ? directoryMetadata : metadata : Reflect.apply(original.lstat, fs, args)) as typeof fs.lstat;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      if (!isVirtual(args[0])) return Reflect.apply(original.open, fs, args);
      const handle = await Reflect.apply(original.open, fs, [mutated.has(args[0]) ? changedPayload : payload, ...args.slice(1)]);
      opened++; active++; highWater = Math.max(highWater, active);
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed++; active--; };
      return handle;
    }) as typeof fs.open;

    setEntries(chunks, names(90_000, 'js'));
    const firstPackage = path.join(repo, 'node_modules/a/files');
    setEntries(firstPackage, names(11_000, 'bin'));
    console.log('Checking complete mixed-origin fingerprint beyond the former 100,000 total-entry limit.');
    const baseline = await buildFingerprint(repo);
    assert.deepEqual(baseline, expected()); await assertClosed();
    for (const directory of [chunks, firstPackage]) {
      const filename = path.join(directory, virtual.get(directory)!.names.at(-1)!);
      mutated.add(filename);
      const result = await buildFingerprint(repo);
      assert.notEqual(result.fingerprint, baseline.fingerprint); assert.deepEqual(result, expected());
      mutated.delete(filename); await assertClosed();
    }

    // Each package is individually below the cap; their combined contents must fail.
    setEntries(chunks, []); setEntries(firstPackage, names(50_000, 'bin'));
    const secondPackage = path.join(repo, 'node_modules/b/files');
    setEntries(secondPackage, names(50_000, 'bin')); await addAlias('b', '0123456789abcdef');
    await assert.rejects(buildFingerprint(repo), /External package artifact visit limit/u); await assertClosed();
    await fs.unlink(path.join(build, 'node_modules', aliases.pop()!.name));

    // Repeated valid aliases are distinct logical tuples, never inode-deduplicated.
    await addAlias('a', 'fedcba9876543210'); setEntries(firstPackage, names(12, 'bin'));
    assert.deepEqual(await buildFingerprint(repo), expected()); await assertClosed();
    setEntries(firstPackage, names(50_000, 'bin'));
    await assert.rejects(buildFingerprint(repo), /External package artifact visit limit/u); await assertClosed();

    // Capacity v2 keeps all structural entries in its compiled budget. Fixed
    // overhead is BUILD_ID, node_modules, its one alias and z-chunks itself.
    await fs.unlink(path.join(build, 'node_modules', aliases.pop()!.name));
    setEntries(firstPackage, []);
    const compiledLimitV2 = 110_000, fixedCompiledEntries = 4;
    const directoryName = 'z-directory', ignoredName = 'z-ignored.txt', lateName = 'z-selected.js';
    const boundaryNames = [...names(compiledLimitV2 - 1 - fixedCompiledEntries - 3, 'js'), directoryName, ignoredName, lateName];
    virtualDirectories.add(path.join(chunks, directoryName)); setEntries(path.join(chunks, directoryName), []);
    unhashedCompiledNames.add(directoryName); unhashedCompiledNames.add(ignoredName);
    setEntries(chunks, boundaryNames);
    assert.equal(fixedCompiledEntries + boundaryNames.length, compiledLimitV2 - 1);
    const boundary = await buildFingerprint(repo);
    assert.deepEqual(boundary, expected()); await assertClosed();
    const lateFile = path.join(chunks, lateName); mutated.add(lateFile);
    const lateChanged = await buildFingerprint(repo);
    assert.notEqual(lateChanged.fingerprint, boundary.fingerprint); assert.deepEqual(lateChanged, expected());
    mutated.delete(lateFile); await assertClosed();
    for (const kind of ['file', 'directory'] as const) {
      const overflowName = kind === 'file' ? 'zz-ignored.txt' : 'zz-directory', overflow = path.join(chunks, overflowName);
      unhashedCompiledNames.add(overflowName);
      if (kind === 'directory') { virtualDirectories.add(overflow); setEntries(overflow, []); }
      setEntries(chunks, [...boundaryNames, overflowName]);
      assert.equal(fixedCompiledEntries + virtual.get(chunks)!.names.length, compiledLimitV2);
      await assert.rejects(buildFingerprint(repo), /Compiled artifact visit limit/u); await assertClosed();
    }
    console.log('Artifact budgets passed: complete mixed-origin digest, late-byte changes beyond 100,000 entries, aggregate package and repeated-alias limits, exact capacity-v2 compiled boundary including ignored files and directories, and bounded handle cleanup.');
  } finally {
    fs.readdir = original.readdir; fs.lstat = original.lstat; fs.open = original.open;
    assert.equal(active, 0); assert.equal(opened, closed);
    await fs.rm(root, { recursive: true, force: false });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
