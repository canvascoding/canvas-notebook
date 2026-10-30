/** Exercise the installed Codex MCP client, without a model turn or a persisted chat.
 * Uses the workspace created by mcp-connector-read-search-e2e.mjs.
 * Run: node --import tsx scripts/mcp-local-codex-client-e2e.mjs <report.json>
 */
import assert from 'node:assert/strict';
import { verifyManifestAcceptance } from './mcp-manifest-acceptance.mjs';
import { verifyReplaceAcceptance } from './mcp-replace-acceptance.mjs';
import { verifyUploadAcceptance } from './mcp-upload-acceptance.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { chromium, expect } from '@playwright/test';
import { parse } from 'dotenv';
import { requireIngestE2EJson } from './mcp-file-ingest-e2e-helpers.ts';

const fixture = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const baseURL = 'http://127.0.0.1:3100';
assert.equal(fixture.baseURL, baseURL);
const env = parse(await fs.readFile(path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook.env')));
const serverName = `canvas_acceptance_${randomUUID().replaceAll('-', '')}`;
// This per-process configuration replaces the server map, never config.toml.
const config = `mcp_servers={${serverName}={url="${baseURL}/mcp",enabled=true}}`;
const app = spawn('codex', ['-c', config, 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let sequence = 0, oauthComplete;
const pending = new Map();
const lines = readline.createInterface({ input: app.stdout });
lines.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const handler = pending.get(message.id); pending.delete(message.id); clearTimeout(handler.timer);
    if (message.error) handler.reject(new Error(`Codex ${handler.method}: ${message.error.message}`));
    else handler.resolve(message.result);
  } else if (message.method === 'mcpServer/oauthLogin/completed') oauthComplete = message.params;
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 180_000);
    pending.set(id, { resolve, reject, timer, method });
    app.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
const browser = await chromium.launch({ headless: true });
const owner = await browser.newContext({ baseURL });
let connectionId;
try {
  await requireIngestE2EJson(await owner.request.post('/api/auth/sign-in/email', {
    headers: { Origin: baseURL }, data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD },
  }), 'Local login');
  const connections = async () => (await requireIngestE2EJson(
    await owner.request.get('/api/integrations/mcp-server/connections'), 'Connections')).data.connections;
  const before = new Set((await connections()).map(row => row.connectionId));
  await rpc('initialize', { clientInfo: { name: 'canvas_mcp_acceptance', title: 'Canvas local MCP acceptance', version: '1.0.0' },
    capabilities: { experimentalApi: true } });
  app.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const login = await rpc('mcpServer/oauth/login', { name: serverName, clientRegistration: 'dcr', timeoutSecs: 180,
    scopes: ['workspace:list', 'knowledge:tree', 'knowledge:read', 'knowledge:search', 'knowledge:write'] });
  const authorization = new URL(login.authorizationUrl);
  assert.equal(authorization.origin, baseURL);
  const page = await owner.newPage();
  await page.goto(authorization.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const accept = page.locator('button[name="accept"][value="true"]');
  await expect(accept).toBeVisible({ timeout: 60_000 }); await accept.click();
  await expect.poll(() => oauthComplete?.success, { timeout: 90_000 }).toBe(true);
  const added = (await connections()).filter(row => !before.has(row.connectionId));
  assert.equal(added.length, 1, 'Bind only the actual new Codex OAuth connection.');
  connectionId = added[0].connectionId;
  await requireIngestE2EJson(await owner.request.put('/api/integrations/mcp-server/connections/workspaces', {
    data: { connectionId, workspaceIds: [fixture.workspaceId] },
  }), 'Grant Codex only the local acceptance workspace');
  await page.close();
  const started = await rpc('thread/start', { cwd: process.cwd(), ephemeral: true });
  const threadId = started.thread.id;
  // No turn/start is issued: only the real MCP client is exercised.
  const listed = await rpc('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
  await fs.writeFile(path.join(path.dirname(process.argv[2]), 'codex-tool-catalog.json'), JSON.stringify(listed, null, 2), { mode: 0o600 });
  const call = (tool, args) => rpc('mcpServer/tool/call', { threadId, server: serverName, tool,
    arguments: { workspace_id: fixture.workspaceId, ...args } });
  const document = fixture.documents[0];
  const legacy = await call('read_knowledge_source', { path: document.path, max_characters: 37 });
  assert.notEqual(legacy.isError, true); assert.equal(legacy.structuredContent.content.length, 37);
  const continuedLegacy = await call('read_knowledge_source', { path: document.path, offset: 37,
    max_characters: 37, expected_sha256: legacy.structuredContent.sha256 });
  assert.notEqual(continuedLegacy.isError, true);
  assert.equal(continuedLegacy.structuredContent.sha256, legacy.structuredContent.sha256);
  const staleLegacy = await call('read_knowledge_source', { path: document.path, offset: 37, expected_sha256: '0'.repeat(64) });
  assert.equal(staleLegacy.isError, true); assert.equal(staleLegacy.structuredContent.code, 'FILE_REVISION_CONFLICT');
  const legacySearch = await call('search_knowledge', { query: 'ConnectorAcceptance', max_results: 1 });
  assert.notEqual(legacySearch.isError, true); assert.ok(legacySearch.structuredContent.next_legacy_cursor);
  const nextLegacySearch = await call('search_knowledge', { query: 'ConnectorAcceptance', max_results: 1,
    legacy_cursor: legacySearch.structuredContent.next_legacy_cursor });
  assert.notEqual(nextLegacySearch.isError, true);
  assert.notEqual(nextLegacySearch.structuredContent.results[0].path, legacySearch.structuredContent.results[0].path);
  const tree = await call('list_knowledge_tree', { max_entries: 1, max_depth: 0 });
  assert.notEqual(tree.isError, true); assert.ok(tree.structuredContent.next_cursor);
  const nextTree = await call('list_knowledge_tree', { max_entries: 1, max_depth: 0, cursor: tree.structuredContent.next_cursor });
  assert.notEqual(nextTree.isError, true); assert.notEqual(nextTree.structuredContent.entries[0].path, tree.structuredContent.entries[0].path);
  const native = await call('read_knowledge_source', { document_id: document.documentId, format: 'markdown', max_bytes: 256 });
  assert.notEqual(native.isError, true); assert.equal(native.structuredContent.format, 'markdown');
  assert.ok(native.structuredContent.byteLength <= 256); assert.ok(native.structuredContent.nextCursor);
  const next = await call('read_knowledge_source', { document_id: document.documentId, format: 'markdown', max_bytes: 256,
    cursor: native.structuredContent.nextCursor, expected_version: native.structuredContent.document.version });
  assert.notEqual(next.isError, true); assert.equal(next.structuredContent.byteOffset, native.structuredContent.byteLength);
  const conflict = await call('read_knowledge_source', { document_id: document.documentId,
    expected_version: `canvas-document-v1:${'0'.repeat(64)}` });
  assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.code, 'DOCUMENT_VERSION_CONFLICT');
  const search = await call('search_knowledge', { api_version: 1, query: 'ConnectorAcceptance', max_results: 1 });
  assert.notEqual(search.isError, true); assert.equal(search.structuredContent.hits.length, 1);
  assert.ok(search.structuredContent.nextCursor);
  const searchedNext = await call('search_knowledge', { api_version: 1, query: 'ConnectorAcceptance', max_results: 1,
    cursor: search.structuredContent.nextCursor });
  assert.notEqual(searchedNext.isError, true);
  assert.notEqual(searchedNext.structuredContent.hits[0].document.documentId, search.structuredContent.hits[0].document.documentId);
  await verifyUploadAcceptance(call, serverName);
  await verifyReplaceAcceptance(call, fixture.documents[1], `${serverName}-replace`);
  await verifyManifestAcceptance(call, fixture.documents.map(row => row.path));
  await fs.writeFile(path.join(path.dirname(process.argv[2]), 'codex-client-report.json'), JSON.stringify({ passed: true,
    client: 'installed codex app-server MCP client', modelTurns: 0, ephemeral: true, workspaceId: fixture.workspaceId,
    checks: ['OAuth DCR/PKCE', 'workspace grant', 'tools/list', 'legacy read', 'native format and byte limit',
      'native read continuation', 'wrong version conflict', 'native search continuation',
      'legacy hash-protected continuation', 'legacy search continuation', 'tree continuation', 'upload retries/status/checksum'],
    limitation: 'Local Codex MCP transport; not the hosted ChatGPT connector schema adapter.' }, null, 2));
  console.log('PASS installed Codex MCP client: OAuth, schema discovery, reads, conflicts and search continuation');
} finally {
  if (connectionId) await owner.request.delete('/api/integrations/mcp-server/connections', { data: { connectionId } });
  await browser.close();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Test closed')); }
  lines.close(); app.stdin.end(); app.kill('SIGTERM');
  await promisify(execFile)('codex', ['-c', config, 'mcp', 'logout', serverName]).catch(() => {});
}
