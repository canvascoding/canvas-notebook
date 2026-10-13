import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import type { ReplaySnapshotLineageProof } from './composio-live-model-replay-proof';

// A complete owned snapshot retains actual provider identities and encrypted
// credentials. No provider binding, license, user or membership is invented.
type SourceReceipt = { version: number; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; databaseOwner: string;
  phase: string; createAcknowledged: boolean; uncertain: boolean; actorId: string;
  directoryProofs: Record<string, { device: string; inode: string }> };
type Runtime = { masterKey: string; authSecret: string; organizationId: string; instanceId: string;
  databaseName: string; dataRoot: string; tmpRoot: string; baseUrl: string };
type Child = { process: ReturnType<typeof spawn>; pid: number; closed: Promise<number | null>; ended: boolean };
type Ready = { nonce: string; fixtureRoot: string; origin: string; certificatePath: string; initialPublicKey: string;
  initialPublicKeyFingerprint: string; testPublicKey: string; testPublicKeyFingerprint: string; licenseId: string; instanceId: string; controlSecret: string };

async function ownedJson<T>(file: string): Promise<T> {
  assert(path.isAbsolute(file) && await fs.realpath(file) === file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 65536);
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally { await handle.close(); }
}

async function assertPrivateTree(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name), stat = await fs.lstat(file);
    assert(!stat.isSymbolicLink() && stat.uid === process.getuid?.());
    assert(stat.isDirectory() || stat.isFile(), 'Only regular owned snapshot data is supported.');
    if (stat.isDirectory()) await assertPrivateTree(file);
    else assert.equal(stat.nlink, 1);
  }
}

async function resumeComposioLiveModelFixture(): Promise<void> {
  assert.equal(process.argv.length, 4);
  const repo = await fs.realpath(process.cwd()), runtimeFile = process.argv[2], modelInputPath = process.argv[3];
  assert.equal(path.basename(runtimeFile), 'live-runtime-input.json');
  const sourceRoot = path.dirname(runtimeFile), source = await ownedJson<SourceReceipt>(path.join(sourceRoot, 'recovery.json'));
  const runtime = await ownedJson<Runtime>(runtimeFile);
  const sourceStat = await fs.lstat(sourceRoot);
  assert(sourceStat.isDirectory() && !sourceStat.isSymbolicLink() && sourceStat.uid === process.getuid?.() && (sourceStat.mode & 0o777) === 0o700);
  assert.equal(source.fixtureRoot, sourceRoot); assert.equal(source.repo, repo);
  assert.equal(source.rootDevice, String(sourceStat.dev)); assert.equal(source.rootInode, String(sourceStat.ino));
  assert.equal(source.phase, 'live_verified_preserved'); assert.equal(source.createAcknowledged, true); assert.equal(source.uncertain, false);
  const sourceMarkerHandle = await fs.open(path.join(sourceRoot, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const markerStat = await sourceMarkerHandle.stat(); assert(markerStat.isFile() && markerStat.nlink === 1 && markerStat.uid === sourceStat.uid && (markerStat.mode & 0o777) === 0o600);
    assert.equal(await sourceMarkerHandle.readFile('utf8'), source.ownerMarker); } finally { await sourceMarkerHandle.close(); }
  assert.match(source.nonce, /^[a-f0-9]{32}$/u); assert.equal(runtime.databaseName, source.databaseName);
  assert.equal(runtime.instanceId, `agent-settings-browser-${source.nonce}`); assert.equal(runtime.organizationId, runtime.instanceId);
  assert.equal(runtime.baseUrl, 'http://127.0.0.1:3001'); assert.equal(runtime.dataRoot, path.join(sourceRoot, 'data'));
  const originalData = await fs.lstat(runtime.dataRoot);
  assert(originalData.isDirectory() && !originalData.isSymbolicLink() && originalData.uid === sourceStat.uid && (originalData.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(runtime.dataRoot), runtime.dataRoot);
  assert.equal(source.directoryProofs[runtime.dataRoot].device, String(originalData.dev));
  assert.equal(source.directoryProofs[runtime.dataRoot].inode, String(originalData.ino));
  await assertPrivateTree(runtime.dataRoot); await ownedJson(modelInputPath);
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 3001 }); socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('The fixed test port is occupied.')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Test port availability is unknown.')); });
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Test port availability is unknown.')));
  });
  const bootstrapPath = path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
  const bootstrapStat = await fs.lstat(bootstrapPath);
  assert(bootstrapStat.isFile() && !bootstrapStat.isSymbolicLink() && bootstrapStat.nlink === 1 && (bootstrapStat.mode & 0o077) === 0);
  const bootstrap = dotenv.parse(await fs.readFile(bootstrapPath));
  assert(bootstrap.BOOTSTRAP_ADMIN_EMAIL && bootstrap.BOOTSTRAP_ADMIN_PASSWORD);
  const maintenance = new URL(bootstrap.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(maintenance.protocol) && maintenance.hostname === '127.0.0.1' && maintenance.port === '55433' && !maintenance.search && !maintenance.hash);
  maintenance.pathname = '/postgres';
  const administration = new Pool({ connectionString: maintenance.toString(), max: 1, connectionTimeoutMillis: 5000 });
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'canvas-composio-live-model-'));
  await fs.chmod(root, 0o700); const stat = await fs.lstat(root), nonce = randomBytes(16).toString('hex'), marker = randomBytes(24).toString('hex');
  const databaseName = `canvas_connection_test_${nonce}`, dataRoot = path.join(root, 'data'), tmpRoot = path.join(root, 'tmp');
  const browserSourcePaths = ['tests/composio-live-model.spec.ts', 'tests/helpers/composio-live-model-fixture.ts',
    'tests/helpers/natural-workflow-model-setup.ts', 'tests/playwright/playwright.composio-live-model-production.config.ts'];
  const expectedBrowserSourceHashes = Object.fromEntries(await Promise.all(browserSourcePaths.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex')])));
  const sourceHashes = { ...expectedBrowserSourceHashes,
    'scripts/helpers/composio-live-model-replay-fixture.ts': createHash('sha256').update(await fs.readFile(path.join(repo, 'scripts/helpers/composio-live-model-replay-fixture.ts'))).digest('hex'),
    'scripts/helpers/composio-live-model-replay-proof.ts': createHash('sha256').update(await fs.readFile(path.join(repo, 'scripts/helpers/composio-live-model-replay-proof.ts'))).digest('hex') };
  const buildId = (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim();
  const receipt = { version: 1, nonce, repo, fixtureRoot: root, dataRoot, tmpRoot, ownerMarker: marker,
    rootDevice: String(stat.dev), rootInode: String(stat.ino), databaseName, databaseOwner: source.databaseOwner,
    createAcknowledged: false, phase: 'before_clone', actorId: source.actorId, uncertain: false,
    sourceRoot, sourceNonce: source.nonce, sourceDatabaseName: source.databaseName,
    sourceRecoverySHA: createHash('sha256').update(await fs.readFile(path.join(sourceRoot, 'recovery.json'))).digest('hex'),
    serverPid: 0, issuerPid: 0, browserPid: 0, listenerVerified: false, childrenClosed: false, poolsClosed: false,
    domainCleanup: 'preserve-live-snapshot', databaseDropped: false, dataRemoved: false, sourceHashes, buildId };
  const receiptPath = path.join(root, 'recovery.json');
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600, flag: 'wx' });
  const persist = async () => { await fs.writeFile(`${receiptPath}.tmp`, JSON.stringify(receipt), { mode: 0o600 }); await fs.rename(`${receiptPath}.tmp`, receiptPath); };
  await persist(); console.log(`COMPOSIO_LIVE_MODEL_REPLAY ${root} parentPid=${process.pid}`);
  const children: Child[] = [];
  const abort = new AbortController();
  let sourceProof: ReplaySnapshotLineageProof | undefined;
  let database: Pool | undefined, bodyFailure = false;
  const inherited = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const databaseUrl = new URL(maintenance); databaseUrl.pathname = `/${databaseName}`;
  const env: NodeJS.ProcessEnv = { ...inherited, NODE_ENV: 'test', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_APP_ROOT: repo, TMPDIR: tmpRoot, CANVAS_ENV_FILE: path.join(root, 'empty.env'),
    CANVAS_PLUGIN_LOCAL_SOURCE_ROOT: path.join(dataRoot, 'live-model-intake'),
    DATABASE_URL: databaseUrl.toString(), CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_POOL_MAX: '8',
    CANVAS_INSTANCE_ID: `agent-settings-browser-${nonce}`, CANVAS_ORGANIZATION_ID: runtime.organizationId,
    INTEGRATIONS_ENV_MASTER_KEY: runtime.masterKey, BETTER_AUTH_SECRET: runtime.authSecret,
    BOOTSTRAP_ADMIN_EMAIL: bootstrap.BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD: bootstrap.BOOTSTRAP_ADMIN_PASSWORD,
    BOOTSTRAP_ADMIN_NAME: 'Isolated Agent Settings Owner', TEST_LOGIN_EMAIL: bootstrap.BOOTSTRAP_ADMIN_EMAIL, TEST_LOGIN_PASSWORD: bootstrap.BOOTSTRAP_ADMIN_PASSWORD,
    CANVAS_DEPLOYMENT_MODE: 'community', CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: '',
    CANVAS_TEAM_FEATURES_ENABLED: 'false', CANVAS_PROJECT_FEATURES_ENABLED: 'false', CANVAS_TEAM_LICENSE_REFRESH_ENABLED: 'false',
    CANVAS_TEAM_LICENSE_LIFECYCLE_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', QMD_ENABLED: 'false', ONBOARDING: 'false', ONBOARDING_HINTS: 'false',
    CANVAS_AGENT_SETTINGS_BROWSER_RUN: '1', CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1', CANVAS_COMPOSIO_LIVE_MODEL_RUN: '1',
    AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: receiptPath, E2E_EXTERNAL_SERVER: '1',
    BASE_URL: runtime.baseUrl, BETTER_AUTH_BASE_URL: runtime.baseUrl, HOSTNAME: '127.0.0.1', PORT: '3001',
    CANVAS_POSTGRES_VECTOR_ENABLED: 'true', CANVAS_VECTOR_PROVIDER: 'pgvector',
    TEST_SECONDARY_EMAIL: `live-model-one-${nonce}@example.test`, TEST_SECONDARY_PASSWORD: randomBytes(24).toString('base64url'),
    TEST_EDITOR_EMAIL: `live-model-two-${nonce}@example.test`, TEST_EDITOR_PASSWORD: randomBytes(24).toString('base64url'),
    CANVAS_CONTROL_PLANE_TEST_ROOT: await fs.realpath(path.join(repo, '..', 'canvas-control-plane')),
    CANVAS_COMPOSIO_LIVE_MODEL_INPUT: path.join(root, 'live-model-input.json') };
  const redact = (text: string) => [runtime.masterKey, runtime.authSecret, bootstrap.BOOTSTRAP_ADMIN_PASSWORD, maintenance.toString(), databaseUrl.toString(),
    env.TEST_SECONDARY_PASSWORD, env.TEST_EDITOR_PASSWORD].filter((value): value is string => Boolean(value))
    .reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text)
    .replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-postgres-url]').replace(/ak_[A-Za-z0-9_-]+/gu, '[redacted-provider-key]');
  const start = (args: string[], label: string, overrides: Record<string, string> = {}) => {
    abort.signal.throwIfAborted();
    const child = spawn(process.execPath, args, { cwd: repo, env: { ...env, ...overrides }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(path.join(root, `${label}.log`), { mode: 0o600 });
    for (const stream of [child.stdout, child.stderr]) { let pending = ''; stream?.on('data', chunk => {
      pending += String(chunk); const lines = pending.split('\n'); pending = lines.pop() || '';
      for (const line of lines) log.write(`${redact(line)}\n`); if (pending.length > 32768) { log.write('[oversized line omitted]\n'); pending = ''; }
    }); stream?.on('end', () => { if (pending) log.write(redact(pending)); }); }
    const record: Child = { process: child, pid: child.pid || 0, ended: false, closed: Promise.resolve(null) };
    assert(record.pid > 0); children.push(record);
    record.closed = new Promise(resolve => { child.once('error', () => { receipt.uncertain = true; }); child.once('close', code => { record.ended = true; log.end(); resolve(code); }); });
    return record;
  };
  const stop = async (child: Child) => {
    if (child.ended) return;
    assert(child.process.pid === child.pid && child.process.exitCode === null && child.process.signalCode === null);
    process.kill(-child.pid, 'SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([child.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
    if (timer) clearTimeout(timer);
    if (!ended) { receipt.uncertain = true; throw new Error('Owned child closure is unconfirmed.'); }
  };
  const cancel = () => { receipt.uncertain = true; abort.abort(); for (const child of children) if (!child.ended && child.process.exitCode === null && child.process.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { receipt.uncertain = true; }
  } };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    abort.signal.throwIfAborted();
    const current = await administration.query('SELECT d.datname,pg_get_userbyid(d.datdba) AS owner,shobj_description(d.oid,\'pg_database\') AS marker FROM pg_database d WHERE datname=$1', [source.databaseName]);
    assert.equal(current.rowCount, 1); assert.equal(current.rows[0].owner, source.databaseOwner); assert.equal(current.rows[0].marker, source.ownerMarker);
    assert.equal((await administration.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [source.databaseName])).rowCount, 0);
    assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [databaseName])).rowCount, 0);
    const sourceUrl = new URL(maintenance); sourceUrl.pathname = `/${source.databaseName}`;
    const sourcePool = new Pool({ connectionString: sourceUrl.toString(), max: 1, connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on' });
    try {
      const proofs = await import('./composio-live-model-replay-proof');
      const baseline = await proofs.assertReplayBaselineReadiness({ database: sourcePool, databaseName: source.databaseName, organizationId: runtime.organizationId, actorId: source.actorId, additionalUsers: 2 });
      await fs.writeFile(path.join(root, 'source-membership-baseline.json'), JSON.stringify({ version: 1, nonce, ...baseline }), { mode: 0o600, flag: 'wx' });
      sourceProof = await proofs.assertReplaySnapshotLineage({ phase: 'source_before', database: sourcePool, databaseName: source.databaseName, dataRoot: runtime.dataRoot, root, nonce, sourceNonce: source.nonce, organizationId: runtime.organizationId, actorId: source.actorId });
    } finally { await sourcePool.end(); }
    abort.signal.throwIfAborted();
    receipt.phase = 'clone_in_flight'; await persist();
    assert.match(source.databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
    await administration.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${source.databaseName}"`);
    receipt.createAcknowledged = true; await administration.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`); await persist();
    const cloneOwner = (await administration.query('SELECT pg_get_userbyid(d.datdba) AS owner,shobj_description(d.oid,\'pg_database\') AS marker FROM pg_database d WHERE datname=$1', [databaseName])).rows;
    assert.equal(cloneOwner.length, 1); assert.equal(cloneOwner[0].owner, source.databaseOwner); assert.equal(cloneOwner[0].marker, marker);
    receipt.databaseOwner = cloneOwner[0].owner;
    await fs.cp(runtime.dataRoot, dataRoot, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }); await fs.chmod(dataRoot, 0o700);
    // The snapshot is a NEW isolated instance. Preserve its copied old licensing
    // identity outside DATA before activating the new instance through normal APIs.
    // Provider/Org/User secrets and historical DB certificates remain untouched.
    const oldLicenseDirectory = path.join(dataRoot, 'secrets', 'license');
    const oldLicenseStat = await fs.lstat(oldLicenseDirectory);
    assert(oldLicenseStat.isDirectory() && !oldLicenseStat.isSymbolicLink() && oldLicenseStat.uid === stat.uid);
    const licenseFiles = [];
    for (const filename of await fs.readdir(oldLicenseDirectory)) {
      const file = path.join(oldLicenseDirectory, filename), fileStat = await fs.lstat(file);
      assert(fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.nlink === 1 && fileStat.uid === stat.uid);
      licenseFiles.push({ filename, device: String(fileStat.dev), inode: String(fileStat.ino), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
    }
    await fs.rename(oldLicenseDirectory, path.join(root, 'snapshot-old-license-identity'));
    await fs.writeFile(path.join(root, 'license-identity-quarantine.json'), JSON.stringify({ copiedDirectory: 'data/secrets/license', preservedDirectory: 'snapshot-old-license-identity', files: licenseFiles }), { mode: 0o600, flag: 'wx' });
    await fs.mkdir(tmpRoot, { mode: 0o700 }); await fs.writeFile(env.CANVAS_ENV_FILE!, '', { mode: 0o600, flag: 'wx' });
    const heldModelInput = path.join(root, 'normal-model-input.json');
    await fs.writeFile(heldModelInput, await fs.readFile(modelInputPath), { mode: 0o600, flag: 'wx' });
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
    database = new Pool({ connectionString: databaseUrl.toString(), max: 2, connectionTimeoutMillis: 5000 });
    await (await import('../../app/lib/db/postgres')).runPostgresMigrations(database);
    assert.equal((await database.query('SELECT id FROM "user" WHERE id=$1 AND role=$2', [source.actorId, 'admin'])).rowCount, 1);
    await (await import('./composio-live-model-replay-proof')).assertReplaySnapshotLineage({ phase: 'clone_after', database, databaseName, dataRoot, root, nonce, sourceNonce: source.nonce, organizationId: runtime.organizationId, actorId: source.actorId, expected: sourceProof });
    await fs.mkdir(env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT!, { mode: 0o700 });
    const lineage = await database.query("SELECT connection_ref,backend_profile_id,backend_account_id FROM integration_connection_resources WHERE source='composio' ORDER BY connection_ref");
    await fs.writeFile(path.join(root, 'encrypted-binding-lineage.json'), JSON.stringify({ sourceNonce: source.nonce, snapshotNonce: nonce,
      bindings: lineage.rows.map(value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, createHash('sha256').update(String(item)).digest('hex')])) ) }), { mode: 0o600, flag: 'wx' });
    env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true'; process.env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true';
    receipt.phase = 'bootstrap'; await persist();
    const issuer = start(['--import', 'tsx', 'scripts/helpers/agent-workflow-team-issuer-fixture.ts'], 'issuer', { NODE_ENV: 'development', CANVAS_ISSUER_MAINTENANCE_DATABASE_URL: maintenance.toString() });
    receipt.issuerPid = issuer.pid; await persist();
    let ready: Ready | undefined; const readyDeadline = Date.now() + 120000;
    while (!ready && Date.now() < readyDeadline && !issuer.ended) {
      abort.signal.throwIfAborted();
      try { ready = await ownedJson<Ready>(path.join(root, 'issuer-ready.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(ready && !issuer.ended); assert.equal(ready.nonce, nonce); assert.equal(ready.fixtureRoot, root); assert.equal(ready.instanceId, env.CANVAS_INSTANCE_ID);
    Object.assign(env, { CANVAS_LICENSE_CONTROL_PLANE_URL: ready.origin, CANVAS_LICENSE_PUBLIC_KEY: ready.initialPublicKey,
      CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.initialPublicKeyFingerprint, CANVAS_LICENSE_TEST_PUBLIC_KEY: ready.testPublicKey,
      CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.testPublicKeyFingerprint, CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production',
      CANVAS_LICENSE_TEST_AUDIENCE: 'canvas-notebook-test', CANVAS_TEAM_SEAT_CLIENT_ENABLED: 'true', CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED: 'true', CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED: 'true' });
    Object.assign(process.env, env);
    const { activateLicenseCert } = await import('../../app/lib/license');
    const { startCommunityLicenseClaim, pollCommunityLicenseClaim, refreshCommunityLicenseCertificate } = await import('../../app/lib/license/control-plane');
    assert.equal((await activateLicenseCert(await fs.readFile(ready.certificatePath, 'utf8'))).licensed, true);
    const control = async (operation: string, body: Record<string, unknown>) => {
      const response = await fetch(`${ready!.origin}/__owned/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${ready!.controlSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200); const value = await response.json() as { success: boolean; licenseId: string; instanceId: string };
      assert.equal(value.success, true); assert.equal(value.licenseId, ready!.licenseId); assert.equal(value.instanceId, env.CANVAS_INSTANCE_ID);
    };
    const claim = await startCommunityLicenseClaim(); assert.equal(claim.state, 'authorization_pending'); await control('approve-claim', { userCode: claim.userCode });
    let connected = false; const claimDeadline = Date.now() + 30000;
    while (!connected && Date.now() < claimDeadline) { abort.signal.throwIfAborted(); connected = (await pollCommunityLicenseClaim(claim.claimId)).state === 'connected'; if (!connected) await new Promise(resolve => setTimeout(resolve, 1000)); }
    assert(connected); await control('development-grant', {});
    env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development'; process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
    const license = await refreshCommunityLicenseCertificate(); assert.equal(license.status.licensed, true); assert.equal(license.status.edition, 'team'); assert.equal(license.status.licenseClass, 'test'); assert.equal(license.status.licenseEnvironment, 'development');
    Object.assign(env, { CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true' }); Object.assign(process.env, env);
    const sync = await (await import('../../app/lib/license/team-membership-sync')).runTeamMembershipSnapshotSyncCycle({ forceReport: true });
    assert.equal(sync.failed, 0); assert.equal(sync.deferred, 0); assert.equal(sync.reconciliationFailed, 0); assert(sync.acknowledged > 0);
    await fs.writeFile(path.join(root, 'normal-license-snapshot-sync.json'), JSON.stringify({ version: 1, nonce, ...sync }), { mode: 0o600, flag: 'wx' });
    const originalInput = await ownedJson<{ targets: Array<{ scope: string; workspaceId: string; connectionRef: string }> }>(path.join(sourceRoot, 'live-gateway-input.json'));
    const targets = [];
    for (const target of originalInput.targets) {
      const id = /^canvas-connection:([a-f0-9-]{36})$/u.exec(target.connectionRef)?.[1]; assert(id);
      const binding = lineage.rows.find(value => value.connection_ref === target.connectionRef); assert(binding);
      targets.push({ scope: target.scope, connectionRef: target.connectionRef, workspaceId: target.workspaceId, profileId: binding.backend_profile_id });
    }
    assert.equal(targets.length, 2);
    assert.equal(new Set(targets.map(target => target.connectionRef)).size, 2);
    assert.deepEqual(targets.map(target => target.scope).sort(), ['organization', 'team']);
    await fs.writeFile(env.CANVAS_COMPOSIO_LIVE_MODEL_INPUT!, JSON.stringify({ version: 1, nonce, root, organizationId: runtime.organizationId, actorId: source.actorId, targets, modelInputPath: heldModelInput }), { mode: 0o600, flag: 'wx' });
    receipt.phase = 'host_starting'; await persist();
    const host = start(['--import', 'tsx', 'server.js'], 'host', { NODE_ENV: 'production' }); receipt.serverPid = host.pid; await persist();
    let healthy = false; const hostDeadline = Date.now() + 120000;
    while (!healthy && Date.now() < hostDeadline && !host.ended) {
      abort.signal.throwIfAborted();
      try { const response = await fetch(`${runtime.baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) }); const body = await response.json() as { deployment?: { mode: string; teamFeaturesEnabled: boolean } }; healthy = response.status === 200 && body.deployment?.mode === 'team' && body.deployment.teamFeaturesEnabled; } catch { /* Bounded read-only readiness. */ }
      if (!healthy) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(healthy && !host.ended);
    const listeners = await new Promise<string>((resolve, reject) => execFile('lsof', ['-nP', '-iTCP:3001', '-sTCP:LISTEN', '-Fp'], { timeout: 5000 }, (error, stdout) => error ? reject(new Error('Owned listener unconfirmed.')) : resolve(stdout)));
    assert.deepEqual(listeners.split('\n').filter(value => /^p\d+$/u.test(value)), [`p${host.pid}`]); receipt.listenerVerified = true;
    receipt.phase = 'browser'; await persist();
    const browser = start(['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright/playwright.composio-live-model-production.config.ts'], 'browser'); receipt.browserPid = browser.pid; await persist();
    let browserTimer: ReturnType<typeof setTimeout> | undefined;
    let code: number | null;
    try { code = await Promise.race([browser.closed, new Promise<never>((_resolve, reject) => { browserTimer = setTimeout(() => reject(new Error('Owned browser deadline exceeded.')), 22 * 60000); })]); }
    finally { if (browserTimer) clearTimeout(browserTimer); }
    abort.signal.throwIfAborted(); assert.equal(code, 0);
    // The Parent independently consumes the original authenticated browser proof
    // and actual DB audits before authorizing an accepted terminal phase.
    assert(sourceProof);
    for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex'), expected);
    await (await import('./composio-live-model-replay-proof')).assertLiveComposioModelAudit({ database, databaseName, root, nonce, organizationId: runtime.organizationId, actorId: source.actorId, snapshot: sourceProof, expectedBrowserSourceHashes });
    receipt.phase = 'live_model_complete'; await persist();
  } catch (error) {
    bodyFailure = true; receipt.phase = 'failed_preserved';
    // Runtime errors can carry credentials, paths and upstream bodies. Persist only a fixed code.
    const site = error instanceof Error ? error.stack?.split('\n').find(line => line.includes('composio-live-model-replay-fixture.ts:'))?.match(/composio-live-model-replay-fixture\.ts:(\d+):(\d+)/u)?.slice(1) : undefined;
    console.error(`COMPOSIO_LIVE_MODEL_REPLAY_FAILED ${error instanceof Error ? error.name : 'UnknownError'}${site ? ` at ${site.join(':')}` : ''}`);
  } finally {
    for (const child of [...children].reverse()) { try { await stop(child); } catch { receipt.uncertain = true; } }
    receipt.childrenClosed = children.every(child => child.ended);
    try { await (await import('../../app/lib/db')).closeDatabaseConnections(); if (database) await database.end(); receipt.poolsClosed = true; } catch { receipt.uncertain = true; }
    try {
      assert.equal(createHash('sha256').update(await fs.readFile(path.join(sourceRoot, 'recovery.json'))).digest('hex'), receipt.sourceRecoverySHA);
      for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex'), expected);
      assert.equal((await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim(), buildId);
      if (sourceProof) {
        const sourceUrl = new URL(maintenance); sourceUrl.pathname = `/${source.databaseName}`;
        const sourcePool = new Pool({ connectionString: sourceUrl.toString(), max: 1, connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on' });
        try { await (await import('./composio-live-model-replay-proof')).assertReplaySnapshotLineage({ phase: 'source_final', database: sourcePool, databaseName: source.databaseName, dataRoot: runtime.dataRoot, root, nonce, sourceNonce: source.nonce, organizationId: runtime.organizationId, actorId: source.actorId, expected: sourceProof }); }
        finally { await sourcePool.end(); }
      }
      assert.equal((await administration.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [databaseName])).rowCount, 0);
      for (const child of children) for (const pid of [child.pid, -child.pid]) {
        let gone = false; try { process.kill(pid, 0); } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        assert(gone, 'The original owned PID and group must both be absent.');
      }
      if (receipt.issuerPid) { const proof = await ownedJson<{ phase: string; uncertain: boolean; databaseDropped: boolean }>(path.join(root, 'issuer-recovery.json')); assert.equal(proof.phase, 'cleaned'); assert.equal(proof.uncertain, false); assert.equal(proof.databaseDropped, true); }
    } catch { receipt.uncertain = true; }
    await administration.end(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    if (!bodyFailure && !receipt.uncertain && receipt.childrenClosed && receipt.poolsClosed) receipt.phase = 'live_model_verified_preserved';
    await persist();
  }
  if (receipt.phase !== 'live_model_verified_preserved') process.exitCode = 1;
  else console.log('COMPOSIO_LIVE_MODEL_REPLAY_VERIFIED_CLOSED');
}

void resumeComposioLiveModelFixture().catch(() => { console.error('COMPOSIO_LIVE_MODEL_REPLAY_PREFLIGHT_FAILED'); process.exitCode = 1; });
