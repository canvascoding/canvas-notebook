/** Real OAuth, HTTP MCP and browser checks against the freshly rebuilt managed container.
 * This is not a claim about the hosted ChatGPT connector's schema projection.
 * Run: node --import tsx scripts/mcp-connector-read-search-e2e.mjs
 */
import assert from 'node:assert/strict';
import { verifyCapabilitiesAcceptance } from './mcp-capabilities-acceptance.mjs';
import { verifyManifestAcceptance } from './mcp-manifest-acceptance.mjs';
import { verifyReplaceAcceptance } from './mcp-replace-acceptance.mjs';
import { verifyUploadAcceptance } from './mcp-upload-acceptance.mjs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { chromium, expect } from '@playwright/test';
import { authorizeIngestE2EMcp, requireIngestE2EJson, requireIngestE2ESuccess,
  requireIngestE2EFailure } from './mcp-file-ingest-e2e-helpers.ts';

const baseURL = 'http://127.0.0.1:3100';
const env = parse(await fs.readFile(path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook.env')));
assert.equal(env.BASE_URL, baseURL, 'Use only the managed local test container.');
const runId = randomUUID();
const artifacts = path.resolve('artifacts/mcp-connector', runId);
await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
const owner = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
await owner.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }]);
const steps = [];
let mcp, workspace;
async function step(name, run) {
  const start = Date.now();
  await run();
  steps.push({ name, passed: true, durationMs: Date.now() - start });
  console.log(`PASS ${name}`);
}
const tools = ['auth_probe', 'get_workspace_overview', 'list_workspaces', 'list_knowledge_tree', 'read_knowledge_source',
  'get_knowledge_manifest', 'search_knowledge', 'replace_knowledge_source', 'create_knowledge_source', 'edit_knowledge_source', 'read_knowledge_asset', 'upload_knowledge_asset'];
try {
  await step('real login, workspace opt-in, browser consent and PKCE', async () => {
    await requireIngestE2EJson(await owner.request.post('/api/auth/sign-in/email', {
      headers: { Origin: baseURL }, data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD },
    }), 'Bootstrap login');
    const settings = await requireIngestE2EJson(await owner.request.patch('/api/integrations/mcp-server', {
      data: { enabled: true, tools }, timeout: 90_000,
    }), 'Enable local test tools');
    workspace = (await requireIngestE2EJson(await owner.request.post('/api/workspaces', {
      data: { type: 'personal', name: `MCP connector acceptance ${runId}` }, timeout: 90_000,
    }), 'Create dedicated test workspace')).workspace;
    await requireIngestE2EJson(await owner.request.put('/api/integrations/mcp-server/workspaces', {
      data: { workspaceId: workspace.id, enabled: true },
    }), 'Enable only test workspace');
    mcp = await authorizeIngestE2EMcp(owner, baseURL, workspace.id, settings.data.protocolVersion);
  });
  await step('settings UI shows and persists manifest and replacement controls', async () => {
    const page = await owner.newPage();
    await page.goto('/en/settings?tab=mcp', { waitUntil: 'domcontentloaded', timeout: 120000 });
    const replacement = page.getByRole('switch', { name: 'Replace complete Markdown', exact: true });
    await expect(replacement).toHaveAttribute('aria-checked', 'true', { timeout: 60000 });
    await expect(page.getByRole('switch', { name: 'Read file manifest', exact: true })).toHaveAttribute('aria-checked', 'true');
    for (let index = 0; index < 2; index++) {
      await replacement.click();
      const receipt = page.waitForResponse(response => response.request().method() === 'PATCH'
        && new URL(response.url()).pathname === '/api/integrations/mcp-server');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await requireIngestE2EJson(await receipt, 'Persist capability selection');
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(replacement).toHaveAttribute('aria-checked', 'true', { timeout: 60000 });
    await replacement.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'settings.png') });
    await page.close();
  });
  const call = (name, args) => mcp.call(name, { workspace_id: workspace.id, ...args });
  await step('workspace rights, versions and limits', async () => { await verifyCapabilitiesAcceptance(call); });
  await step('HTTP tools/list exposes every read and search argument at top level', async () => {
    const listed = await mcp.rpc('tools/list');
    for (const [name, keys] of [
      ['read_knowledge_source', ['workspace_id', 'path', 'offset', 'max_characters', 'expected_sha256', 'document_id', 'format', 'max_bytes', 'expected_version', 'cursor', 'include_edit_targets']],
      ['search_knowledge', ['workspace_id', 'query', 'path', 'max_results', 'legacy_cursor', 'api_version', 'cursor']],
    ]) {
      const input = listed.tools.find(tool => tool.name === name).inputSchema;
      assert.equal(input.oneOf, undefined);
      assert.equal(input.anyOf, undefined);
      for (const key of keys) assert.ok(input.properties[key]?.type, `${name}.${key} must retain its type`);
    }
  });
  const marker = `ConnectorAcceptance${runId.replaceAll('-', '')}`;
  const content = `# ${marker}\n\n${('Unicode ÄÖ 😀 ' + marker + '\n').repeat(25)}`;
  const documents = [];
  await step('create two isolated native documents through MCP', async () => {
    for (let index = 0; index < 2; index++) {
      const receipt = requireIngestE2ESuccess(await call('create_knowledge_source', {
        path: `acceptance-${index}.md`, content, idempotency_key: `${runId}-${index}`,
      }), 'Create test document');
      assert.ok(receipt.document_id);
      documents.push(receipt);
    }
  });
  const document = documents[0];
  await step('legacy path read retains workspace and character limits', async () => {
    const page = requireIngestE2ESuccess(await call('read_knowledge_source', {
      path: document.path, offset: 0, max_characters: 37,
    }), 'Legacy read');
    assert.equal(page.content.length, 37);
    assert.equal(page.next_offset, 37);
    assert.match(page.sha256, /^[a-f0-9]{64}$/u);
    const continued = requireIngestE2ESuccess(await call('read_knowledge_source', {
      path: document.path, offset: page.next_offset, max_characters: 37, expected_sha256: page.sha256,
    }), 'Legacy continuation');
    assert.equal(continued.sha256, page.sha256);
    requireIngestE2EFailure(await call('read_knowledge_source', {
      path: document.path, offset: page.next_offset, expected_sha256: '0'.repeat(64),
    }), 'FILE_REVISION_CONFLICT');
  });
  await step('native Markdown format, UTF8 pages and expected version survive HTTP dispatch', async () => {
    let cursor, version, totalBytes, received = 0, text = '';
    for (let count = 0; count < 100; count++) {
      const page = requireIngestE2ESuccess(await call('read_knowledge_source', {
        document_id: document.document_id, format: 'markdown', max_bytes: 256,
        ...(cursor ? { cursor, expected_version: version } : {}),
      }), 'Native page');
      assert.equal(page.format, 'markdown');
      assert.ok(page.byteLength <= 256);
      assert.equal(Buffer.byteLength(page.fragment, 'utf8'), page.byteLength);
      assert.equal(page.byteOffset, received);
      version ??= page.document.version;
      totalBytes ??= page.totalBytes;
      assert.equal(page.document.version, version);
      received += page.byteLength; text += page.fragment; cursor = page.nextCursor;
      if (!cursor) { assert.equal(page.complete, true); break; }
    }
    assert.equal(cursor, null); assert.equal(received, totalBytes);
    assert.ok(text.includes(marker) && text.includes('😀'));
    requireIngestE2EFailure(await call('read_knowledge_source', {
      document_id: document.document_id, expected_version: `canvas-document-v1:${'0'.repeat(64)}`,
    }), 'DOCUMENT_VERSION_CONFLICT');
    const mixed = await call('read_knowledge_source', { document_id: document.document_id, path: document.path });
    assert.equal(mixed.isError, true);
  });
  await step('native search continues without duplicate or missing document IDs', async () => {
    const ids = new Set(); let cursor;
    for (let count = 0; count < 10; count++) {
      const page = requireIngestE2ESuccess(await call('search_knowledge', {
        api_version: 1, query: marker, max_results: 1, ...(cursor ? { cursor } : {}),
      }), 'Native search');
      assert.ok(page.hits.length <= 1);
      for (const hit of page.hits) { assert.ok(!ids.has(hit.document.documentId)); ids.add(hit.document.documentId); }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.deepEqual([...ids].sort(), documents.map(row => row.document_id).sort());
  });
  await step('legacy search and folder list expose usable continuation', async () => {
    for (const name of ['search_knowledge', 'list_knowledge_tree']) {
      const found = new Set(); let cursor;
      for (let index = 0; index < 30; index++) {
        const input = name === 'search_knowledge' ? { query: marker, max_results: 1,
          ...(cursor ? { legacy_cursor: cursor } : {}) } : { max_entries: 1, max_depth: 0, ...(cursor ? { cursor } : {}) };
        const page = requireIngestE2ESuccess(await call(name, input), name);
        for (const row of page.results ?? page.entries) { assert.ok(!found.has(row.path)); found.add(row.path); }
        cursor = name === 'search_knowledge' ? page.next_legacy_cursor : page.next_cursor;
        if (!cursor) break;
      }
      assert.equal(cursor, null);
      for (const row of documents) assert.ok(found.has(row.path));
    }
  });
  await step('binary upload retries, status and original SHA-256', async () => {
    await verifyUploadAcceptance(call, runId, async () => {
      const { stdout } = await promisify(execFile)('docker', ['inspect', '--format', '{{.Config.Image}}', 'canvas-local-prod-notebook']);
      assert.match(stdout.trim(), /^canvas-notebook:mcp-connector-fdd3-/u, 'Never restart another chat test image.');
      await promisify(execFile)('docker', ['restart', 'canvas-local-prod-notebook']);
      await expect.poll(async () => {
        try { return (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(3000) })).ok; }
        catch { return false; }
      }, { timeout: 180000, intervals: [1000, 2000, 5000] }).toBe(true);
    });
  });
  await step('complete Markdown replacement, retry and revision conflict', async () => {
    await verifyReplaceAcceptance(call, document, `${runId}-replace`);
  });
  await step('manifest original-byte hashes, authoritative Markdown and continuation', async () => {
    await verifyManifestAcceptance(call, documents.map(row => row.path));
  });
  await step('direct document link opens the real editor and survives reload', async () => {
    const page = await owner.newPage();
    await page.goto(document.document_url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const views = page.getByRole('group', { name: 'Document view', exact: true });
    await expect(views).toBeVisible({ timeout: 90_000 });
    if (!await page.locator('.tiptap-editor-shell .ProseMirror').isVisible()) {
      await views.getByRole('button', { name: 'Edit', exact: true }).click();
    }
    await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toContainText('Replaced via complete Markdown', { timeout: 90_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toContainText('Replaced via complete Markdown', { timeout: 90_000 });
    await page.screenshot({ path: path.join(artifacts, 'document.png') });
    await page.close();
  });
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ passed: true, runId, workspaceId: workspace.id,
    baseURL, steps, documents: documents.map(row => ({ path: row.path, documentId: row.document_id, documentUrl: row.document_url })),
    evidence: 'Rebuilt managed container, real OAuth/HTTP/browser; local Codex connector verified separately.' }, null, 2));
  console.log(`Evidence: ${artifacts}`);
} catch (error) {
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ passed: false, runId, baseURL,
    workspaceId: workspace?.id, steps, error: error instanceof Error ? error.name : 'UnknownError' }, null, 2));
  throw error;
} finally {
  // Retain the clearly named test workspace for the separate real Codex client
  // check; revoke this script's own OAuth connection, never another connection.
  if (mcp) await mcp.revoke();
  await browser.close();
}
