import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';

type Child = { process: ChildProcess; pid: number; closed: Promise<number | null>; ended: boolean };

/** Published packages are sealed. Restore only this proved, stopped fixture tree; never follow links. */
async function makeOwnDirectoriesWritable(treeRoot: string, proof: { device: string; inode: string }): Promise<void> {
  const root = await fs.lstat(treeRoot);
  assert(root.isDirectory() && !root.isSymbolicLink());
  assert.equal(String(root.dev), proof.device); assert.equal(String(root.ino), proof.inode);
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    assert(depth <= 64 && ++visited <= 30_000, 'The own fixture directory traversal exceeded its bounds.');
    const relative = path.relative(treeRoot, directory);
    assert(relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    assert.equal(entry.dev, root.dev); assert.equal(entry.uid, root.uid);
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      assert.equal(held.dev, entry.dev); assert.equal(held.ino, entry.ino); assert.equal(held.uid, root.uid);
      await handle.chmod(0o700);
      const current = await fs.lstat(directory);
      assert(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.ino, held.ino); assert.equal(current.dev, held.dev);
      for (const name of await fs.readdir(directory)) await visit(path.join(directory, name), depth + 1);
    } finally { await handle.close(); }
  };
  await visit(treeRoot, 0);
}
type Receipt = {
  version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; databaseOwner: string | null;
  directoryProofs: Record<string, { device: string; inode: string }>; listenerVerified: boolean;
  createAcknowledged: boolean; phase: string; serverPid: number | null; actorId: string | null;
  uncertain: boolean; databaseDropped: boolean; dataRemoved: boolean;
};

async function assertPortAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 3001 });
    socket.setTimeout(1_000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Port 3001 is already occupied; no lifecycle action is permitted.')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Port availability is uncertain.')); });
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Port availability is uncertain.')));
  });
}

async function main(): Promise<void> {
  assert.equal(process.env.CANVAS_AGENT_SETTINGS_BROWSER_RUN, '1');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.__NEXT_PROCESSED_ENV, 'true');
  const maintenance = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(maintenance.hostname, '127.0.0.1'); assert.equal(maintenance.port, '55433');
  assert.equal(maintenance.pathname, '/postgres'); assert.equal(maintenance.search, ''); assert.equal(maintenance.hash, '');
  assert(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD);
  const repo = await fs.realpath(process.cwd());
  await fs.access(path.join(repo, '.next/BUILD_ID'));
  await assertPortAvailable();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-settings-browser-')));
  await fs.chmod(root, 0o700);
  const rootStat = await fs.lstat(root);
  const nonce = randomBytes(16).toString('hex');
  const marker = randomBytes(24).toString('hex');
  const dataRoot = path.join(root, 'data'), tmpRoot = path.join(root, 'tmp'), results = path.join(root, 'results');
  for (const directory of [dataRoot, tmpRoot, results]) await fs.mkdir(directory, { mode: 0o700 });
  const directoryProofs: Receipt['directoryProofs'] = {};
  for (const directory of [dataRoot, tmpRoot]) {
    const stat = await fs.lstat(directory); directoryProofs[directory] = { device: String(stat.dev), inode: String(stat.ino) };
  }
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600 });
  const emptyEnv = path.join(root, 'empty.env');
  await fs.writeFile(emptyEnv, '', { mode: 0o600 });
  const receiptPath = path.join(root, 'recovery.json');
  const receipt: Receipt = { version: 1, nonce, repo, fixtureRoot: root, dataRoot, tmpRoot, ownerMarker: marker,
    rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), databaseName: `canvas_connection_test_${nonce}`,
    directoryProofs, listenerVerified: false,
    databaseOwner: null, createAcknowledged: false, phase: 'before_create', serverPid: null, actorId: null,
    uncertain: false, databaseDropped: false, dataRemoved: false };
  const persist = async () => {
    const temporary = `${receiptPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
    await fs.rename(temporary, receiptPath);
  };
  // The exact name is durable BEFORE CREATE. An ambiguous CREATE is preserved;
  // current role/ownership alone never turns it into an acknowledged fixture.
  await persist();
  const administration = new Pool({ connectionString: maintenance.toString(), max: 1, connectionTimeoutMillis: 5_000, query_timeout: 30_000 });
  let database: Pool | undefined;
  let server: Child | undefined;
  const children: Child[] = [];
  const abort = new AbortController();
  const signalChild = (child: Child, signal: NodeJS.Signals) => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.process.pid !== child.pid) {
      receipt.uncertain = true;
      return;
    }
    if (child.ended || child.process.exitCode !== null || child.process.signalCode !== null) return;
    // Each direct child starts its own process group. Never discover other PIDs
    // or signal a group after its acknowledged direct child has finished.
    try { process.kill(-child.pid, signal); } catch { receipt.uncertain = true; }
  };
  const cancel = () => { receipt.uncertain = true; abort.abort(); for (const child of children) signalChild(child, 'SIGTERM'); };
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const runtimeUrl = new URL(maintenance); runtimeUrl.pathname = `/${receipt.databaseName}`;
  const permittedEnv = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD',
    'BOOTSTRAP_ADMIN_NAME', 'CANVAS_AGENT_SETTINGS_BROWSER_RUN'];
  const baseEnv = Object.fromEntries(permittedEnv.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const env: NodeJS.ProcessEnv = { ...baseEnv, NODE_ENV: 'test', DATABASE_URL: runtimeUrl.toString(),
    DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_APP_ROOT: repo, TMPDIR: tmpRoot, CANVAS_ENV_FILE: emptyEnv,
    CANVAS_PLUGIN_LOCAL_SOURCE_ROOT: path.join(dataRoot, 'workflow-editor-intake'),
    CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_POOL_MAX: '8', CANVAS_DEPLOYMENT_MODE: 'community',
    CANVAS_ORGANIZATION_ID: `agent-settings-browser-${nonce}`, CANVAS_INSTANCE_ID: `agent-settings-browser-${nonce}`,
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: '',
    CANVAS_TEAM_FEATURES_ENABLED: 'false', CANVAS_PROJECT_FEATURES_ENABLED: 'false',
    CANVAS_TEAM_LICENSE_REFRESH_ENABLED: 'false', CANVAS_TEAM_LICENSE_LIFECYCLE_ENABLED: 'false',
    CANVAS_MCP_DIRECT_ENABLED: 'false', QMD_ENABLED: 'false', ONBOARDING: 'false', ONBOARDING_HINTS: 'false',
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1', PORT: '3001', BASE_URL: 'http://127.0.0.1:3001', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3001',
    TEST_LOGIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL, TEST_LOGIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    E2E_EXTERNAL_SERVER: '1', AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: receiptPath,
    AGENT_SETTINGS_TOOLS_BROWSER_RESULTS: results,
  };
  const startChild = (args: string[], phase: string, nodeEnv: 'production' | 'test'): Child => {
    abort.signal.throwIfAborted();
    const log = createWriteStream(path.join(root, `${phase}.log`), { mode: 0o600 });
    const redact = (value: string) => [process.env.BOOTSTRAP_ADMIN_PASSWORD, env.BETTER_AUTH_SECRET, runtimeUrl.toString(), maintenance.toString()]
      .filter((secret): secret is string => Boolean(secret)).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
      .replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-postgres-url]');
    const child = spawn(process.execPath, args, { cwd: repo, env: { ...env, NODE_ENV: nodeEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const record: Child = { process: child, pid: child.pid ?? 0, ended: false, closed: Promise.resolve(null) };
    children.push(record);
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.on('data', chunk => {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) log.write(`${redact(line)}\n`);
        if (pending.length > 32_768) { log.write('[oversized log line omitted]\n'); pending = ''; }
      });
      stream?.on('end', () => { if (pending) log.write(redact(pending)); });
    }
    record.closed = new Promise(resolve => {
      child.once('error', () => { receipt.uncertain = true; });
      child.once('close', code => { record.ended = true; log.end(); resolve(code); });
    });
    return record;
  };
  const waitChild = async (child: Child, timeoutMs: number): Promise<number | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([child.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { receipt.uncertain = true; signalChild(child, 'SIGTERM'); reject(new Error('The own child exceeded its bounded deadline.')); }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const stopChild = async (child: Child): Promise<void> => {
    if (child.ended) return;
    signalChild(child, 'SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([child.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 15_000); })]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      receipt.uncertain = true;
      signalChild(child, 'SIGKILL');
      try { await waitChild(child, 5_000); } catch { /* Preserve the fixture if the owned child remains unreaped. */ }
    }
    if (!child.ended) throw new Error('The recorded fixture child was not reaped.');
  };
  const assertRoot = async () => {
    const current = await fs.lstat(root);
    assert(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.mode & 0o777, 0o700);
    assert.equal(String(current.dev), receipt.rootDevice); assert.equal(String(current.ino), receipt.rootInode);
    assert.equal(await fs.realpath(root), root);
    const markerStat = await fs.lstat(path.join(root, '.fixture-owner'));
    assert(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1);
    assert.equal(markerStat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(path.join(root, '.fixture-owner'), 'utf8'), marker);
  };
  const assertDirectory = async (directory: string) => {
    const current = await fs.lstat(directory); assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(String(current.dev), directoryProofs[directory].device); assert.equal(String(current.ino), directoryProofs[directory].inode);
    assert.equal(await fs.realpath(directory), directory); assert.equal(path.dirname(directory), root);
  };
  const inspectProcess = async (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile('lsof', args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('The exact owned listener could not be verified.')); else resolve(stdout);
    });
  });
  const assertOwnedListener = async () => {
    assert(server && !server.ended && server.process.exitCode === null && server.process.signalCode === null);
    const listener = await inspectProcess(['-nP', '-iTCP:3001', '-sTCP:LISTEN', '-Fp']);
    const pids = new Set(listener.split('\n').filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1))));
    assert.equal(pids.size, 1); assert(pids.has(server.pid), 'A discovered foreign PID cannot become the fixture host.');
    const cwd = await inspectProcess(['-a', '-p', String(server.pid), '-d', 'cwd', '-Fn']);
    const directories = cwd.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    assert.equal(directories.length, 1); assert.equal(await fs.realpath(directories[0]), repo);
  };
  let bodyFailure: unknown;
  try {
    const collisions = await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [receipt.databaseName]);
    assert.equal(collisions.rowCount, 0, 'A pre-existing database cannot become this fixture.');
    receipt.databaseOwner = (await administration.query('SELECT current_user AS role')).rows[0].role;
    receipt.phase = 'create_in_flight'; await persist();
    await administration.query(`CREATE DATABASE "${receipt.databaseName}"`);
    receipt.createAcknowledged = true; receipt.phase = 'migrations'; await persist();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env, { NODE_ENV: 'test' });
    database = new Pool({ connectionString: runtimeUrl.toString(), max: 8, connectionTimeoutMillis: 5_000 });
    const { runPostgresMigrations } = await import('../../app/lib/db/postgres');
    await runPostgresMigrations(database);
    assert.equal((await database.query('SELECT current_database() AS name')).rows[0].name, receipt.databaseName);
    assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM "user"')).rows[0].count, 0);
    await administration.query(`COMMENT ON DATABASE "${receipt.databaseName}" IS '${marker}'`);
    env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true';
    receipt.phase = 'bootstrap'; await persist();
    const bootstrap = startChild(['scripts/bootstrap-admin.js', '--ensure'], 'bootstrap', 'production');
    assert.equal(await waitChild(bootstrap, 60_000), 0, 'The official bootstrap CLI must succeed.');
    const users = (await database.query('SELECT id,role FROM "user"')).rows;
    assert.equal(users.length, 1); assert.equal(users[0].role, 'admin'); receipt.actorId = String(users[0].id);
    receipt.phase = 'host_starting'; await persist();
    server = startChild(['--import', 'tsx', 'server.js'], 'host', 'production');
    assert(server.pid > 0); receipt.serverPid = server.pid; await persist();
    const deadline = Date.now() + 120_000;
    let healthy = false;
    while (Date.now() < deadline && !server.ended) {
      abort.signal.throwIfAborted();
      try {
        const response = await fetch(`${env.BASE_URL}/api/health`, { signal: AbortSignal.timeout(3_000) });
        const body = await response.json() as { deployment?: { mode?: string; teamFeaturesEnabled?: boolean } };
        healthy = response.status === 200 && body.deployment?.mode === 'community' && body.deployment.teamFeaturesEnabled === false;
        if (healthy) break;
      } catch { /* Bounded readiness polling never changes another host. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(healthy && !server.ended, 'The recorded isolated production host must become ready.');
    await assertOwnedListener(); receipt.listenerVerified = true;
    receipt.phase = 'browser'; await persist();
    const browser = startChild([path.join(repo, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.agent-settings-tools-production.config.ts'], 'browser', 'test');
    const browserCode = await waitChild(browser, 300_000);
    const browserReceipt = JSON.parse(await fs.readFile(path.join(root, 'browser-receipt.json'), 'utf8')) as { nonce: string; actorId: string; phase: string; outstanding: unknown };
    assert.equal(browserReceipt.nonce, nonce); assert.equal(browserReceipt.actorId, receipt.actorId);
    assert.equal(browserReceipt.phase, 'verified_closed'); assert.equal(browserReceipt.outstanding, null);
    assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM pi_sessions')).rows[0].count, 0);
    await assertOwnedListener();
    if (browserCode !== 0) bodyFailure = new Error('The actual agent-switch browser assertion failed; see the private browser log.');
    receipt.phase = 'browser_complete'; await persist();
  } catch (error) {
    bodyFailure = error;
    // Missing acknowledgements, transport failures, cancellation and interrupted
    // browser writes cannot justify destroying this fixture's diagnostic state.
    receipt.uncertain = true;
  } finally {
    for (const child of [...children].reverse()) {
      try { await stopChild(child); } catch { receipt.uncertain = true; }
      // A surviving process group is preserved, never killed via a reused PID.
      if (Number.isSafeInteger(child.pid) && child.pid > 0 && child.process.pid === child.pid) {
        try { process.kill(-child.pid, 0); receipt.uncertain = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') receipt.uncertain = true; }
      } else receipt.uncertain = true;
    }
    if (server && !server.ended) receipt.uncertain = true;
    if (database) { try { await database.end(); } catch { receipt.uncertain = true; } }
    try {
      await assertRoot();
      if (receipt.createAcknowledged && !receipt.uncertain && children.every(child => child.ended)) {
        for (const directory of [dataRoot, tmpRoot]) await assertDirectory(directory);
        const current = (await administration.query(`SELECT pg_get_userbyid(datdba) AS owner,current_user AS role,
          shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [receipt.databaseName])).rows[0];
        assert(current && current.owner === receipt.databaseOwner && current.owner === current.role && current.marker === marker);
        for (const directory of [dataRoot, tmpRoot]) await makeOwnDirectoriesWritable(directory, receipt.directoryProofs[directory]);
        // No FORCE and no backend termination: an unexpected live connection
        // makes cleanup fail and preserves DATA and the private receipt.
        await administration.query(`DROP DATABASE "${receipt.databaseName}"`);
        receipt.databaseDropped = true; await persist();
        assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [receipt.databaseName])).rowCount, 0);
        for (const directory of [dataRoot, tmpRoot]) {
          await assertDirectory(directory);
          await fs.rm(directory, { recursive: true, force: true });
        }
        receipt.dataRemoved = true; receipt.phase = 'cleaned';
      } else receipt.phase = 'preserved';
    } catch { receipt.uncertain = true; receipt.phase = 'preserved'; }
    await persist(); await administration.end();
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  }
  if (receipt.uncertain || !receipt.databaseDropped || !receipt.dataRemoved) {
    throw new Error(`The isolated fixture was preserved; private recovery receipt: ${receiptPath}`);
  }
  console.log(`ISOLATED_AGENT_SETTINGS_CLEANUP_PASS ${root}`);
  if (bodyFailure) throw bodyFailure;
}

void main().catch(error => {
  // Never print driver errors, child env or connection URLs.
  console.error(error instanceof Error && /^(?:The isolated fixture was preserved;|The actual agent-switch browser assertion failed;)/u.test(error.message)
    ? error.message : 'Isolated agent settings acceptance stopped safely.');
  process.exitCode = 1;
});
