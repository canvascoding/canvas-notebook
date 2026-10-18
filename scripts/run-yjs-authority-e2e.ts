/** Owned production-host QA. This file never manages Docker/container lifecycle. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { activateOwnedYjsTeam, readOwnedYjsIssuer } from './helpers/yjs-authority-team-activation';
import { assertBuildProof, assertCompletedYjsBrowserGate, assertDatabaseOwnership, assertOrigin, assertOwnedRoot, buildFingerprint, buildProofName,
  privateBytes, redactBoundedOutput, sourceFingerprint, writePrivateJson, type DatabaseIdentity, type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';

type OwnedChild = { process: ChildProcess; pid: number; started: string; cwd: string; ended: boolean; closed: Promise<void>; logPath: string };
const defaults = ['tests/editor-create-paste-import.spec.ts', 'tests/editor-focus-width.spec.ts',
  'tests/editor-markdown-insertion.spec.ts', 'tests/editor-guest-collaboration.spec.ts', 'tests/editor-yjs-owned-restart.spec.ts'];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const allowedEnv = () => Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
const processStart = (pid: number) => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
const secretValues = (env: NodeJS.ProcessEnv) => Object.entries(env).filter(([key, value]) => value && /PASSWORD|SECRET|TOKEN|DATABASE_URL|EMAIL/u.test(key)).map(([, value]) => value!);

async function child(repo: string, command: string, args: string[], env: NodeJS.ProcessEnv, logPath: string): Promise<OwnedChild> {
  const process = spawn(command, args, { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  process.once('error', () => {}); // A failed spawn must not escape the supervisor's failure receipt.
  assert(process.pid && process.pid > 0);
  let chunks: Buffer[] = [], bytes = 0, truncated = false;
  const capture = (chunk: Buffer) => {
    if (bytes + chunk.length <= 2 * 1024 * 1024) { chunks.push(chunk); bytes += chunk.length; }
    else truncated = true;
  };
  process.stdout?.on('data', capture); process.stderr?.on('data', capture);
  const entry: OwnedChild = { process, pid: process.pid, started: '', cwd: repo, ended: false, logPath, closed: Promise.resolve() };
  entry.closed = new Promise<void>(resolve => {
    process.once('error', () => { entry.ended = true; resolve(); });
    process.once('close', () => { entry.ended = true; resolve(); });
  }).then(async () => {
    let output = Buffer.concat(chunks).toString('utf8'); chunks = [];
    if (truncated) output = output.slice(0, Math.max(0, output.lastIndexOf('\n'))) + '\n[child output capture bounded]\n';
    await fs.writeFile(logPath, redactBoundedOutput(output, secretValues(env)), { mode: 0o600, flag: 'wx' });
  });
  for (let attempt = 0; attempt < 40 && !entry.ended; attempt += 1) {
    try { entry.started = processStart(entry.pid); if (entry.started) break; } catch { /* Child start is bounded. */ }
    await delay(25);
  }
  return entry;
}

async function waitChild(entry: OwnedChild, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    await Promise.race([entry.closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned child deadline exceeded.')), timeoutMs);
      cancel = () => reject(new Error('Owned run cancellation requested.')); signal?.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { if (timer) clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
}

function ownedGroupEmpty(entry: OwnedChild): boolean {
  const rows = execFileSync('ps', ['-axo', 'pid=,pgid=,uid='], { encoding: 'utf8' }).trim().split('\n');
  return !rows.some(line => { const values = line.trim().split(/\s+/u).map(Number); return values[1] === entry.pid; });
}

async function signalOwnChild(entry: OwnedChild, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
  if (entry.ended) { await entry.closed; assert(ownedGroupEmpty(entry), 'A child group still exists; preserve its ownership lock.'); return; }
  assert(entry.process.pid === entry.pid && entry.started && processStart(entry.pid) === entry.started, 'Owned PID/start-time fence failed.');
  assert.equal(execFileSync('ps', ['-p', String(entry.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim(), String(entry.pid));
  assert(execFileSync('lsof', ['-a', '-p', String(entry.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').includes(`n${entry.cwd}`));
  process.kill(-entry.pid, signal); // Only the detached group created and still led by this exact held child.
  await waitChild(entry, 15_000);
  for (let attempt = 0; attempt < 40 && !ownedGroupEmpty(entry); attempt += 1) await delay(100);
  assert(entry.ended && ownedGroupEmpty(entry), 'Owned process-group shutdown remains unconfirmed.');
}

async function reservePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address(); assert(address && typeof address === 'object');
  const port = address.port; assertOrigin(`http://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function writeEnv(file: string, env: NodeJS.ProcessEnv): Promise<void> {
  await privateBytes(file);
  const temp = `${file}.writing`;
  await fs.writeFile(temp, Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}

export async function buildOwnedYjsArtifact(repo: string, testControl?: Readonly<{ timeoutMs: number }>): Promise<void> {
  // Aggregate allowance for compile (25m), typegen/tsc (30m), generate (25m)
  // and 10m overhead. This fixed ceiling is not a proven worst-case duration.
  const BUILD_AGGREGATE_BUDGET_MS = 90 * 60_000;
  let timeoutMs = BUILD_AGGREGATE_BUDGET_MS;
  if (testControl !== undefined) {
    assert(testControl && typeof testControl === 'object' && Object.getPrototypeOf(testControl) === Object.prototype
      && Reflect.ownKeys(testControl).length === 1, 'Invalid narrower build test control.');
    const descriptor = Object.getOwnPropertyDescriptor(testControl, 'timeoutMs');
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'number'
      && Number.isSafeInteger(descriptor.value) && descriptor.value >= 1 && descriptor.value <= BUILD_AGGREGATE_BUDGET_MS,
    'The build test timeout must be an integer between 1 and the fixed 90-minute ceiling.');
    timeoutMs = descriptor.value;
  }
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let build: OwnedChild | undefined;
  try {
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'app', 'components', 'server', 'scripts', 'tests',
      'packages', 'i18n', 'messages', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'server.js'],
    { cwd: repo, encoding: 'utf8' }).trim(), '', 'Commit the fully integrated application/test sources before sealing their production build.');
    const before = await sourceFingerprint(repo);
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-yjs-build-'))); await fs.chmod(root, 0o700);
    const env: NodeJS.ProcessEnv = { ...allowedEnv(), NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
      CANVAS_APP_ROOT: repo, DATA: path.join(root, 'data'), CANVAS_DATA_ROOT: path.join(root, 'data'), TMPDIR: root,
      CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external', CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true',
      // The build cannot contact or mutate the shared database, even if a module probes it.
      DATABASE_URL: `postgresql://build:${randomBytes(24).toString('hex')}@127.0.0.1:9/canvas_yjs_build`,
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_DEPLOYMENT_MODE: 'community', CANVAS_TEAM_FEATURES_ENABLED: 'false',
      BASE_URL: 'http://127.0.0.1:42345', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:42345',
      BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), NODE_OPTIONS: '--max-old-space-size=8192' };
    await fs.mkdir(env.DATA!, { mode: 0o700 });
    const envPath = path.join(root, 'build.env'); await fs.writeFile(envPath, '', { mode: 0o600, flag: 'wx' }); env.CANVAS_ENV_FILE = envPath;
    await writeEnv(envPath, env);
    cancellation.signal.throwIfAborted();
    console.log(`[yjs-qa] production build; private redacted evidence ${root}`);
    build = await child(repo, 'npm', ['run', 'build'], env, path.join(root, 'build.log'));
    await waitChild(build, timeoutMs, cancellation.signal);
    cancellation.signal.throwIfAborted();
    assert.equal(build.process.exitCode, 0, 'Production build failed; no build proof was published.');
    const after = await sourceFingerprint(repo); assert.deepEqual(after, before, 'Sources changed during the production build.');
    cancellation.signal.throwIfAborted();
    const built = await buildFingerprint(repo);
    cancellation.signal.throwIfAborted();
    const proofPath = path.join(repo, '.next', buildProofName);
    try { await privateBytes(proofPath); await fs.unlink(proofPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    cancellation.signal.throwIfAborted();
    await writePrivateJson(proofPath, { version: 1, repo, head: after.head, sourceFingerprint: after.fingerprint,
      buildFingerprint: built.fingerprint, buildId: built.buildId, createdAt: new Date().toISOString() }, true);
    cancellation.signal.throwIfAborted();
    console.log(`[yjs-qa] build sealed at ${after.head}; runtime remains stopped`);
  } catch (error) {
    if (build) try { await signalOwnChild(build); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Owned build failed and its process-group shutdown could not be confirmed.'); }
    throw error;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

async function ownJson(origin: string, route: string, body?: unknown, cookie?: string) {
  const target = new URL(route, origin); assert.equal(target.origin, origin);
  const response = await fetch(target, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(30_000), headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert(Buffer.byteLength(text) <= 256 * 1024);
  assert(response.ok, `Owned fixture route returned HTTP ${response.status}.`);
  return { value: JSON.parse(text), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}

async function createRealUsers(origin: string, env: NodeJS.ProcessEnv): Promise<void> {
  const owner = await ownJson(origin, '/api/auth/sign-in/email', { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD });
  assert(owner.cookie && owner.value.user?.id);
  const created = await ownJson(origin, '/api/admin/organization/memberships', { name: 'Yjs QA peer', email: env.TEST_SECONDARY_EMAIL, role: 'member' }, owner.cookie);
  assert(created.value.data?.membershipId);
  await ownJson(origin, `/api/admin/organization/memberships/${encodeURIComponent(created.value.data.membershipId)}/activate`,
    { password: env.TEST_SECONDARY_PASSWORD }, owner.cookie);
  const peer = await ownJson(origin, '/api/auth/sign-in/email', { email: env.TEST_SECONDARY_EMAIL, password: env.TEST_SECONDARY_PASSWORD });
  assert(peer.cookie && peer.value.user?.id && peer.value.user.id !== owner.value.user.id);
  const permissionRoute = `/api/admin/organization/users/${encodeURIComponent(peer.value.user.id)}/permissions`;
  const permissions = await ownJson(origin, permissionRoute, undefined, owner.cookie);
  if (!permissions.value.user?.permissions?.canWriteTeamWorkspace) {
    const response = await fetch(new URL(permissionRoute, origin), { method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: owner.cookie }, body: JSON.stringify({ canWriteTeamWorkspace: true }) });
    assert(response.ok);
  }
  const shared = await ownJson(origin, '/api/workspaces', { type: 'organization', name: 'Shared Test Workspace', description: 'Owned Yjs acceptance fixture' }, owner.cookie);
  assert(shared.value.workspace?.id);
  const peerAgain = await ownJson(origin, '/api/auth/sign-in/email', { email: env.TEST_SECONDARY_EMAIL, password: env.TEST_SECONDARY_PASSWORD });
  const workspaces = await ownJson(origin, '/api/workspaces', undefined, peerAgain.cookie);
  assert(workspaces.value.workspaces.some((entry: { id: string; permissions?: { canWrite: boolean } }) => entry.id === shared.value.workspace.id && entry.permissions?.canWrite));
  const review = await fetch(new URL('/api/admin/experimental-settings', origin), { method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: owner.cookie }, body: JSON.stringify({ documentReviewEnabled: false }) });
  assert(review.ok);
  assert.equal((await review.json()).data.documentReviewEnabled, false);
  const settings = await ownJson(origin, '/api/server-settings', undefined, owner.cookie);
  assert.equal(settings.value.data.documentReviewEnabled, false, 'Review must be disabled before the first acceptance file operation.');
}

export async function runOwnedYjsAcceptance(repo: string, specs: string[], expectedCpHead: string,
  expectedNotebookHead: string, expectedSourceFingerprint: string): Promise<void> {
  assert.equal(process.env.CANVAS_YJS_AUTHORITY_RUNTIME_START, '1', 'Root must explicitly coordinate the integrated runtime start.');
  assert.match(expectedCpHead, /^[a-f0-9]{40}$/u);
  assert.match(expectedNotebookHead, /^[a-f0-9]{40}$/u); assert.match(expectedSourceFingerprint, /^[a-f0-9]{64}$/u);
  const nativeMcpSpec = 'tests/direct-mcp-native-create-import.spec.ts';
  const nativeMcpAcceptance = specs.includes(nativeMcpSpec);
  if (nativeMcpAcceptance) assert.deepEqual(specs, [nativeMcpSpec], 'The MCP settings/shadow fixture must run as its sole selected spec.');
  const proof = await assertBuildProof(repo);
  assert.equal(proof.head, expectedNotebookHead, 'The explicitly selected integrated Notebook commit differs from the sealed build.');
  assert.equal(proof.sourceFingerprint, expectedSourceFingerprint, 'The explicitly selected integrated source snapshot differs from the sealed build.');
  for (const spec of specs) {
    assert(/^tests\/[a-zA-Z0-9/_-]+\.spec\.ts$/u.test(spec));
    const file = path.join(repo, spec); assert.equal(await fs.realpath(file), file); assert((await fs.lstat(file)).isFile());
  }
  const cpRoot = await fs.realpath(path.join(repo, '..', 'canvas-control-plane'));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cpRoot, encoding: 'utf8' }).trim(), expectedCpHead);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: cpRoot, encoding: 'utf8' }).trim(), '');
  assert.equal(JSON.parse(await fs.readFile(path.join(cpRoot, 'apps/api/package.json'), 'utf8')).name, '@canvas-control-plane/api');
  await fs.access(path.join(cpRoot, 'node_modules/better-auth/dist/db/get-migration.mjs'));
  const managed = parse(await privateBytes(path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env')));
  assert(managed.BOOTSTRAP_ADMIN_EMAIL && managed.BOOTSTRAP_ADMIN_PASSWORD);
  const maintenance = new URL(managed.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(maintenance.protocol) && maintenance.hostname === '127.0.0.1' && maintenance.port === '55433'
    && maintenance.pathname === '/canvas_notebook' && !maintenance.search && !maintenance.hash);
  maintenance.pathname = '/postgres';
  const containers = execFileSync('docker', ['ps', '--filter', 'label=io.canvas.local-prod=true', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n');
  assert(containers.includes('canvas-local-prod-postgres') && containers.filter(name => name === 'canvas-local-prod-notebook').length === 1);
  assert(containers.every(name => ['canvas-local-prod-postgres', 'canvas-local-prod-notebook', 'canvas-local-prod-control-plane-api', 'canvas-local-prod-control-plane-web'].includes(name)));
  const lock = path.join(os.homedir(), '.local/state/canvas-local-team-seat/yjs-authority-run.lock');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-yjs-authority-'))); await fs.chmod(root, 0o700);
  const nonce = randomBytes(16).toString('hex'), marker = randomBytes(24).toString('hex'), port = await reservePort();
  const dataRoot = path.join(root, 'data'), tmpRoot = path.join(root, 'tmp'), results = path.join(root, 'results');
  for (const directory of [dataRoot, tmpRoot, results]) await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600, flag: 'wx' });
  const rootStat = await fs.lstat(root), dataStat = await fs.lstat(dataRoot);
  const receiptPath = path.join(root, 'recovery.json'), envPath = path.join(root, 'runtime.env');
  await fs.writeFile(envPath, '', { mode: 0o600, flag: 'wx' });
  const receipt: OwnedYjsReceipt = { version: 1, nonce, fixtureRoot: root, repo, head: proof.head, buildId: proof.buildId,
    sourceFingerprint: proof.sourceFingerprint, buildFingerprint: proof.buildFingerprint, ownerMarker: marker,
    rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), dataRoot, dataDevice: String(dataStat.dev), dataInode: String(dataStat.ino),
    databaseName: `canvas_yjs_e2e_${nonce}`, databaseOid: null, databaseOwner: null, createAcknowledged: false, phase: 'before_create', actorId: null,
    uncertain: false, parentPid: process.pid, parentStart: processStart(process.pid), serverPid: null, serverStart: null, issuerPid: null,
    issuerDatabaseOid: null, issuerDatabaseOwner: null, issuerDatabaseMarker: null, restartCount: 0, port,
    databaseDropped: false, dataRemoved: false, controlPlaneRoot: cpRoot, controlPlaneHead: expectedCpHead, passed: false,
    selectedSpecs: [...specs], completedSpecs: [], activeSpec: null, failurePhase: null };
  await writePrivateJson(receiptPath, receipt, true);
  const runtimeUrl = new URL(maintenance); runtimeUrl.pathname = `/${receipt.databaseName}`;
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...allowedEnv(), NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    CANVAS_ENV_FILE: envPath, CANVAS_APP_ROOT: repo, DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, TMPDIR: tmpRoot,
    DATABASE_URL: runtimeUrl.href, CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external', CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'false',
    HOSTNAME: '127.0.0.1', PORT: String(port), BASE_URL: origin, BETTER_AUTH_BASE_URL: origin,
    BOOTSTRAP_ADMIN_NAME: 'Owned Yjs QA owner', BOOTSTRAP_ADMIN_EMAIL: managed.BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD: managed.BOOTSTRAP_ADMIN_PASSWORD,
    TEST_LOGIN_EMAIL: managed.BOOTSTRAP_ADMIN_EMAIL, TEST_LOGIN_PASSWORD: managed.BOOTSTRAP_ADMIN_PASSWORD,
    TEST_SECONDARY_EMAIL: `yjs-peer-${nonce}@example.test`, TEST_SECONDARY_PASSWORD: randomBytes(24).toString('base64url'),
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'),
    CANVAS_INSTANCE_ID: `agent-settings-browser-${nonce}`, CANVAS_ORGANIZATION_ID: randomUUID(), CANVAS_DEPLOYMENT_MODE: 'community', CANVAS_TEAM_FEATURES_ENABLED: 'false',
    CANVAS_TEAM_LICENSE_REFRESH_ENABLED: 'false', CANVAS_TEAM_LICENSE_LIFECYCLE_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', QMD_ENABLED: 'false',
    ...(nativeMcpAcceptance ? { CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'settings', FILE_VERSION_CENTER_MODE: 'shadow' } : {}),
    ONBOARDING: 'false', ONBOARDING_HINTS: 'false', COLLABORATION_E2E: '1', E2E_EXTERNAL_SERVER: '1', CANVAS_YJS_AUTHORITY_E2E: '1',
    CANVAS_YJS_QA_RECEIPT: receiptPath, CANVAS_YJS_QA_RESULTS: results, CANVAS_YJS_QA_NONCE: nonce,
    CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1', AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: receiptPath,
    CANVAS_CONTROL_PLANE_TEST_ROOT: cpRoot, CANVAS_ISSUER_MAINTENANCE_DATABASE_URL: maintenance.href,
    CANVAS_POSTGRES_VECTOR_ENABLED: 'true', CANVAS_VECTOR_PROVIDER: 'pgvector', NODE_OPTIONS: '--max-old-space-size=4096' };
  await writeEnv(envPath, env);
  await fs.mkdir(lock, { mode: 0o700 }); // Existing/uncertain owners are preserved, never adopted.
  const lockStat = await fs.lstat(lock);
  try {
    await writePrivateJson(path.join(lock, 'owner.json'), { nonce, root, parentPid: process.pid, rootDevice: receipt.rootDevice, rootInode: receipt.rootInode }, true);
  } catch (error) {
    const current = await fs.lstat(lock); assert.equal(current.dev, lockStat.dev); assert.equal(current.ino, lockStat.ino);
    if (!(await fs.readdir(lock)).length) await fs.rmdir(lock);
    throw error;
  }
  const administration = new Pool({ connectionString: maintenance.href, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 30_000 });
  let database: Pool | undefined, server: OwnedChild | undefined, issuer: OwnedChild | undefined, browser: OwnedChild | undefined;
  let control: http.Server | undefined, stopRequested = false, applicationLoaded = false;
  let finishRestart: (() => void) | undefined, activeRestart: Promise<void> = Promise.resolve();
  const cancellation = new AbortController();
  const persist = () => writePrivateJson(receiptPath, receipt);
  const stop = () => { stopRequested = true; receipt.uncertain = true; cancellation.abort(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const assertLiveDatabase = async () => {
    const identity = (await administration.query(`SELECT datname AS name,oid::text,pg_get_userbyid(datdba) AS owner,current_user AS role,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [receipt.databaseName])).rows[0] as DatabaseIdentity;
    assertDatabaseOwnership(receipt, identity);
  };
  const assertIssuerDatabase = async (capture = false) => {
    const issued = JSON.parse((await privateBytes(path.join(root, 'issuer-recovery.json'))).toString());
    assert(issuer && issued.createAcknowledged && !issued.uncertain && issued.phase === 'ready');
    assert.equal(issued.processId, issuer.pid); assert.equal(issued.nonce, nonce); assert.equal(issued.fixtureRoot, root);
    assert.equal(issued.controlPlaneRoot, cpRoot); assert.equal(issued.databaseName, `canvas_workflow_issuer_${nonce}`);
    const identity = (await administration.query(`SELECT datname AS name,oid::text,pg_get_userbyid(datdba) AS owner,current_user AS role,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [issued.databaseName])).rows[0] as DatabaseIdentity;
    assert(identity && identity.owner === identity.role && identity.owner === issued.databaseOwner && identity.marker === issued.ownerMarker);
    if (capture) { receipt.issuerDatabaseOid = identity.oid; receipt.issuerDatabaseOwner = identity.owner; receipt.issuerDatabaseMarker = identity.marker; await persist(); }
    else {
      assert.equal(identity.oid, receipt.issuerDatabaseOid); assert.equal(identity.owner, receipt.issuerDatabaseOwner); assert.equal(identity.marker, receipt.issuerDatabaseMarker);
    }
  };
  const assertOwnServer = async () => {
    assert(server && !server.ended && server.pid === receipt.serverPid && server.started === receipt.serverStart);
    assert.equal(processStart(server.pid), server.started);
    assert(execFileSync('lsof', ['-a', '-p', String(server.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').includes(`n${repo}`));
    assert(execFileSync('lsof', ['-nP', '-a', '-p', String(server.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).split('\n').includes(`n127.0.0.1:${port}`));
    await assertLiveDatabase(); await assertOwnedRoot(receipt); await assertBuildProof(repo);
  };
  const startServer = async () => {
    assert(!stopRequested); await assertOwnedRoot(receipt); await assertLiveDatabase(); await assertBuildProof(repo);
    receipt.phase = 'host_starting'; await persist(); await writeEnv(envPath, env);
    server = await child(repo, process.execPath, ['--import', 'tsx', 'server.js'], env, path.join(root, `host-${receipt.restartCount}.log`));
    receipt.serverPid = server.pid; receipt.serverStart = server.started; await persist();
    let healthy = false;
    for (let attempt = 0; attempt < 240 && !server.ended && !stopRequested; attempt += 1) {
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000), redirect: 'error' });
        const value = await response.json() as { deployment?: { mode?: string; teamFeaturesEnabled?: boolean } };
        healthy = response.ok && value.deployment?.mode === 'team' && value.deployment.teamFeaturesEnabled === true;
        if (healthy) break;
      } catch { /* Readiness is bounded; no occupied foreign listener is replaced. */ }
      await delay(500);
    }
    assert(healthy); await assertOwnServer(); receipt.phase = 'browser'; await persist();
  };
  try {
    console.log(`[yjs-qa] private fixture ${root}; foreign services preserved`);
    assert.equal((await administration.query('SHOW server_version_num')).rows[0].server_version_num.startsWith('18'), true);
    assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [receipt.databaseName])).rowCount, 0);
    receipt.databaseOwner = (await administration.query('SELECT current_user AS role')).rows[0].role;
    receipt.phase = 'create_in_flight'; await persist();
    await administration.query(`CREATE DATABASE "${receipt.databaseName}"`); receipt.createAcknowledged = true; await persist();
    await administration.query(`COMMENT ON DATABASE "${receipt.databaseName}" IS '${marker}'`);
    receipt.databaseOid = (await administration.query('SELECT oid::text FROM pg_database WHERE datname=$1', [receipt.databaseName])).rows[0].oid; await persist();
    await assertLiveDatabase();
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env); applicationLoaded = true;
    database = new Pool({ connectionString: runtimeUrl.href, max: 4, connectionTimeoutMillis: 5_000 });
    const { runPostgresMigrations } = await import('../app/lib/db/postgres'); await runPostgresMigrations(database);
    assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM "user"')).rows[0].count, 0);
    env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true'; process.env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true';
    const { createInitialOwner } = await import('../app/lib/auth-setup');
    const owner = await createInitialOwner({ name: env.BOOTSTRAP_ADMIN_NAME, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD });
    assert(owner.id); receipt.actorId = owner.id; receipt.phase = 'bootstrap'; await persist();
    issuer = await child(repo, process.execPath, ['--import', 'tsx', 'scripts/helpers/agent-workflow-team-issuer-fixture.ts'],
      { ...env, NODE_ENV: 'development' }, path.join(root, 'issuer.log'));
    receipt.issuerPid = issuer.pid; await persist();
    let ready: Awaited<ReturnType<typeof readOwnedYjsIssuer>> | undefined;
    for (let attempt = 0; attempt < 480 && !issuer.ended && !stopRequested; attempt += 1) {
      try { ready = await readOwnedYjsIssuer(receipt); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await delay(250);
    }
    assert(ready && !issuer.ended && !stopRequested); await assertIssuerDatabase(true);
    await activateOwnedYjsTeam(ready, env); await writeEnv(envPath, env);
    await startServer(); await createRealUsers(origin, env);
    const restartToken = randomBytes(48).toString('base64url'); let restarting = false;
    control = http.createServer(async (request, response) => {
      const expected = Buffer.from(`Bearer ${restartToken}`), provided = Buffer.from(request.headers.authorization ?? '');
      if (request.method !== 'POST' || request.url !== '/restart' || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        response.writeHead(403).end(); return;
      }
      if (restarting || stopRequested) { response.writeHead(409).end(); return; }
      restarting = true;
      activeRestart = new Promise(resolve => { finishRestart = resolve; });
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 1024); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { mode?: string; nonce?: string };
        assert.equal(body.nonce, nonce); assert(['graceful', 'crash'].includes(body.mode ?? ''));
        await assertOwnServer(); assert(server); receipt.phase = 'restarting'; await persist();
        await signalOwnChild(server, body.mode === 'crash' ? 'SIGKILL' : 'SIGTERM');
        receipt.serverPid = null; receipt.serverStart = null; receipt.restartCount += 1; await persist();
        await startServer(); response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, nonce, restartCount: receipt.restartCount }));
      } catch {
        receipt.uncertain = true; await persist(); response.writeHead(500).end();
      } finally { restarting = false; finishRestart?.(); }
    });
    await new Promise<void>((resolve, reject) => { control!.once('error', reject); control!.listen(0, '127.0.0.1', resolve); });
    const address = control.address(); assert(address && typeof address === 'object');
    env.CANVAS_YJS_QA_RESTART_URL = `http://127.0.0.1:${address.port}/restart`; env.CANVAS_YJS_QA_RESTART_TOKEN = restartToken;
    await writeEnv(envPath, env);
    for (const spec of specs) {
      assert(!stopRequested && !receipt.uncertain); await assertOwnServer();
      receipt.activeSpec = spec; await persist();
      console.log(`[yjs-qa] serial browser gate ${spec}`);
      const output = path.join(results, path.basename(spec, '.spec.ts')); await fs.mkdir(output, { mode: 0o700 });
      browser = await child(repo, process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright/playwright.yjs-authority.config.ts', spec],
        { ...env, CANVAS_YJS_QA_RESULTS: output, CANVAS_YJS_QA_REPORT: path.join(output, 'browser-outcome.json') }, path.join(root, `browser-${path.basename(spec)}.log`));
      await waitChild(browser, 25 * 60_000, cancellation.signal); assert.equal(browser.process.exitCode, 0, 'Selected browser gate failed; private fixture preserved.');
      assertCompletedYjsBrowserGate(JSON.parse((await privateBytes(path.join(output, 'browser-outcome.json'))).toString()));
      assert(ownedGroupEmpty(browser), 'Browser descendants remain; preserve the fixture and lock.');
      receipt.completedSpecs.push(spec); receipt.activeSpec = null; await persist();
    }
    assert(!stopRequested && !receipt.uncertain); await assertOwnServer(); receipt.passed = true;
  } catch {
    receipt.uncertain = true; receipt.failurePhase = receipt.phase;
  } finally {
    stopRequested = true;
    if (control) {
      control.closeAllConnections();
      await new Promise<void>(resolve => control!.close(() => resolve()));
    }
    await activeRestart;
    for (const entry of [browser, server]) if (entry) {
      try { await signalOwnChild(entry); } catch { receipt.uncertain = true; }
    }
    if (issuer) {
      try {
        if (receipt.passed && !receipt.uncertain) await assertIssuerDatabase();
      } catch { receipt.uncertain = true; }
      try { await signalOwnChild(issuer, receipt.passed && !receipt.uncertain ? 'SIGTERM' : 'SIGKILL'); }
      catch { receipt.uncertain = true; }
      if (receipt.passed && !receipt.uncertain) {
        try {
          const issued = JSON.parse((await privateBytes(path.join(root, 'issuer-recovery.json'))).toString());
          assert.equal(issued.phase, 'cleaned'); assert.equal(issued.databaseDropped, true); assert.equal(issued.uncertain, false);
          assert.equal(issued.processId, issuer.pid); assert.equal(issued.nonce, nonce);
        } catch { receipt.uncertain = true; }
      }
    }
    if (applicationLoaded) try { const { closeDatabaseConnections } = await import('../app/lib/db'); await closeDatabaseConnections(); } catch { receipt.uncertain = true; }
    if (database) try { await database.end(); } catch { receipt.uncertain = true; }
    try {
      await assertOwnedRoot(receipt);
      if (receipt.passed && !receipt.uncertain && receipt.createAcknowledged && [server, issuer, browser].every(entry => !entry || entry.ended && ownedGroupEmpty(entry))) {
        await assertLiveDatabase();
        assert.equal((await administration.query('SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname=$1', [receipt.databaseName])).rows[0].count, 0);
        await administration.query(`DROP DATABASE "${receipt.databaseName}"`); receipt.databaseDropped = true;
        await fs.rm(dataRoot, { recursive: true }); receipt.dataRemoved = true;
        await fs.rm(tmpRoot, { recursive: true }); receipt.phase = 'cleaned';
      } else receipt.phase = 'preserved';
    } catch { receipt.uncertain = true; receipt.phase = 'preserved'; }
    receipt.serverPid = server?.ended ? null : server?.pid ?? null; receipt.serverStart = server?.ended ? null : server?.started ?? null;
    await persist(); await administration.end();
    // A lock is released only while its captured directory and nonce still belong to this parent.
    try {
      const current = await fs.lstat(lock), owner = JSON.parse((await privateBytes(path.join(lock, 'owner.json'))).toString());
      assert.equal(current.dev, lockStat.dev); assert.equal(current.ino, lockStat.ino); assert.equal(owner.nonce, nonce); assert.equal(owner.parentPid, process.pid);
      assert([server, issuer, browser].every(entry => !entry || entry.ended && ownedGroupEmpty(entry))); await fs.unlink(path.join(lock, 'owner.json')); await fs.rmdir(lock);
    } catch { receipt.uncertain = true; await persist(); }
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
  console.log(`[yjs-qa] ${receipt.passed && !receipt.uncertain ? 'passed' : 'failed/preserved'}; receipt ${receiptPath}`);
  assert(receipt.passed && !receipt.uncertain && receipt.databaseDropped && receipt.dataRemoved, 'Owned acceptance remains unconfirmed; inspect its private receipt.');
}

async function main(): Promise<void> {
  const repo = await fs.realpath(process.cwd());
  assert(process.execArgv.some(value => value === '--conditions=react-server'), 'Use node --conditions=react-server --import tsx.');
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'build') { assert.equal(args.length, 0); await buildOwnedYjsArtifact(repo); return; }
  assert.equal(mode, 'run');
  const specs: string[] = []; let cpHead = '', notebookHead = '', fingerprint = '';
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index + 1]);
    if (args[index] === '--spec') specs.push(args[index + 1]);
    else if (args[index] === '--control-plane-head') { assert.equal(cpHead, ''); cpHead = args[index + 1]; }
    else if (args[index] === '--notebook-head') { assert.equal(notebookHead, ''); notebookHead = args[index + 1]; }
    else { assert.equal(args[index], '--source-fingerprint'); assert.equal(fingerprint, ''); fingerprint = args[index + 1]; }
  }
  assert.equal(new Set(specs).size, specs.length);
  await runOwnedYjsAcceptance(repo, specs.length ? specs : defaults, cpHead, notebookHead, fingerprint);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/run-yjs-authority-e2e.ts')) {
  void main().catch(() => { console.error('Owned Yjs QA did not complete; no foreign process/container was changed.'); process.exitCode = 1; });
}
// Narrow process-fence seams for the guard test; importing never starts main.
export { child, signalOwnChild, ownedGroupEmpty };
