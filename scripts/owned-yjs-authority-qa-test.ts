import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBuildProof, assertCompletedYjsBrowserGate, assertDatabaseOwnership, assertOrigin, assertOwnedRoot, buildFingerprint,
  buildProofName, privateBytes, redactBoundedOutput, sourceFingerprint, writePrivateJson, type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';

async function main() {
  const { runOwnedYjsAcceptance, runOwnedYjsIntegrationAcceptance, child, signalOwnChild, ownedGroupEmpty } = await import('./run-yjs-authority-e2e');
  const priorOptIn = process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
  delete process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
  try {
    const complete = { version: 1 as const, status: 'passed', declared: 2, passed: 2, failed: 0, skipped: 0, timedOut: 0, interrupted: 0 };
    assertCompletedYjsBrowserGate(complete);
    for (const patch of [{ declared: 0, passed: 0 }, { passed: 0, skipped: 2 }, { passed: 1 }, { failed: 1 }, { status: 'failed' }, { declared: NaN }]) {
      assert.throws(() => assertCompletedYjsBrowserGate({ ...complete, ...patch }));
    }
    await assert.rejects(runOwnedYjsAcceptance('/does-not-exist', [], 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)), /explicitly coordinate/u);
    await assert.rejects(runOwnedYjsIntegrationAcceptance('/does-not-exist', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)), /explicitly coordinate/u);
  } finally {
    if (priorOptIn === undefined) delete process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
    else process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START = priorOptIn;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-yjs-guard-contract-')));
  await fs.chmod(root, 0o700);
  try {
    // Genuine fixed API, valid opt-in/bindings, and exclusively own source files.
    // Missing .next deliberately prevents any later build/CP/DB bootstrap even
    // if an input rejection regresses; exact errors still distinguish that bug.
    const httpRepo = path.join(root, 'http-input-repo'); await fs.mkdir(httpRepo, { mode: 0o700 });
    await fs.mkdir(path.join(httpRepo, 'scripts'), { mode: 0o700 });
    const httpPackage = path.join(httpRepo, 'package.json'), httpScript = path.join(httpRepo, 'scripts/integration-test.mjs');
    const validHttpPackage = JSON.stringify({ scripts: { 'test:integration': 'node scripts/integration-test.mjs' } });
    const validHttpScript = "throw new Error('This guard fixture script must never execute.');\n";
    await fs.writeFile(httpPackage, validHttpPackage, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(httpScript, validHttpScript, { mode: 0o600, flag: 'wx' });
    const httpPriorOptIn = process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
    process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START = '1';
    try {
      await fs.writeFile(httpPackage, JSON.stringify({ scripts: { 'test:integration': 'node another-script.mjs' } }));
      await assert.rejects(runOwnedYjsIntegrationAcceptance(httpRepo, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)),
        /permits only the fixed HTTP integration script/u);
      await fs.writeFile(httpPackage, validHttpPackage);
      const linkedHttpTarget = path.join(httpRepo, 'owned-script-target.mjs');
      await fs.writeFile(linkedHttpTarget, validHttpScript, { mode: 0o600, flag: 'wx' });
      await fs.unlink(httpScript); await fs.symlink(linkedHttpTarget, httpScript);
      await assert.rejects(runOwnedYjsIntegrationAcceptance(httpRepo, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)),
        error => (error as NodeJS.ErrnoException).code === 'ELOOP');
      await fs.unlink(httpScript); await fs.writeFile(httpScript, Buffer.alloc(128 * 1024 + 1, 0x20), { mode: 0o600, flag: 'wx' });
      await assert.rejects(runOwnedYjsIntegrationAcceptance(httpRepo, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64)),
        error => error instanceof assert.AssertionError);
      await fs.writeFile(httpScript, validHttpScript);
      await assert.rejects(fs.lstat(path.join(httpRepo, '.next')), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
      if (httpPriorOptIn === undefined) delete process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START;
      else process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START = httpPriorOptIn;
    }
    // Main intentionally redacts errors. Observe only attempts to open its two
    // concrete own input paths, not module-loader reads or application APIs.
    const projectRepo = await fs.realpath(process.cwd());
    const cliEntry = path.join(httpRepo, 'scripts/run-yjs-authority-e2e.ts');
    await fs.symlink(path.join(projectRepo, 'scripts/run-yjs-authority-e2e.ts'), cliEntry);
    const cliPreload = path.join(root, 'http-cli-input-observer.mjs');
    await fs.writeFile(cliPreload, `import fs from 'node:fs/promises';
import path from 'node:path';
const files = new Set(['package.json', 'scripts/integration-test.mjs'].map(value => path.join(process.env.OWNED_HTTP_GUARD_REPO, value)));
const original = fs.open;
fs.open = async function(filename, ...args) {
  if (typeof filename === 'string' && files.has(filename)) {
    process.stdout.write('OWNED_HTTP_CAPTURE_REACHED\\n');
    throw Object.assign(new Error('Own guard input boundary reached.'), { code: 'OWNED_HTTP_GUARD_INPUT' });
  }
  return original.call(this, filename, ...args);
};
`, { mode: 0o600, flag: 'wx' });
    const tsxLoader = createRequire(path.join(projectRepo, 'package.json')).resolve('tsx');
    const cliBindings = ['--control-plane-head', 'a'.repeat(40), '--notebook-head', 'b'.repeat(40), '--source-fingerprint', 'c'.repeat(64)];
    const cliCases = [
      { name: 'valid arguments reach the actual input capture', args: cliBindings, captureExpected: true },
      { name: 'integration forbids a browser spec', args: [...cliBindings, '--spec', 'tests/never-run.spec.ts'], captureExpected: false },
      { name: 'unknown option', args: [...cliBindings, '--unknown-integration-option', 'value'], captureExpected: false },
      { name: 'duplicate CP binding', args: [...cliBindings, '--control-plane-head', 'd'.repeat(40)], captureExpected: false },
      { name: 'duplicate Notebook binding', args: [...cliBindings, '--notebook-head', 'd'.repeat(40)], captureExpected: false },
      { name: 'duplicate source binding', args: [...cliBindings, '--source-fingerprint', 'd'.repeat(64)], captureExpected: false },
      { name: 'missing option value', args: [...cliBindings, '--notebook-head'], captureExpected: false },
    ];
    for (const fixture of cliCases) {
      assert.throws(() => execFileSync(process.execPath, ['--conditions=react-server', '--import', tsxLoader,
        '--import', cliPreload, cliEntry, 'integration', ...fixture.args], { cwd: httpRepo,
        env: { PATH: process.env.PATH, HOME: httpRepo, TMPDIR: httpRepo, NODE_ENV: 'test',
          CANVAS_YJS_AUTHORITY_RUNTIME_START: '1', OWNED_HTTP_GUARD_REPO: httpRepo },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 64 * 1024 }), error => {
        const outcome = error as { status: number | null; signal: string | null; stdout: Buffer; stderr: Buffer };
        assert.equal(outcome.status, 1, fixture.name); assert.equal(outcome.signal, null, fixture.name);
        assert.equal(outcome.stdout.toString('utf8').includes('OWNED_HTTP_CAPTURE_REACHED'), fixture.captureExpected, fixture.name);
        assert.match(outcome.stderr.toString('utf8'), /Owned Yjs QA did not complete/u, fixture.name);
        return true;
      });
    }
    assert.equal(await fs.readFile(httpPackage, 'utf8'), validHttpPackage);
    assert.equal(await fs.readFile(httpScript, 'utf8'), validHttpScript);
    await assert.rejects(fs.lstat(path.join(httpRepo, '.next')), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
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
