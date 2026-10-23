import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBuildProof, buildFingerprint, buildProofName, hash, sourceFingerprint, writePrivateJson } from './lib/owned-yjs-authority-qa';

async function main(): Promise<void> {
  assert(['darwin', 'linux'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-fingerprint-')));
  await fs.chmod(root, 0o700);
  const repo = path.join(root, 'repo'), sourceName = 'tools/native-fs/fd-publication.c';
  const nativeDirectory = `native/fd-publication/${process.platform}-${process.arch}`;
  const artifactNames = ['manifest.json', 'source.c', 'fd-publication.node'].map(name => `${nativeDirectory}/${name}`);
  const sourceBytes = Buffer.from('/* Synthetic source; never compiled or executed. */\n');
  const binaryBytes = Buffer.from([0, 255, 1, 42, 0, 97, 115, 109]);
  const manifest = { version: 1, apiVersion: 3, napiVersion: 8, platform: process.platform, arch: process.arch,
    sourceSha256: hash(sourceBytes), binarySha256: hash(binaryBytes), nodeVersion: 'synthetic-node', compiler: 'synthetic-compiler' };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const originals = new Map<string, Buffer>([[sourceName, sourceBytes], [artifactNames[0], manifestBytes],
    [artifactNames[1], sourceBytes], [artifactNames[2], binaryBytes]]);
  let groups = 0;
  const put = async (relative: string, bytes: string | Buffer) => {
    const filename = path.join(repo, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, bytes, { mode: 0o600 });
  };
  try {
    await fs.mkdir(repo, { mode: 0o700 });
    await put('app/page.tsx', 'export default function Page() { return null; }');
    await put('.gitignore', '.next/\nnative/\n');
    await put(sourceName, sourceBytes);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Native fingerprint fixture', '-c', 'user.email=fixture@example.test',
      'commit', '-qm', 'Synthetic source and native artifact fixture'], { cwd: repo });
    await put('.next/BUILD_ID', 'synthetic-native-build');
    await put('.next/server/runtime.js', 'compiled synthetic runtime');
    for (const [relative, bytes] of originals) await put(relative, bytes);
    const source = await sourceFingerprint(repo), built = await buildFingerprint(repo);
    await writePrivateJson(path.join(repo, '.next', buildProofName), { version: 1, repo, head: source.head,
      sourceFingerprint: source.fingerprint, buildFingerprint: built.fingerprint, buildId: built.buildId,
      createdAt: new Date().toISOString() }, true);
    await assertBuildProof(repo); groups++;

    const reject = async (label: string, change: () => Promise<unknown>, restore: () => Promise<unknown>) => {
      await change();
      try {
        await assert.rejects(buildFingerprint(repo), `${label}: native build binding must reject`);
        await assert.rejects(assertBuildProof(repo), `${label}: original proof must reject`);
      } finally { await restore(); }
      await assertBuildProof(repo); groups++;
    };

    await put(sourceName, Buffer.concat([sourceBytes, Buffer.from('/* dirty C source */\n')]));
    try {
      assert.notEqual((await sourceFingerprint(repo)).fingerprint, source.fingerprint);
      await assert.rejects(buildFingerprint(repo)); await assert.rejects(assertBuildProof(repo));
    } finally { await put(sourceName, sourceBytes); }
    await assertBuildProof(repo); groups++;

    await put(artifactNames[0], JSON.stringify({ ...manifest, compiler: 'changed valid compiler metadata' }, null, 2) + '\n');
    try {
      assert.notEqual((await buildFingerprint(repo)).fingerprint, built.fingerprint);
      await assert.rejects(assertBuildProof(repo));
    } finally { await put(artifactNames[0], manifestBytes); }
    await assertBuildProof(repo); groups++;

    const changedBinary = Buffer.concat([binaryBytes, Buffer.from('changed native bytes')]);
    await put(artifactNames[2], changedBinary);
    await put(artifactNames[0], JSON.stringify({ ...manifest, binarySha256: hash(changedBinary) }, null, 2) + '\n');
    try {
      assert.notEqual((await buildFingerprint(repo)).fingerprint, built.fingerprint);
      await assert.rejects(assertBuildProof(repo));
    } finally { await put(artifactNames[2], binaryBytes); await put(artifactNames[0], manifestBytes); }
    await assertBuildProof(repo); groups++;

    for (const relative of artifactNames) {
      const bytes = originals.get(relative)!;
      await reject(`byte drift ${relative}`, () => put(relative, Buffer.concat([bytes, Buffer.from('drift')])), () => put(relative, bytes));
    }
    for (const [relative, bytes] of originals) {
      const filename = path.join(repo, relative), held = `${filename}.held`;
      await reject(`missing ${relative}`, () => fs.rename(filename, held), () => fs.rename(held, filename));
      await reject(`symlink ${relative}`, async () => { await fs.rename(filename, held); await fs.symlink(path.basename(held), filename); },
        async () => { await fs.unlink(filename); await fs.rename(held, filename); });
      const link = path.join(root, 'extra-hard-link');
      await reject(`hardlink ${relative}`, () => fs.link(filename, link), () => fs.unlink(link));
      await reject(`writable ${relative}`, () => fs.chmod(filename, 0o622), () => fs.chmod(filename, 0o600));
      await reject(`empty ${relative}`, () => put(relative, Buffer.alloc(0)), () => put(relative, bytes));
      await reject(`oversize ${relative}`, () => put(relative, Buffer.alloc(2 * 1024 * 1024 + 1, 42)), () => put(relative, bytes));
      await reject(`directory ${relative}`, async () => { await fs.rename(filename, held); await fs.mkdir(filename, { mode: 0o700 }); },
        async () => { await fs.rmdir(filename); await fs.rename(held, filename); });
      await reject(`FIFO ${relative}`, async () => {
        await fs.rename(filename, held); execFileSync('mkfifo', ['-m', '600', filename]);
      }, async () => { await fs.unlink(filename); await fs.rename(held, filename); });
    }
    for (const relative of ['tools', 'tools/native-fs', 'native', 'native/fd-publication', nativeDirectory]) {
      const directory = path.join(repo, relative), held = `${directory}.held`;
      await reject(`symlink parent ${relative}`, async () => { await fs.rename(directory, held); await fs.symlink(path.basename(held), directory); },
        async () => { await fs.unlink(directory); await fs.rename(held, directory); });
      await reject(`writable parent ${relative}`, () => fs.chmod(directory, 0o722), () => fs.chmod(directory, 0o700));
    }
    for (const [label, text] of [
      ['API1', JSON.stringify({ ...manifest, apiVersion: 1 }, null, 2) + '\n'],
      ['foreign platform', JSON.stringify({ ...manifest, platform: 'foreign' }, null, 2) + '\n'],
      ['foreign arch', JSON.stringify({ ...manifest, arch: 'foreign' }, null, 2) + '\n'],
      ['extra key', JSON.stringify({ ...manifest, extra: true }, null, 2) + '\n'],
      ['duplicate key', `{\n  "version": 1,${manifestBytes.toString().slice(1)}`],
      ['source hash', JSON.stringify({ ...manifest, sourceSha256: 'a'.repeat(64) }, null, 2) + '\n'],
      ['binary hash', JSON.stringify({ ...manifest, binarySha256: 'b'.repeat(64) }, null, 2) + '\n'],
      ['noncanonical JSON', JSON.stringify(manifest)],
    ]) await reject(`manifest ${label}`, () => put(artifactNames[0], text), () => put(artifactNames[0], manifestBytes));

    // Replacing every native byte with a coherent new artifact still invalidates the old proof.
    const changedSource = Buffer.concat([sourceBytes, Buffer.from('/* coherent replacement */\n')]);
    await put(sourceName, changedSource); await put(artifactNames[1], changedSource); await put(artifactNames[2], changedBinary);
    await put(artifactNames[0], JSON.stringify({ ...manifest, sourceSha256: hash(changedSource), binarySha256: hash(changedBinary) }, null, 2) + '\n');
    try {
      assert.notEqual((await sourceFingerprint(repo)).fingerprint, source.fingerprint);
      assert.notEqual((await buildFingerprint(repo)).fingerprint, built.fingerprint);
      await assert.rejects(assertBuildProof(repo));
    } finally { for (const [relative, bytes] of originals) await put(relative, bytes); }
    await assertBuildProof(repo); groups++;
    console.log(`Native artifact fingerprint: ${groups} actual filesystem groups passed; synthetic binary never loaded, no server/DB/browser/container started.`);
  } finally { await fs.rm(root, { recursive: true, force: false }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
