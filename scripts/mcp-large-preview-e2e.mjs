/** Real OAuth/HTTP acceptance of a large native workspace on the managed local
 * container. Resumable manifest; only synthetic creates and read-only previews.
 * Run: node --import tsx scripts/mcp-large-preview-e2e.mjs <artifact-directory>
 */
import assert from 'node:assert/strict';
import { previewWithTransientRetries } from './mcp-preview-retry-acceptance.mjs';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { chromium } from '@playwright/test';
import { authorizeIngestE2EMcp, requireIngestE2EJson } from './mcp-file-ingest-e2e-helpers.ts';

const requestedLinks = Number(process.env.CANVAS_MCP_LINKS_PER_DOCUMENT ?? 20);
const expectedPreview = process.env.CANVAS_MCP_EXPECT_PREVIEW ?? 'ready';
assert(Number.isSafeInteger(requestedLinks) && requestedLinks >= 1 && requestedLinks <= 20);
assert(['ready', 'PATH_TOO_LARGE'].includes(expectedPreview));
const baseURL = 'http://127.0.0.1:3100';
const directory = path.resolve(process.argv[2]);
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const manifestPath = path.join(directory, 'large-preview.json');
let report;
try { report = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
report ??= { runId: randomUUID(), baseURL, documents: [], previews: [], passed: false };
assert.equal(report.baseURL, baseURL);
// Old manifests were generated with exactly 20 links. Never silently change a
// resumed fixture to make a previously failing stress case pass.
report.linksPerDocument ??= report.documents.length ? 20 : requestedLinks;
assert.equal(report.linksPerDocument, requestedLinks);
report.expectedPreview = expectedPreview;
report.passed = false;
const save = () => fs.writeFile(manifestPath, JSON.stringify(report, null, 2), { mode: 0o600 });
await save();
const env = parse(await fs.readFile(path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook.env')));
assert.equal(env.BASE_URL, baseURL);
const browser = await chromium.launch({ headless: true });
const owner = await browser.newContext({ baseURL });
let mcp;
const success = response => {
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert(response.structuredContent); return response.structuredContent;
};
try {
  await requireIngestE2EJson(await owner.request.post('/api/auth/sign-in/email', {
    headers: { Origin: baseURL }, data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD },
  }), 'Local bootstrap login');
  const settings = await requireIngestE2EJson(await owner.request.get('/api/integrations/mcp-server'), 'MCP settings');
  if (!report.workspaceId) {
    const created = await requireIngestE2EJson(await owner.request.post('/api/workspaces', {
      data: { type: 'personal', name: `MCP large preview acceptance ${report.runId}` }, timeout: 90000,
    }), 'Create dedicated large test workspace');
    report.workspaceId = created.workspace.id; await save();
  }
  await requireIngestE2EJson(await owner.request.put('/api/integrations/mcp-server/workspaces', {
    data: { workspaceId: report.workspaceId, enabled: true },
  }), 'Enable test workspace');
  mcp = await authorizeIngestE2EMcp(owner, baseURL, report.workspaceId, settings.data.protocolVersion, { registration: report.registration });
  report.registration = mcp.registration; await save();
  const call = (name, args) => mcp.call(name, { ...args, workspace_id: report.workspaceId });
  for (let index = report.documents.length; index < 300; index++) {
    const filePath = `large-preview-${String(index).padStart(4, '0')}.md`;
    const content = `# Synthetic document ${index}\n\n` +
      Array.from({ length: report.linksPerDocument }, (_, paragraph) => `Paragraph ${paragraph}: bounded source inspection with a [reference](large-preview-0000.md).`).join('\n\n') + '\n';
    const args = { api_version: 1, path: filePath, content, idempotency_key: `${report.runId}-${index}` };
    const createRetries = [];
    let response = await call('create_knowledge_source', args);
    for (let retry = 0; response.isError && response.structuredContent?.retryable === true && retry < 20; retry++) {
      createRetries.push({code: response.structuredContent.code, correlationId: response.structuredContent.correlation_id});
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, response.structuredContent.retry_after_ms || 250)));
      response = await call('create_knowledge_source', args);
    }
    const created = success(response);
    const expectedHash = createHash('sha256').update(content).digest('hex');
    const documentId = created.document?.documentId ?? created.document_id;
    assert.equal(typeof documentId, 'string');
    assert(['created', 'already_created', 'stored'].includes(created.outcome));
    if (created.outcome === 'stored') {
      assert.equal(created.storage_status, 'confirmed');
      assert.equal(created.source_sha256, expectedHash);
      assert.equal(success(await call('read_knowledge_source', {path:filePath})).sha256, expectedHash);
    }
    report.documents.push({ path: filePath, documentId, sha256: expectedHash, createRetries });
    await save();
    if ((index + 1) % 10 === 0) console.log(`Created and confirmed ${index + 1}/300 native sources`);
  }
  assert.equal(new Set(report.documents.map(document => document.documentId)).size, 300);
  report.previews = [];
  for (const document of report.documents.slice(1, 7)) {
    const before = success(await call('read_knowledge_source', { path: document.path }));
    assert.equal(before.sha256, document.sha256);
    const started = performance.now();
    const { response, retries } = await previewWithTransientRetries(call, { api_version: 1, action: 'preview', path: document.path });
    let result;
    if (expectedPreview === 'ready') {
      result = success(response);
      assert.equal(result.preview.readiness, 'ready'); assert.equal(result.preview.kind, 'delete');
    } else {
      assert.equal(response.isError, true);
      result = response.structuredContent;
      assert.equal(result.error_code, expectedPreview); assert.equal(result.code, expectedPreview);
      assert.equal(result.phase, 'preview'); assert.equal(result.retryable, false);
      assert.equal(result.storage_status, 'not_applicable'); assert(result.correlation_id);
      assert.equal(result.preview, undefined);
    }
    const durationMs = Math.round(performance.now() - started);
    const after = success(await call('read_knowledge_source', { path: document.path }));
    assert.equal(after.sha256, document.sha256);
    report.previews.push({ path: document.path, durationMs, outcome: expectedPreview, planId: result.preview?.planId, correlationId: result.correlation_id, retries, unchanged: true });
    await save(); console.log(`PASS ${expectedPreview} large-workspace preview ${document.path}: ${durationMs}ms`);
  }
  report.passed = true; await save();
} finally {
  if (mcp) await mcp.revoke();
  await browser.close();
}
