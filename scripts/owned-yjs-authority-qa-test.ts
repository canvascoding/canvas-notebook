import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBuildProof, assertCompletedYjsBrowserGate, assertDatabaseOwnership, assertOrigin, assertOwnedRoot, buildFingerprint,
  buildProofName, privateBytes, redactBoundedOutput, requireOwnedYjsQaTarget, requireOwnedYjsQaRuntimeTarget,
  sourceFingerprint, writePrivateJson, type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';

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
    // Both public guard modes reject concrete invalid ownership/configuration
    // before any PostgreSQL connect. The whole existing build-drift matrix below
    // still exercises the full guard's unchanged source/artifact verification.
    const targetResults = path.join(root, 'results', 'synthetic-runtime-guard');
    await fs.mkdir(targetResults, { recursive: true, mode: 0o700 });
    const targetReceipt: OwnedYjsReceipt = { ...receipt, repo, head: source.head,
      sourceFingerprint: source.fingerprint, buildFingerprint: built.fingerprint, buildId: built.buildId,
      phase: 'browser', actorId: null, uncertain: false, parentPid: process.pid, parentStart: 'synthetic parent start',
      serverPid: process.pid, serverStart: 'synthetic server start', issuerPid: null,
      issuerDatabaseOid: null, issuerDatabaseOwner: null, issuerDatabaseMarker: null,
      restartCount: 0, port: 42345, databaseDropped: false, dataRemoved: false,
      controlPlaneRoot: path.join(root, 'synthetic-control-plane'), controlPlaneHead: 'b'.repeat(40),
      passed: false, selectedSpecs: ['tests/synthetic-never-run.spec.ts'], completedSpecs: [], activeSpec: null, failurePhase: null };
    const targetReceiptPath = path.join(root, 'recovery.json'), publishedPath = path.join(root, 'runtime.env');
    const targetEnv: NodeJS.ProcessEnv = { CANVAS_YJS_AUTHORITY_E2E: '1', E2E_EXTERNAL_SERVER: '1', NODE_ENV: 'production',
      CANVAS_YJS_QA_RECEIPT: targetReceiptPath, CANVAS_YJS_QA_RESULTS: targetResults,
      BASE_URL: 'http://127.0.0.1:42345', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:42345',
      DATABASE_URL: `postgresql://fixture-role:synthetic-password@127.0.0.1:55433/${receipt.databaseName}`,
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `synthetic-${nonce}`, CANVAS_ORGANIZATION_ID: 'synthetic-org',
      BOOTSTRAP_ADMIN_EMAIL: 'owner@guard.test', BOOTSTRAP_ADMIN_PASSWORD: 'synthetic-owner-password',
      TEST_LOGIN_EMAIL: 'owner@guard.test', TEST_LOGIN_PASSWORD: 'synthetic-owner-password',
      TEST_SECONDARY_EMAIL: 'peer@guard.test', TEST_SECONDARY_PASSWORD: 'synthetic-peer-password',
      CANVAS_YJS_QA_RESTART_URL: 'http://127.0.0.1:42346', CANVAS_YJS_QA_RESTART_TOKEN: 'synthetic-restart-token',
      CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external',
      CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true' };
    await writePrivateJson(targetReceiptPath, targetReceipt, true);
    const published = (env: NodeJS.ProcessEnv) => Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join('');
    await fs.writeFile(publishedPath, published(targetEnv), { mode: 0o600, flag: 'wx' });
    const proofPath = path.join(repo, '.next', buildProofName), proofBytes = await privateBytes(proofPath);
    const originalConnect = Client.prototype.connect;
    let connectAttempts = 0;
    Client.prototype.connect = function(): never { connectAttempts++; throw new Error('Synthetic guard must reject before PostgreSQL connect.'); };
    const targetCwd = process.cwd(); process.chdir(repo);
    try {
      for (const guard of [requireOwnedYjsQaTarget, requireOwnedYjsQaRuntimeTarget]) {
        await assert.rejects(guard({ ...targetEnv, TEST_LOGIN_PASSWORD: 'foreign-current-value' }),
          /Owned runtime configuration mismatch \(TEST_LOGIN_PASSWORD\)/u);
        await fs.writeFile(publishedPath, published({ ...targetEnv, TEST_SECONDARY_PASSWORD: 'foreign-published-value' }));
        try { await assert.rejects(guard(targetEnv), /Owned runtime configuration mismatch \(TEST_SECONDARY_PASSWORD\)/u); }
        finally { await fs.writeFile(publishedPath, published(targetEnv)); }
        const wrongDatabase = { ...targetEnv,
          DATABASE_URL: 'postgresql://fixture-role:synthetic-password@127.0.0.1:55433/canvas_notebook' };
        await fs.writeFile(publishedPath, published(wrongDatabase));
        try { await assert.rejects(guard(wrongDatabase), error => {
          assert(error instanceof assert.AssertionError); assert.equal(error.actual, '/canvas_notebook');
          assert.equal(error.expected, `/${receipt.databaseName}`); return true;
        }); } finally { await fs.writeFile(publishedPath, published(targetEnv)); }
        await writePrivateJson(targetReceiptPath, { ...targetReceipt, sourceFingerprint: 'f'.repeat(64) });
        try { await assert.rejects(guard(targetEnv), error => {
          assert(error instanceof assert.AssertionError); assert.equal(error.actual, 'f'.repeat(64));
          assert.equal(error.expected, source.fingerprint); return true;
        }); } finally { await writePrivateJson(targetReceiptPath, targetReceipt); }
        await writePrivateJson(proofPath, { ...JSON.parse(proofBytes.toString()), buildId: 'foreign-build-id' });
        try { await assert.rejects(guard(targetEnv), error => {
          assert(error instanceof assert.AssertionError); assert.equal(error.actual, 'foreign-build-id');
          assert.equal(error.expected, built.buildId); return true;
        }); } finally { await fs.writeFile(proofPath, proofBytes); }
        await fs.writeFile(path.join(root, '.fixture-owner'), 'a'.repeat(48));
        try { await assert.rejects(guard(targetEnv), error => {
          assert(error instanceof assert.AssertionError); assert.equal(error.actual, 'a'.repeat(48));
          assert.equal(error.expected, marker); return true;
        }); } finally { await fs.writeFile(path.join(root, '.fixture-owner'), marker); }
        assert.equal(connectAttempts, 0, 'Every invalid binding must reject before even a mocked connect.');
      }
    } finally {
      process.chdir(targetCwd); Client.prototype.connect = originalConnect;
      await fs.writeFile(publishedPath, published(targetEnv)); await writePrivateJson(targetReceiptPath, targetReceipt);
      await fs.writeFile(proofPath, proofBytes); await fs.writeFile(path.join(root, '.fixture-owner'), marker);
    }
    assert.equal(await fs.readFile(publishedPath, 'utf8'), published(targetEnv));
    assert((await privateBytes(proofPath)).equals(proofBytes));
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
