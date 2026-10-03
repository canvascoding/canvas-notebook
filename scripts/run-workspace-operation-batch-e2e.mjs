/** Managed host E2E: one owned Notebook process, real PostgreSQL, then a real worker restart. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { chromium, request } from '@playwright/test';
import { uploadWorkspaceTextFile } from '../tests/helpers/managed-test-context.ts';

const run = promisify(execFile);
const cwd = process.cwd();
const automatic = process.argv.includes('--automatic');
const attention = process.argv.includes('--attention');
const reviewToggle = process.argv.includes('--review-toggle');
const directRestart = process.argv.includes('--direct-restart');
const envFile = process.env.CANVAS_ENV_FILE || path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
const localEnv = parse(await fs.readFile(envFile));
const port = Number(process.env.CANVAS_BATCH_E2E_PORT || 3001);
const baseURL = `http://localhost:${port}`;
const artifacts = path.join(cwd, '.playwright-mcp/file-review-batches');
const runId = randomUUID();
const isolatedDatabase = `canvas_file_review_e2e_${runId.replaceAll('-', '')}`;
const isolatedData = path.join(os.tmpdir(), `canvas-file-review-e2e-${runId}`);
const peerGateDirectory = path.join(isolatedData, 'peer-gates');
const managedDatabaseURL = new URL(localEnv.DATABASE_URL || '');
if (!['postgres:', 'postgresql:'].includes(managedDatabaseURL.protocol)
  || !['localhost', '127.0.0.1'].includes(managedDatabaseURL.hostname)
  || managedDatabaseURL.port !== '55433' || managedDatabaseURL.pathname !== '/canvas_notebook') {
  throw new Error('File review E2E requires the managed loopback PostgreSQL database at 55433/canvas_notebook.');
}
const isolatedDatabaseURL = new URL(managedDatabaseURL);
isolatedDatabaseURL.pathname = `/${isolatedDatabase}`;
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, ...localEnv, NODE_ENV: 'development', PORT: String(port), HOSTNAME: 'localhost',
  CANVAS_ENV_FILE: envFile, CANVAS_APP_ROOT: cwd, BASE_URL: baseURL, BETTER_AUTH_BASE_URL: baseURL,
  DATABASE_URL: isolatedDatabaseURL.href, DATA: isolatedData, CANVAS_DATA_ROOT: isolatedData,
  CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'false',
  CANVAS_DEPLOYMENT_MODE: 'community', CANVAS_TEAM_FEATURES_ENABLED: 'false',
  ONBOARDING: 'false',
  E2E_EXTERNAL_SERVER: '1', CANVAS_BATCH_E2E_RUN_ID: runId, CANVAS_BATCH_E2E_GATE_DIR: peerGateDirectory };
if (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) throw new Error('Managed bootstrap credentials required.');
for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', () => reject(new Error(`E2E port ${port} is occupied; no unrelated process was stopped.`)));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});

// A private database on the existing managed server prevents another checkout's
// durable worker from claiming our jobs against its different filesystem.
const databaseAdmin = new Client({ connectionString: managedDatabaseURL.href });
let isolatedDatabaseCreated = false;
await databaseAdmin.connect();
try {
  await databaseAdmin.query(`CREATE DATABASE "${isolatedDatabase}"`);
  isolatedDatabaseCreated = true;
  await fs.mkdir(isolatedData, { mode: 0o700 });
  await fs.mkdir(peerGateDirectory, { mode: 0o700 });
} catch (error) {
  if (isolatedDatabaseCreated) await databaseAdmin.query(`DROP DATABASE "${isolatedDatabase}"`);
  await databaseAdmin.end();
  throw error;
}

let server;
let serverReady = false;
let log;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function startServer() {
  log = await fs.open(path.join(artifacts, 'owned-server.log'), 'a', 0o600);
  server = spawn(process.execPath, ['--import', 'tsx', '--import', './scripts/workspace-operation-batch-e2e-gate.ts', 'server.js'], { cwd, env,
    stdio: ['ignore', log.fd, log.fd] });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Owned E2E server exited during startup. Inspect its private log.');
    const healthy = await fetch(`${baseURL}/api/health`).then((response) => response.ok).catch(() => false);
    if (healthy) { serverReady = true; return; }
    await sleep(500);
  }
  throw new Error('Owned E2E server did not become ready.');
}
async function stopServer() {
  const child = server;
  server = undefined;
  serverReady = false;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 40 && child.exitCode === null && child.signalCode === null; attempt += 1) await sleep(250);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  await log?.close();
  log = undefined;
}

async function restartScenario(mode = 'queued', direct = false) {
  const api = await request.newContext({ baseURL });
  let workspaceId;
  let browser;
  try {
    const signIn = await api.post('/api/auth/sign-in/email', { headers: { Origin: baseURL }, data: {
      email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
    } });
    if (!signIn.ok()) throw new Error(`Restart test login failed (${signIn.status()}).`);
    const availability = await api.patch('/api/admin/experimental-settings', { data: { documentReviewEnabled: !direct } });
    if (!availability.ok()) throw new Error('Could not set the disposable restart scenario policy.');
    const { user } = await (await api.get('/api/auth/get-session')).json();
    const created = await api.post('/api/workspaces', { data: { type: 'personal', name: `E2E batch review ${mode === 'crash' ? 'crash' : mode === 'check' ? 'check-restart' : 'restart'} ${Date.now()}` } });
    if (!created.ok()) throw new Error('Could not create disposable restart workspace.');
    workspaceId = (await created.json()).workspace.id;
    const headers = { 'x-canvas-workspace-id': workspaceId };
    const files = mode === 'crash' ? [['A.txt', 'A bytes\n'], ['B.txt', 'B bytes\n']]
      : [['A.md', '# A\n'], ['B.md', '# B\n'], ['index.md', '[A](A.md) [B](B.md)\n']];
    for (const [filePath, content] of files) {
      await uploadWorkspaceTextFile({ request: api, workspaceId, filePath, content });
    }
    const input = { workspaceId, user, actions: mode === 'crash' ? [
      { kind: 'move', selections: [{ sourcePath: 'A.txt', destinationPath: 'moved/A.txt' }] },
      { kind: 'move', selections: [{ sourcePath: 'B.txt', destinationPath: 'moved/B.txt' }] },
    ] : [
      { kind: 'move', selections: [{ sourcePath: 'A.md', destinationPath: 'moved/A.md' }] },
      { kind: 'delete', selections: [{ sourcePath: 'B.md' }] },
    ] };
    let reviews = [];
    if (!direct) {
      const proposals = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
        'scripts/workspace-operation-batch-e2e-fixture.ts', JSON.stringify(input)], { cwd, env, timeout: 90_000 });
      reviews = JSON.parse(proposals.stdout.split('\n').find((line) => line.startsWith('BATCH_FIXTURE:')).slice('BATCH_FIXTURE:'.length));
    }
    await stopServer();
    const prefix = direct ? 'DIRECT_BATCH:' : mode === 'crash' ? 'CRASH_BATCH:' : mode === 'check' ? 'OFFLINE_CHECK:' : 'OFFLINE_BATCH:';
    let queuedResult;
    try {
      queuedResult = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
        direct ? 'scripts/workspace-operation-direct-restart-fixture.ts'
          : mode === 'crash' ? 'scripts/workspace-operation-batch-crash-fixture.ts' : mode === 'check' ? 'scripts/workspace-operation-check-offline-fixture.ts' : 'scripts/workspace-operation-batch-offline-fixture.ts',
        JSON.stringify(direct ? { workspaceId, user, mode } : { workspaceId, user, reviewIds: reviews.map((review) => review.reviewId) })], { cwd, env, timeout: 90_000 });
      if (mode === 'crash') throw new Error('Crash fixture unexpectedly exited normally.');
    } catch (error) {
      if (mode !== 'crash' || error.signal !== 'SIGKILL' || !error.stdout?.includes(prefix)) throw error;
      queuedResult = { stdout: error.stdout };
    }
    const queued = JSON.parse(queuedResult.stdout.split('\n').find((line) => line.startsWith(prefix)).slice(prefix.length));
    if (queued.status !== 'queued') throw new Error('Offline approval was not durably queued.');
    await startServer();
    if (mode === 'check') {
      let ready;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const response = await api.get(`/api/files/operation-reviews/checks/${queued.checkId}`, { headers });
        if (!response.ok()) throw new Error('Restarted check could not be read.');
        const result = await response.json();
        if (result.check.status === 'ready') { ready = result; break; }
        if (['failed', 'blocked'].includes(result.check.status)) throw new Error(`Restarted check ended ${result.check.status}.`);
        await sleep(500);
      }
      if (!ready?.batch) throw new Error('Restarted check did not produce a preview.');
      const source = await api.get('/api/files/read?path=A.md', { headers });
      const destination = await api.get('/api/files/read?path=moved%2FA.md', { headers });
      if (!source.ok() || (await source.json()).data.content !== '# A\n' || destination.status() !== 404) {
        throw new Error('Read-only background check changed workspace files.');
      }
      const accepted = await api.post('/api/files/operation-reviews/batches', { headers,
        data: { action: 'accept', batchId: ready.batch.batchId, planId: ready.batch.planId } });
      if (!accepted.ok()) throw new Error('Restarted check result could not be approved.');
      queued.batchId = ready.batch.batchId;
    }
    let applied;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const response = await api.get(direct ? `/api/files/operations/batches/${queued.batchId}`
        : `/api/files/operation-reviews/batches/${queued.batchId}`, { headers });
      if (!response.ok()) throw new Error('Restarted worker job could not be read.');
      const payload = await response.json();
      const batch = direct ? payload.operation : payload.batch;
      if (direct && batch.status === 'applied') {
        if (payload.linkStatus !== 'complete') throw new Error('Restarted direct job lacks verified link completion.');
        const detailedResponse = await api.get(`/api/files/operation-reviews/batches/${queued.batchId}`, { headers });
        if (!detailedResponse.ok()) throw new Error('Restarted direct job receipts could not be read.');
        const detailed = (await detailedResponse.json()).batch;
        if (detailed.batchId !== batch.batchId || detailed.planId !== batch.planId
          || detailed.execution?.receiptStatus !== 'available' || detailed.execution.mode !== 'apply'
          || detailed.execution.finalization !== 'complete'
          || detailed.execution.steps.length !== batch.totalActions
          || detailed.execution.steps.some((step) => step.state !== 'applied')) {
          throw new Error('Restarted direct job lacks complete physical and link receipts.');
        }
      }
      if (batch.status === 'applied') { applied = batch; break; }
      if (['failed', 'needs_recovery', 'needs_review'].includes(batch.status)) throw new Error(`Restarted worker ended ${batch.status} (${batch.errorCode}).`);
      await sleep(500);
    }
    if (!applied || applied.completedActions !== applied.totalActions) throw new Error('Restarted worker did not finish all recorded steps.');
    const read = async (filePath) => {
      const response = await api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
      if (!response.ok()) throw new Error(`Restart result missing ${filePath}.`);
      return (await response.json()).data.content;
    };
    const valid = mode === 'crash' ? await read('moved/A.txt') === 'A bytes\n' && await read('moved/B.txt') === 'B bytes\n'
      : await read('moved/A.md') === '# A\n' && (direct ? await read('moved/B.md') === '# B\n'
        && await read('index.md') === '[A](moved/A.md) [B](moved/B.md)\n' : await read('index.md') === '[A](moved/A.md) B\n');
    if (!valid) throw new Error('Restart result differs from approved plan.');
    if (direct) {
      const existingReviews = await api.get('/api/files/operation-reviews', { headers });
      if (!existingReviews.ok() || (await existingReviews.json()).reviews.length !== 0) throw new Error('Direct restart created an unexpected review.');
      if (mode === 'queued') {
        const retried = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
          'scripts/workspace-operation-direct-restart-fixture.ts', JSON.stringify({ workspaceId, user, mode })], { cwd, env, timeout: 90_000 });
        const original = JSON.parse(retried.stdout.split('\n').find((line) => line.startsWith(prefix)).slice(prefix.length));
        if (original.batchId !== queued.batchId || original.status !== 'applied') throw new Error('Absent-source direct retry did not retain the original completed job.');
      }
    }
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
    await context.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
    const page = await context.newPage();
    await page.goto(`/en/notebook?workspaceId=${workspaceId}&${direct ? `workspacePathBatch=${queued.batchId}` : `workspaceOperationReview=${reviews[0].reviewId}`}`);
    await page.getByTestId(direct ? 'workspace-path-operation-status' : 'workspace-operation-review-center').waitFor({ state: 'visible' });
    await page.getByText(direct ? 'Files and links updated' : 'File actions completed', { exact: true }).first().waitFor({ state: 'visible' });
    const artifactName = `${direct ? 'direct-' : ''}${mode}`;
    await page.screenshot({ path: path.join(artifacts, `worker-${artifactName}-completed.png`), animations: 'disabled' });
    await fs.writeFile(path.join(artifacts, `worker-${artifactName}.json`), JSON.stringify({ passed: true, authorization: direct ? 'direct' : 'review',
      scenario: mode === 'check' ? 'durable read-only check queued offline, resumed by a fresh process, files unchanged until approval' : mode === 'crash' ? 'SIGKILL after first physical mutation and durable receipt; fresh worker resumes exact remaining steps'
        : direct ? 'direct job queued with reviews disabled; fresh worker updates paths and links; exact retry returns original job'
          : 'durable approval queued without a running worker, executed by a fresh server process',
      completedSteps: applied.completedActions, totalSteps: applied.totalActions }, null, 2));
    console.log(`Real worker process restart (${artifactName}): passed`);
  } finally {
    await browser?.close();
    if (workspaceId && !server) await startServer();
    if (workspaceId && server) await api.delete(`/api/workspaces/${workspaceId}`);
    await api.dispose();
  }
}

async function cleanupDisposableRunWorkspaces() {
  const api = await request.newContext({ baseURL });
  try {
    const signIn = await api.post('/api/auth/sign-in/email', { headers: { Origin: baseURL }, data: {
      email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
    } });
    if (!signIn.ok()) throw new Error('Disposable test cleanup login failed.');
    const response = await api.get('/api/workspaces');
    if (!response.ok()) throw new Error('Could not list disposable test workspaces.');
    const { workspaces } = await response.json();
    for (const workspace of workspaces) {
      if (workspace.type !== 'personal' || !workspace.name.startsWith(`E2E batch review ${runId} `)) continue;
      const removed = await api.delete(`/api/workspaces/${workspace.id}`);
      if (!removed.ok()) throw new Error('Could not remove an owned disposable test workspace.');
    }
  } finally { await api.dispose(); }
}

try {
  try {
    await run(process.execPath, ['scripts/bootstrap-admin.js', '--ensure'], { cwd, env, timeout: 180_000 });
  } catch (error) {
    await fs.writeFile(path.join(artifacts, 'bootstrap-admin.log'), `${error.stdout || ''}\n${error.stderr || ''}`, { mode: 0o600 });
    throw new Error('Isolated E2E bootstrap failed; inspect its private log.');
  }
  await startServer();
  if (!automatic && !attention && !reviewToggle && !directRestart) {
    const admin = await request.newContext({ baseURL });
    try {
      const login = await admin.post('/api/auth/sign-in/email', { headers: { Origin: baseURL }, data: {
        email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
      } });
      if (!login.ok()) throw new Error('Could not prepare the isolated review-enabled regression suite.');
      const enable = await admin.patch('/api/admin/experimental-settings', { data: { documentReviewEnabled: true } });
      if (!enable.ok()) throw new Error('Could not enable reviews in the disposable test instance.');
    } finally { await admin.dispose(); }
  }
  const suiteArgs = ['node_modules/@playwright/test/cli.js', 'test',
    reviewToggle ? 'tests/workspace-operation-review-toggle.spec.ts'
      : attention ? 'tests/workspace-path-operation-notifications.spec.ts'
      : automatic ? 'tests/workspace-operation-automatic.spec.ts' : 'tests/workspace-operation-batches.spec.ts',
    '--workers=1', '--max-failures=1', '--reporter=list'];
  if (process.env.CANVAS_BATCH_E2E_GREP) suiteArgs.push('--grep', process.env.CANVAS_BATCH_E2E_GREP);
  let suiteCode = 0;
  if (!directRestart) {
    const suite = spawn(process.execPath, suiteArgs, { cwd, env, stdio: 'inherit' });
    suiteCode = await new Promise((resolve) => suite.once('exit', (code) => resolve(code ?? 1)));
  }
  if (suiteCode === 0 && !automatic && !attention && !reviewToggle) {
    if (!directRestart) {
      await restartScenario();
      await restartScenario('crash');
      await restartScenario('check');
    }
    await restartScenario('queued', true);
    await restartScenario('crash', true);
  }
  process.exitCode = suiteCode;
} finally {
  try { if (serverReady) await cleanupDisposableRunWorkspaces(); }
  finally {
    try { await stopServer(); }
    finally {
      // Both identifiers are generated above, never accepted from a caller.
      // FORCE closes only lingering test fixture clients in this private DB.
      try { await databaseAdmin.query(`DROP DATABASE "${isolatedDatabase}" WITH (FORCE)`); }
      finally {
        await databaseAdmin.end();
        await fs.rm(isolatedData, { recursive: true, force: true });
      }
    }
  }
}
