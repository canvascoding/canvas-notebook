/** Real OAuth/MCP/editor acceptance on one owned host and a disposable managed PostgreSQL database. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { chromium, expect } from '@playwright/test';
import {
  authorizeIngestE2EMcp, inspectIngestE2EEditor, openIngestE2EEditor,
  requireIngestE2EFailure, requireIngestE2EJson, requireIngestE2ESuccess,
} from './mcp-file-ingest-e2e-helpers.ts';

const exec = promisify(execFile);
const cwd = process.cwd();
const runId = randomUUID();
const envFile = process.env.CANVAS_ENV_FILE || path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
const localEnv = parse(await fs.readFile(envFile));
const port = 3000;
const baseURL = `http://127.0.0.1:${port}`;
const artifactDirectory = path.join(cwd, 'artifacts', 'mcp-file-ingest-e2e', runId);
const isolatedDatabase = `canvas_mcp_file_e2e_${runId.replaceAll('-', '')}`;
assert.match(isolatedDatabase, /^canvas_mcp_file_e2e_[a-f0-9]{32}$/u);
const managedURL = new URL(localEnv.DATABASE_URL || '');
assert.ok(['postgres:', 'postgresql:'].includes(managedURL.protocol)
  && ['localhost', '127.0.0.1'].includes(managedURL.hostname)
  && managedURL.port === '55433' && managedURL.pathname === '/canvas_notebook',
'E2E requires the existing managed loopback PostgreSQL service on 55433/canvas_notebook.');
assert.ok(localEnv.BOOTSTRAP_ADMIN_EMAIL && localEnv.BOOTSTRAP_ADMIN_PASSWORD,
  'Private managed bootstrap credentials must be configured.');
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', () => reject(new Error('Port 3000 is occupied; its process was preserved.')));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
// Inventory is read-only. The runner never builds, stops or starts a container.
const { stdout: stackInventory } = await exec('docker', ['ps', '--filter', 'label=io.canvas.local-prod=true', '--format', '{{.Names}}']);
const stackNames = stackInventory.trim().split('\n').filter(Boolean);
assert.ok(stackNames.includes('canvas-local-prod-postgres'), 'The managed PostgreSQL container must already be running.');
assert.equal(stackNames.filter(name => name === 'canvas-local-prod-notebook').length, 1,
  'Exactly one managed Notebook container must be present.');
assert.ok(stackNames.every(name => ['canvas-local-prod-postgres', 'canvas-local-prod-notebook',
  'canvas-local-prod-control-plane-api', 'canvas-local-prod-control-plane-web'].includes(name)),
'Unexpected Canvas test stack; inspect it before starting this owned host.');

const tools = ['auth_probe', 'list_workspaces', 'list_knowledge_tree', 'read_knowledge_source',
  'read_knowledge_asset', 'create_knowledge_source', 'import_knowledge_file', 'upload_knowledge_asset'];
const isolatedData = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-file-e2e-'));
await fs.chmod(isolatedData, 0o700);
await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
const databaseURL = new URL(managedURL);
databaseURL.pathname = `/${isolatedDatabase}`;
const env = { ...process.env, ...localEnv, NODE_ENV: 'development', PORT: String(port), HOSTNAME: '127.0.0.1',
  CANVAS_ENV_FILE: envFile, CANVAS_APP_ROOT: cwd, CANVAS_DEV_BUNDLER: 'webpack',
  BASE_URL: baseURL, BETTER_AUTH_BASE_URL: baseURL, DATABASE_URL: databaseURL.href,
  DATA: isolatedData, CANVAS_DATA_ROOT: isolatedData, CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'false',
  CANVAS_DEPLOYMENT_MODE: 'community', CANVAS_TEAM_FEATURES_ENABLED: 'false',
  ONBOARDING: 'false', CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_TOOLS: tools.join(','),
  E2E_EXTERNAL_SERVER: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=4096`.trim() };
for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
const credentialValues = Object.entries(env).filter(([key, value]) => value
  && /PASSWORD|SECRET|TOKEN|BOOTSTRAP_ADMIN_EMAIL|DATABASE_URL/u.test(key)).map(([, value]) => value);
function safeDiagnostic(value) {
  let message = String(value);
  for (const credential of credentialValues) message = message.replaceAll(credential, '[redacted]');
  return message
    .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer [redacted]')
    .replace(/((?:https?:\/\/|\/)[^\s?#"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')
    .replace(/((?:access_token|refresh_token|code_verifier|client_secret|authorization_code)\s*[=:]\s*)[^\s,"']+/giu, '$1[redacted]');
}
const databaseAdmin = new Client({ connectionString: managedURL.href });
let databaseCreated = false;
let adminConnected = false;
let fixtureDatabase;
let server;
let serverLog;
let browser;
let owner;
let mcp;
let cleanupPromise;
const steps = [];
const receipts = [];
const startedAt = new Date().toISOString();
const report = { runId, startedAt, passed: false, evidence: {
  runtime: 'current checkout, owned webpack host, disposable database on existing managed PostgreSQL',
  oauth: 'real Better Auth login, public registration, browser consent, authorization code and PKCE',
  hostAttachment: 'real HTTPS import adapter using immutable primary public fixture; actual ChatGPT file-reference mediation is outside this test',
  originalByteCases: 'BOM/CRLF/source-only original cases are covered by the focused validation/storage tests',
  containersBuilt: false, traceRecorded: false, videoRecorded: false,
}, steps, receipts };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function step(name, work) {
  console.log(`[mcp-file-e2e] ${name}`);
  const started = Date.now();
  try {
    const detail = await work();
    steps.push({ name, passed: true, durationMs: Date.now() - started, ...(detail ? { detail } : {}) });
  } catch (error) {
    steps.push({ name, passed: false, durationMs: Date.now() - started, error: safeDiagnostic(error.message) });
    throw error;
  }
}
async function startServer() {
  serverLog = await fs.open(path.join(artifactDirectory, 'owned-server.log'), 'a', 0o600);
  server = spawn(process.execPath, ['--import', 'tsx', 'server.js'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '';
  const writeLog = chunk => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) void serverLog?.write(`${safeDiagnostic(line)}\n`).catch(() => undefined);
  };
  server.stdout.on('data', writeLog);
  server.stderr.on('data', writeLog);
  server.once('close', () => { if (pending) void serverLog?.write(`${safeDiagnostic(pending)}\n`).catch(() => undefined); });
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Owned host exited during startup; inspect its redacted private log.');
    const healthy = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(15_000) })
      .then(response => response.ok).catch(() => false);
    if (healthy) return;
    await delay(500);
  }
  throw new Error('Owned current-code host did not become ready.');
}
async function stopServer() {
  const child = server;
  server = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 80 && child.exitCode === null && child.signalCode === null; attempt++) await delay(250);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('close', resolve));
    }
  }
  await serverLog?.close();
  serverLog = undefined;
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await owner?.close().catch(() => undefined);
    owner = undefined;
    await browser?.close().catch(() => undefined);
    browser = undefined;
    await stopServer();
    await fixtureDatabase?.end();
    fixtureDatabase = undefined;
    try {
      if (databaseCreated) await databaseAdmin.query(`DROP DATABASE "${isolatedDatabase}" WITH (FORCE)`);
      databaseCreated = false;
    } finally {
      if (adminConnected) await databaseAdmin.end();
      adminConnected = false;
      await fs.rm(isolatedData, { recursive: true, force: true });
    }
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let workspace;
let deniedWorkspace;
const physical = filePath => {
  assert.ok(workspace?.rootRelativePath, 'Test workspace must provide its managed root relative path.');
  const root = path.resolve(isolatedData, workspace.rootRelativePath);
  assert.ok(root.startsWith(`${isolatedData}${path.sep}`), 'Workspace fixture must stay in disposable DATA.');
  const target = path.resolve(root, filePath);
  assert.ok(target.startsWith(`${root}${path.sep}`), 'Physical assertions use only fixture paths inside the workspace.');
  return target;
};
async function noFile(filePath) {
  await assert.rejects(fs.stat(physical(filePath)), error => error.code === 'ENOENT');
}
async function readText(filePath) {
  return requireIngestE2EJson(await owner.request.get('/api/files/read', {
    headers: { 'x-canvas-workspace-id': workspace.id }, params: { path: filePath }, timeout: 180_000,
  }), 'Read the test file');
}
async function history(filePath) {
  return requireIngestE2EJson(await owner.request.post('/api/files/version-center/v1/resolve', {
    headers: { 'x-canvas-workspace-id': workspace.id, 'x-canvas-version-history-provenance': '1' },
    data: { contractVersion: 1, target: { kind: 'path', workspaceId: workspace.id, pathHint: filePath },
      initialView: 'history', source: 'file_browser' }, timeout: 90_000,
  }), 'Read actual public version history');
}
async function verifyReceipt(receipt, bytes) {
  assert.equal(receipt.status, 'created');
  assert.equal(receipt.workspace_id, workspace.id);
  assert.equal(receipt.sha256, hash(bytes));
  assert.equal(receipt.size, bytes.length);
  assert.deepEqual(await fs.readFile(physical(receipt.path)), bytes);
  const current = await readText(receipt.path);
  assert.equal(current.data.stats.sha256, receipt.sha256);
  const timeline = await history(receipt.path);
  assert.ok(timeline.entries.some(entry => entry.kind === 'revision'
    && entry.revisionId === receipt.revision_id && entry.source === 'external_import'),
  'The real timeline must retain the exact external import revision.');
  const versions = await fixtureDatabase.query(`SELECT revisions.id, revisions.content_hash, contents.source
    FROM file_revisions revisions JOIN file_revision_contents contents ON contents.revision_id = revisions.id
    WHERE revisions.workspace_id=$1 AND revisions.path=$2 AND contents.source='external_import'`, [workspace.id, receipt.path]);
  assert.equal(versions.rows.length, 1);
  assert.equal(versions.rows[0].id, receipt.revision_id);
  assert.equal(versions.rows[0].content_hash, receipt.sha256);
  receipts.push({ path: receipt.path, sha256: receipt.sha256, size: receipt.size,
    revision_id: receipt.revision_id, operation_id: receipt.operation_id,
    markdown: receipt.markdown, warnings: receipt.warnings });
}

try {
  await step('prepare disposable database and bootstrap through the normal runtime', async () => {
    await databaseAdmin.connect();
    adminConnected = true;
    await databaseAdmin.query(`CREATE DATABASE "${isolatedDatabase}"`);
    databaseCreated = true;
    try {
      const result = await exec(process.execPath, ['scripts/bootstrap-admin.js', '--ensure'], { cwd, env, timeout: 180_000 });
      await fs.writeFile(path.join(artifactDirectory, 'bootstrap.log'), safeDiagnostic(`${result.stdout}\n${result.stderr}`), { mode: 0o600 });
    } catch (error) {
      await fs.writeFile(path.join(artifactDirectory, 'bootstrap.log'), safeDiagnostic(`${error.stdout || ''}\n${error.stderr || ''}`), { mode: 0o600 });
      throw new Error('Normal bootstrap failed; inspect the redacted private bootstrap log.');
    }
    fixtureDatabase = new Client({ connectionString: databaseURL.href });
    await fixtureDatabase.connect();
    await startServer();
  });
  await step('log in with the managed identity and explicitly enable fixture capabilities', async () => {
    browser = await chromium.launch({ headless: true,
      ...(process.env.CANVAS_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.CANVAS_PLAYWRIGHT_EXECUTABLE } : {}) });
    owner = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
    await requireIngestE2EJson(await owner.request.post('/api/auth/sign-in/email', {
      headers: { Origin: baseURL }, data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD },
      timeout: 180_000,
    }), 'Normal Better Auth sign-in');
    const session = await requireIngestE2EJson(await owner.request.get('/api/auth/get-session'), 'Validate bootstrap session');
    assert.ok(session.user?.id, 'The authenticated session must identify the real bootstrap user.');
    await requireIngestE2EJson(await owner.request.patch('/api/admin/experimental-settings', {
      data: { documentReviewEnabled: true }, timeout: 90_000,
    }), 'Enable real history surfaces in disposable instance');
    const settings = await requireIngestE2EJson(await owner.request.patch('/api/integrations/mcp-server', {
      data: { enabled: true, tools }, timeout: 90_000,
    }), 'Explicitly enable the implemented MCP capabilities');
    const createWorkspace = async name => (await requireIngestE2EJson(await owner.request.post('/api/workspaces', {
      data: { type: 'personal', name }, timeout: 90_000,
    }), 'Create owned disposable workspace')).workspace;
    workspace = await createWorkspace(`MCP import E2E ${runId}`);
    deniedWorkspace = await createWorkspace(`MCP ungranted E2E ${runId}`);
    for (const item of [workspace, deniedWorkspace]) await requireIngestE2EJson(
      await owner.request.put('/api/integrations/mcp-server/workspaces', { data: { workspaceId: item.id, enabled: true } }),
      'Opt in an owned disposable workspace');
    mcp = await authorizeIngestE2EMcp(owner, baseURL, workspace.id, settings.data.protocolVersion);
    const discovered = await mcp.rpc('server/discover');
    assert.ok(discovered.supportedVersions.includes(settings.data.protocolVersion));
  });
  await step('discover full upload arguments and host file input metadata over authenticated MCP', async () => {
    const listing = await mcp.rpc('tools/list');
    for (const name of tools) assert.ok(listing.tools.some(tool => tool.name === name), `Missing enabled MCP tool ${name}`);
    const upload = listing.tools.find(tool => tool.name === 'upload_knowledge_asset');
    for (const field of ['operation', 'workspace_id', 'path', 'size', 'sha256', 'upload_id', 'offset', 'data_base64']) {
      assert.ok(upload.inputSchema.properties[field], `Upload argument ${field} must be visible at top level.`);
    }
    assert.equal(upload.inputSchema.oneOf, undefined);
    const imported = listing.tools.find(tool => tool.name === 'import_knowledge_file');
    assert.deepEqual(imported._meta['openai/fileParams'], ['file']);
    assert.ok(imported.inputSchema.properties.file.properties.download_url);
    const allowed = requireIngestE2ESuccess(await mcp.call('list_workspaces', {}), 'List OAuth-granted workspaces');
    assert.ok(allowed.workspaces.some(item => item.workspace_id === workspace.id || item.id === workspace.id));
    assert.ok(!allowed.workspaces.some(item => item.workspace_id === deniedWorkspace.id || item.id === deniedWorkspace.id));
  });
  const markdown = ['---', 'title: MCP acceptance document', 'tags:', '  - type/report', '  - topic/mcp', '---', '',
    '# MCP acceptance document', '', 'A **bold** paragraph with [a link](https://example.com).', '',
    '- First item', '- Second item', '', '- [ ] Unfinished task', '- [x] Finished task', '',
    '| Name | Value |', '| --- | --- |', '| Canvas | Notebook |', '',
    '```typescript', 'const title = "Canvas";', '```', '',
    '> [!note] Original callout', '> Original content is preserved.', '',
    'Inline math: $E = mc^2$.', '', '$$', '\\int_0^1 x^2 \\, dx = \\frac{1}{3}', '$$', '',].join('\n');
  const createdArgs = { workspace_id: workspace.id, path: 'notes/created.md', content: markdown,
    idempotency_key: `create-${runId}` };
  let created;
  await step('create complete complex Markdown and verify bytes, hash, durable receipt and history', async () => {
    created = requireIngestE2ESuccess(await mcp.call('create_knowledge_source', createdArgs), 'Create Markdown');
    assert.notEqual(created.markdown?.mode, 'source', 'The supplied normal Markdown must support the rich editor.');
    await verifyReceipt(created, Buffer.from(markdown));
    const journal = path.join(isolatedData, 'system/mcp-file-ingest', `${created.operation_id}.json`);
    assert.equal((await fs.stat(journal)).mode & 0o777, 0o600);
  });
  await step('reject malformed generated metadata, overwrites, stale retry keys and unauthorized workspace', async () => {
    requireIngestE2EFailure(await mcp.call('create_knowledge_source', { ...createdArgs,
      path: 'notes/invalid.md', content: '---\ntitle: [\n---\n# Invalid\n', idempotency_key: `invalid-${runId}` }), 'invalid_frontmatter');
    await noFile('notes/invalid.md');
    requireIngestE2EFailure(await mcp.call('create_knowledge_source', { ...createdArgs,
      content: '# Overwrite attempt\n', idempotency_key: `overwrite-${runId}` }), 'MCP_INGEST_PATH_EXISTS');
    requireIngestE2EFailure(await mcp.call('create_knowledge_source', { ...createdArgs,
      content: '# Different request\n' }), 'MCP_INGEST_IDEMPOTENCY_CONFLICT');
    requireIngestE2EFailure(await mcp.call('create_knowledge_source', { ...createdArgs,
      workspace_id: deniedWorkspace.id, path: 'denied.md', idempotency_key: `denied-${runId}` }), 'MCP_INGEST_AUTHORITY_CHANGED');
    for (const filePath of ['../outside.md', '.private.md', 'notes/.private/file.md']) {
      requireIngestE2EFailure(await mcp.call('create_knowledge_source', { ...createdArgs,
        path: filePath, idempotency_key: `traversal-${randomUUID()}` }));
    }
    assert.deepEqual(await fs.readFile(physical(createdArgs.path)), Buffer.from(markdown));
    const retry = requireIngestE2ESuccess(await mcp.call('create_knowledge_source', createdArgs), 'Exact create retry');
    assert.equal(retry.status, 'already_created');
    assert.equal(retry.revision_id, created.revision_id);
    assert.equal(retry.operation_id, created.operation_id);
  });
  await step('open created Markdown in the actual editor, render its syntax and reload', async () => {
    const page = await owner.newPage();
    try {
      const editor = await openIngestE2EEditor(page, workspace.id, createdArgs.path);
      await expect(editor).toContainText('MCP acceptance document');
      const parsed = await inspectIngestE2EEditor(page);
      for (const type of ['heading', 'bulletList', 'taskList', 'table', 'codeBlock', 'canvasCallout', 'inlineMath', 'blockMath']) {
        assert.ok(parsed.nodeTypes.includes(type), `Markdown must parse into a real ${type} editor node.`);
      }
      assert.ok(parsed.markTypes.includes('bold'));
      await expect(editor.locator('table')).toContainText('Notebook');
      await expect(editor.locator('[data-type="canvas-callout"]')).toContainText('Original content is preserved.');
      assert.ok(await page.locator('.katex').count(), 'Math must actually render through KaTeX.');
      await page.screenshot({ path: path.join(artifactDirectory, 'created-markdown-editor.png'), animations: 'disabled' });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true', { timeout: 90_000 });
      const reopened = await inspectIngestE2EEditor(page);
      assert.deepEqual(reopened.json, parsed.json);
      await page.screenshot({ path: path.join(artifactDirectory, 'created-markdown-reloaded.png'), animations: 'disabled' });
      await fs.writeFile(path.join(artifactDirectory, 'created-editor-tree.json'), JSON.stringify(parsed.json, null, 2), { mode: 0o600 });
    } finally { await page.close(); }
  });
  const remoteUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
  let importedArgs;
  let imported;
  let originalBytes;
  await step('import original Markdown through real public HTTPS and verify original bytes', async () => {
    const response = await fetch(remoteUrl, { signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `Immutable primary fixture: HTTP ${response.status}`);
    originalBytes = Buffer.from(await response.arrayBuffer());
    assert.ok(originalBytes.length > 0 && originalBytes.length < 10_000);
    importedArgs = { workspace_id: workspace.id, path: 'notes/original-mcp-readme.md',
      file: { download_url: remoteUrl, file_id: 'primary-mcp-readme-c518f7a9', file_name: 'README.md', mime_type: 'text/markdown' },
      idempotency_key: `import-${runId}` };
    imported = requireIngestE2ESuccess(await mcp.call('import_knowledge_file', importedArgs), 'Import complete original Markdown');
    await verifyReceipt(imported, originalBytes);
    const journalText = await fs.readFile(path.join(isolatedData, 'system/mcp-file-ingest', `${imported.operation_id}.json`), 'utf8');
    assert.ok(!journalText.includes(remoteUrl), 'The durable journal must not retain download capability URLs.');
    const retry = requireIngestE2ESuccess(await mcp.call('import_knowledge_file', { ...importedArgs,
      file: { ...importedArgs.file, download_url: 'https://127.0.0.1:1/expired-reference' } }), 'Completed import retry');
    assert.equal(retry.status, 'already_created', 'Completed imports must succeed without re-downloading an expired or unsafe replacement URL.');
    assert.equal(retry.revision_id, imported.revision_id);
    return { source: 'immutable official MCP README', sha256: hash(originalBytes), size: originalBytes.length };
  });
  await step('open imported original Markdown in the real editor and preserve reload content', async () => {
    const page = await owner.newPage();
    try {
      const editor = await openIngestE2EEditor(page, workspace.id, importedArgs.path);
      await expect(editor).toContainText('Model Context Protocol (MCP)');
      const parsed = await inspectIngestE2EEditor(page);
      assert.ok(parsed.nodeTypes.includes('heading'));
      assert.ok(parsed.nodeTypes.includes('bulletList'));
      await page.screenshot({ path: path.join(artifactDirectory, 'imported-original-editor.png'), animations: 'disabled' });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toBeVisible({ timeout: 90_000 });
      assert.deepEqual((await inspectIngestE2EEditor(page)).json, parsed.json);
      assert.deepEqual(await fs.readFile(physical(importedArgs.path)), originalBytes);
    } finally { await page.close(); }
  });
  await step('reject HTTP and private-network file references without publishing', async () => {
    for (const [name, url] of [['http', 'http://example.com/file.md'], ['private', 'https://127.0.0.1:1/private.md']]) {
      const filePath = `notes/blocked-${name}.md`;
      const rejected = await mcp.call('import_knowledge_file', { workspace_id: workspace.id, path: filePath,
        file: { download_url: url, file_id: `blocked-${name}` }, idempotency_key: `blocked-${name}-${runId}` });
      requireIngestE2EFailure(rejected, name === 'http' ? 'unsafe_download_url' : 'download_failed');
      await noFile(filePath);
    }
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQ6n72H4QZYAwAVrYKSRRAII4AAAAASUVORK5CYII=', 'base64');
  await step('upload a PNG through begin, ordered chunks and complete; verify SHA-256 and image read', async () => {
    const beginArgs = { operation: 'begin', workspace_id: workspace.id, path: 'assets/upload.png',
      size: png.length, mime_type: 'image/png', sha256: hash(png) };
    const started = requireIngestE2ESuccess(await mcp.call('upload_knowledge_asset', beginArgs), 'Start binary upload');
    const split = 32;
    for (const [offset, bytes] of [[0, png.subarray(0, split)], [split, png.subarray(split)]]) {
      const chunk = requireIngestE2ESuccess(await mcp.call('upload_knowledge_asset', {
        operation: 'chunk', workspace_id: workspace.id, upload_id: started.upload_id, offset,
        data_base64: bytes.toString('base64'),
      }), 'Send ordered binary chunk');
      assert.equal(chunk.next_offset, offset + bytes.length);
    }
    const completeArgs = { operation: 'complete', workspace_id: workspace.id, upload_id: started.upload_id };
    const completed = requireIngestE2ESuccess(await mcp.call('upload_knowledge_asset', completeArgs), 'Verify and publish binary upload');
    assert.equal(completed.after_sha256, hash(png));
    assert.deepEqual(await fs.readFile(physical(beginArgs.path)), png);
    const assetResult = await mcp.call('read_knowledge_asset', { workspace_id: workspace.id, path: beginArgs.path });
    const asset = requireIngestE2ESuccess(assetResult, 'Read uploaded image');
    assert.equal(asset.sha256, hash(png));
    assert.equal(asset.mime_type, 'image/png');
    assert.ok(assetResult.content.some(item => item.type === 'image'), 'Image context must be delivered over MCP.');
    const repeated = requireIngestE2ESuccess(await mcp.call('upload_knowledge_asset', completeArgs), 'Repeat completed binary upload');
    assert.equal(repeated.already_completed, true);
    receipts.push({ path: beginArgs.path, sha256: completed.after_sha256, size: png.length, binary: true });
  });
  await step('reject a binary upload with a wrong declared hash without publishing', async () => {
    const filePath = 'assets/wrong-hash.png';
    const started = requireIngestE2ESuccess(await mcp.call('upload_knowledge_asset', {
      operation: 'begin', workspace_id: workspace.id, path: filePath, size: png.length, mime_type: 'image/png', sha256: '0'.repeat(64),
    }), 'Prepare incorrect hash fixture');
    requireIngestE2ESuccess(await mcp.call('upload_knowledge_asset', { operation: 'chunk', workspace_id: workspace.id,
      upload_id: started.upload_id, offset: 0, data_base64: png.toString('base64') }), 'Send fixture bytes');
    requireIngestE2EFailure(await mcp.call('upload_knowledge_asset', {
      operation: 'complete', workspace_id: workspace.id, upload_id: started.upload_id,
    }));
    await noFile(filePath);
  });
  await step('restart the owned server and prove durable create/import retry without duplicate history', async () => {
    await stopServer();
    await startServer();
    const retryCreated = requireIngestE2ESuccess(await mcp.call('create_knowledge_source', createdArgs), 'Retry creation after real restart');
    assert.equal(retryCreated.status, 'already_created');
    assert.equal(retryCreated.revision_id, created.revision_id);
    const retryImported = requireIngestE2ESuccess(await mcp.call('import_knowledge_file', { ...importedArgs,
      file: { ...importedArgs.file, download_url: 'https://127.0.0.1:1/expired-after-restart' } }), 'Retry original import after real restart');
    assert.equal(retryImported.status, 'already_created');
    assert.equal(retryImported.revision_id, imported.revision_id);
    for (const receipt of [created, imported]) {
      const count = await fixtureDatabase.query(`SELECT count(*)::int AS count FROM file_revision_contents
        WHERE workspace_id=$1 AND revision_id=$2 AND source='external_import'`, [workspace.id, receipt.revision_id]);
      assert.equal(count.rows[0].count, 1);
    }
    assert.deepEqual(await fs.readFile(physical(importedArgs.path)), originalBytes);
  });
  await step('revoked OAuth connection cannot publish a new document', async () => {
    await mcp.revoke();
    const filePath = 'notes/revoked.md';
    const rejected = await mcp.call('create_knowledge_source', { workspace_id: workspace.id, path: filePath,
      content: '# Revoked grant\n', idempotency_key: `revoked-${runId}` });
    requireIngestE2EFailure(rejected);
    await noFile(filePath);
  });
  report.passed = true;
} catch (error) {
  report.error = safeDiagnostic(error.message);
  console.error(`[mcp-file-e2e] Failed: ${report.error}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) {
    report.cleanupError = safeDiagnostic(error.message);
    report.passed = false;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  report.cleanup = { ownedHostStopped: !server, disposableDatabaseDropped: !databaseCreated, disposableDataRemoved: true };
  await fs.writeFile(path.join(artifactDirectory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`[mcp-file-e2e] ${report.passed ? 'Passed' : 'Failed'} ${steps.filter(item => item.passed).length}/${steps.length} steps; report: ${path.relative(cwd, artifactDirectory)}/report.json`);
}
