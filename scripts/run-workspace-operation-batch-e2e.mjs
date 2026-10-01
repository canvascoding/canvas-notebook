/** Managed host E2E: one owned Notebook process, real PostgreSQL, then a real worker restart. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { chromium, request } from '@playwright/test';
import { uploadWorkspaceTextFile } from '../tests/helpers/managed-test-context.ts';

const run = promisify(execFile);
const cwd = process.cwd();
const envFile = process.env.CANVAS_ENV_FILE || path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
const localEnv = parse(await fs.readFile(envFile));
const port = Number(process.env.CANVAS_BATCH_E2E_PORT || 3001);
const baseURL = `http://localhost:${port}`;
const artifacts = path.join(cwd, '.playwright-mcp/file-review-batches');
const runId = randomUUID();
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, ...localEnv, NODE_ENV: 'development', PORT: String(port),
  CANVAS_ENV_FILE: envFile, CANVAS_APP_ROOT: cwd, BASE_URL: baseURL, BETTER_AUTH_BASE_URL: baseURL,
  E2E_EXTERNAL_SERVER: '1', CANVAS_BATCH_E2E_RUN_ID: runId };
if (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) throw new Error('Managed bootstrap credentials required.');
for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', () => reject(new Error(`E2E port ${port} is occupied; no unrelated process was stopped.`)));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});

let server;
let log;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function startServer() {
  log = await fs.open(path.join(artifacts, 'owned-server.log'), 'a', 0o600);
  server = spawn(process.execPath, ['--import', 'tsx', 'server.js'], { cwd, env,
    stdio: ['ignore', log.fd, log.fd] });
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Owned E2E server exited during startup. Inspect its private log.');
    const healthy = await fetch(`${baseURL}/api/health`).then((response) => response.ok).catch(() => false);
    if (healthy) return;
    await sleep(500);
  }
  throw new Error('Owned E2E server did not become ready.');
}
async function stopServer() {
  const child = server;
  server = undefined;
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

async function restartScenario(mode = 'queued') {
  const api = await request.newContext({ baseURL });
  let workspaceId;
  let browser;
  try {
    const signIn = await api.post('/api/auth/sign-in/email', { headers: { Origin: baseURL }, data: {
      email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
    } });
    if (!signIn.ok()) throw new Error(`Restart test login failed (${signIn.status()}).`);
    const { user } = await (await api.get('/api/auth/get-session')).json();
    const created = await api.post('/api/workspaces', { data: { type: 'personal', name: `E2E batch review ${mode === 'crash' ? 'crash' : 'restart'} ${Date.now()}` } });
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
    const proposals = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
      'scripts/workspace-operation-batch-e2e-fixture.ts', JSON.stringify(input)], { cwd, env, timeout: 90_000 });
    const reviews = JSON.parse(proposals.stdout.split('\n').find((line) => line.startsWith('BATCH_FIXTURE:')).slice('BATCH_FIXTURE:'.length));
    await stopServer();
    const prefix = mode === 'crash' ? 'CRASH_BATCH:' : 'OFFLINE_BATCH:';
    let queuedResult;
    try {
      queuedResult = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
        mode === 'crash' ? 'scripts/workspace-operation-batch-crash-fixture.ts' : 'scripts/workspace-operation-batch-offline-fixture.ts',
        JSON.stringify({ workspaceId, user, reviewIds: reviews.map((review) => review.reviewId) })], { cwd, env, timeout: 90_000 });
      if (mode === 'crash') throw new Error('Crash fixture unexpectedly exited normally.');
    } catch (error) {
      if (mode !== 'crash' || error.signal !== 'SIGKILL' || !error.stdout?.includes(prefix)) throw error;
      queuedResult = { stdout: error.stdout };
    }
    const queued = JSON.parse(queuedResult.stdout.split('\n').find((line) => line.startsWith(prefix)).slice(prefix.length));
    if (queued.status !== 'queued') throw new Error('Offline approval was not durably queued.');
    await startServer();
    let applied;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const response = await api.get(`/api/files/operation-reviews/batches/${queued.batchId}`, { headers });
      if (!response.ok()) throw new Error('Restarted worker job could not be read.');
      const { batch } = await response.json();
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
      : await read('moved/A.md') === '# A\n' && await read('index.md') === '[A](moved/A.md) B\n';
    if (!valid) throw new Error('Restart result differs from approved plan.');
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
    await context.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
    const page = await context.newPage();
    await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspaceOperationReview=${reviews[0].reviewId}`);
    await page.getByTestId('workspace-operation-review-center').waitFor({ state: 'visible' });
    await page.getByText('File actions completed', { exact: true }).first().waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(artifacts, `worker-${mode}-completed.png`), animations: 'disabled' });
    await fs.writeFile(path.join(artifacts, `worker-${mode}.json`), JSON.stringify({ passed: true,
      scenario: mode === 'crash' ? 'SIGKILL after first physical mutation and durable receipt; fresh worker resumes exact remaining steps'
        : 'durable approval queued without a running worker, executed by a fresh server process',
      completedSteps: applied.completedActions, totalSteps: applied.totalActions }, null, 2));
    console.log(`Real worker process restart (${mode}): passed`);
  } finally {
    await browser?.close();
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
  await startServer();
  const suite = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
    'tests/workspace-operation-batches.spec.ts', '--workers=1', '--reporter=list'], { cwd, env, stdio: 'inherit' });
  const suiteCode = await new Promise((resolve) => suite.once('exit', (code) => resolve(code ?? 1)));
  await restartScenario();
  await restartScenario('crash');
  process.exitCode = suiteCode;
} finally {
  try { if (server) await cleanupDisposableRunWorkspaces(); }
  finally { await stopServer(); }
}
