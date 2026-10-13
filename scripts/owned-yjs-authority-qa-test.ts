import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBuildProof, assertCompletedYjsBrowserGate, assertDatabaseOwnership, assertOrigin, assertOwnedRoot, buildFingerprint,
  buildProofName, privateBytes, redactBoundedOutput, sourceFingerprint, writePrivateJson, type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';

async function main() {
  const { runOwnedYjsAcceptance, child, signalOwnChild, ownedGroupEmpty } = await import('./run-yjs-authority-e2e');
  const priorOptIn = process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
  delete process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
  try {
    const complete = { version: 1 as const, status: 'passed', declared: 2, passed: 2, failed: 0, skipped: 0, timedOut: 0, interrupted: 0 };
    assertCompletedYjsBrowserGate(complete);
    for (const patch of [{ declared: 0, passed: 0 }, { passed: 0, skipped: 2 }, { passed: 1 }, { failed: 1 }, { status: 'failed' }, { declared: NaN }]) {
      assert.throws(() => assertCompletedYjsBrowserGate({ ...complete, ...patch }));
    }
    await assert.rejects(runOwnedYjsAcceptance('/does-not-exist', [], 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)), /explicitly coordinate/u);
  } finally {
    if (priorOptIn === undefined) delete process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
    else process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START = priorOptIn;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-yjs-guard-contract-')));
  await fs.chmod(root, 0o700);
  try {
    const dataRoot = path.join(root, 'data'); await fs.mkdir(dataRoot, { mode: 0o700 });
    const nonce = randomBytes(16).toString('hex'), marker = randomBytes(24).toString('hex');
    await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600, flag: 'wx' });
    const rootStat = await fs.lstat(root), dataStat = await fs.lstat(dataRoot);
    const receipt = { version: 1, nonce, fixtureRoot: root, ownerMarker: marker, rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino),
      dataRoot, dataDevice: String(dataStat.dev), dataInode: String(dataStat.ino), databaseName: `canvas_yjs_e2e_${nonce}`,
      databaseOid: '12345', databaseOwner: 'fixture-role', createAcknowledged: true } as OwnedYjsReceipt;
    await assertOwnedRoot(receipt);
    await assert.rejects(assertOwnedRoot({ ...receipt, rootInode: '0' }));
    await assert.rejects(assertOwnedRoot({ ...receipt, ownerMarker: 'a'.repeat(48) }));
    await fs.chmod(dataRoot, 0o755); await assert.rejects(assertOwnedRoot(receipt)); await fs.chmod(dataRoot, 0o700);
    const identity = { name: receipt.databaseName, oid: '12345', owner: 'fixture-role', role: 'fixture-role', marker };
    assertDatabaseOwnership(receipt, identity);
    for (const patch of [{ createAcknowledged: false }, { databaseOid: '12346' }, { databaseName: 'canvas_notebook' }, { databaseOwner: 'foreign-role' }]) {
      assert.throws(() => assertDatabaseOwnership({ ...receipt, ...patch }, identity));
    }
    assert.throws(() => assertDatabaseOwnership(receipt, { ...identity, marker: 'foreign' }));
    assert.equal(assertOrigin('http://127.0.0.1:42345').port, '42345');
    for (const value of ['http://127.0.0.1:3000', 'http://127.0.0.1:3100', 'http://localhost:42345', 'http://0.0.0.0:42345', 'https://127.0.0.1:42345', 'http://127.0.0.1:42345/?token=x']) {
      assert.throws(() => assertOrigin(value));
    }
    const privateFile = path.join(root, 'private.json'); await writePrivateJson(privateFile, { safe: true }, true);
    await fs.symlink(privateFile, path.join(root, 'linked.json')); await assert.rejects(privateBytes(path.join(root, 'linked.json')));
    await fs.link(privateFile, path.join(root, 'hardlinked.json')); await assert.rejects(privateBytes(privateFile)); await fs.unlink(path.join(root, 'hardlinked.json'));
    await fs.chmod(privateFile, 0o644); await assert.rejects(privateBytes(privateFile)); await fs.chmod(privateFile, 0o600);
    const secret = 'synthetic-guard-secret';
    const redacted = redactBoundedOutput(`password=${secret}\nBearer unknown-token\npostgresql://name:pwd@127.0.0.1:55433/db\nhttps://example.test/?code=hidden\n`, [secret]);
    assert(!redacted.includes(secret) && !redacted.includes('unknown-token') && !redacted.includes('pwd') && !redacted.includes('hidden'));
    assert(Buffer.byteLength(redactBoundedOutput('Long line\n'.repeat(10_000), [], 128)) < 256);
    const repo = path.join(root, 'repo'); await fs.mkdir(repo); await fs.mkdir(path.join(repo, 'app'));
    await fs.writeFile(path.join(repo, 'app/page.tsx'), 'export default function Page() { return null; }');
    execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['add', 'app/page.tsx'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Guard fixture', '-c', 'user.email=guard@example.test', 'commit', '-qm', 'Synthetic build fixture'], { cwd: repo });
    await fs.mkdir(path.join(repo, '.next')); await fs.writeFile(path.join(repo, '.next/BUILD_ID'), 'synthetic-build');
    await fs.writeFile(path.join(repo, '.next/runtime.js'), 'compiled fixture');
    const dependency = path.join(repo, 'node_modules/guard-package');
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'guard-package' }));
    await fs.writeFile(path.join(dependency, 'index.cjs'), 'physical dependency fixture');
    await fs.writeFile(path.join(dependency, 'runtime.node'), 'physical binary fixture');
    await fs.writeFile(path.join(repo, '.next/runtime.mjs'), 'compiled module fixture');
    await fs.mkdir(path.join(repo, '.next/node_modules'));
    const alias = path.join(repo, '.next/node_modules/guard-package-0123456789abcdef');
    await fs.symlink(path.relative(path.dirname(alias), dependency), alias);
    const source = await sourceFingerprint(repo), built = await buildFingerprint(repo);
    await writePrivateJson(path.join(repo, '.next', buildProofName), { version: 1, repo, head: source.head, sourceFingerprint: source.fingerprint,
      buildId: built.buildId, buildFingerprint: built.fingerprint, createdAt: new Date().toISOString() }, true);
    await assertBuildProof(repo);
    await fs.writeFile(path.join(repo, '.next/runtime.js'), 'stale compiled fixture'); await assert.rejects(assertBuildProof(repo));
    await fs.writeFile(path.join(repo, '.next/runtime.js'), 'compiled fixture');
    for (const [filename, original] of [[path.join(repo, '.next/runtime.mjs'), 'compiled module fixture'],
      [path.join(dependency, 'index.cjs'), 'physical dependency fixture'], [path.join(dependency, 'runtime.node'), 'physical binary fixture']]) {
      await fs.writeFile(filename, 'changed executable bytes'); await assert.rejects(assertBuildProof(repo));
      await fs.writeFile(filename, original); await assertBuildProof(repo);
    }
    await fs.unlink(alias); await fs.symlink(path.relative(path.dirname(alias), root), alias);
    await assert.rejects(buildFingerprint(repo)); await fs.unlink(alias);
    await fs.symlink(path.relative(path.dirname(alias), dependency), alias);
    const unexpected = path.join(repo, '.next/unexpected-link'); await fs.symlink(dependency, unexpected);
    await assert.rejects(buildFingerprint(repo)); await fs.unlink(unexpected);
    const moved = `${dependency}-physical`; await fs.rename(dependency, moved); await fs.symlink(moved, dependency);
    await assert.rejects(buildFingerprint(repo)); await fs.unlink(dependency); await fs.rename(moved, dependency);
    const internal = path.join(dependency, 'internal-link'); await fs.symlink('index.cjs', internal);
    await assert.rejects(buildFingerprint(repo)); await fs.unlink(internal);
    await assertBuildProof(repo);
    await fs.writeFile(path.join(repo, 'app/page.tsx'), 'changed source'); await assert.rejects(assertBuildProof(repo));
    const processLog = path.join(root, 'owned-process.log');
    const held = await child(repo, process.execPath, ['-e', 'process.stdout.write(process.env.GUARD_TOKEN + "\\n"); setInterval(() => {}, 1000);'],
      { PATH: process.env.PATH, NODE_ENV: 'test', GUARD_TOKEN: secret }, processLog);
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      await assert.rejects(signalOwnChild({ ...held, pid: process.pid }), /fence/u);
      await assert.rejects(signalOwnChild({ ...held, started: 'foreign start' }), /fence/u);
      await assert.rejects(signalOwnChild({ ...held, cwd: root }));
    } finally { await signalOwnChild(held); }
    assert(held.ended && ownedGroupEmpty(held));
    const output = (await privateBytes(processLog)).toString(); assert(output.includes('[redacted]') && !output.includes(secret));
    console.log('Owned Yjs QA guards passed: no PG/server/browser started; OID/marker, source/build drift, private files, foreign ports, held child/process-group fences and bounded redaction.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
