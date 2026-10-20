import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { requireIngestE2EJson, requireIngestE2ESuccess, requireIngestE2EFailure } from './mcp-file-ingest-e2e-helpers.ts';

export async function runMcpTreeLinksE2E({ owner, browser, mcp, workspace, deniedWorkspace,
  baseURL, physical, step, runId, artifactDirectory, email, password, fixtureDatabase }) {
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const call = (tool, args) => mcp.call(tool, { workspace_id: workspace.id, ...args });
  const success = async (tool, args) => requireIngestE2ESuccess(await call(tool, args), tool);
  const create = (filePath, content, suffix) => success('create_knowledge_source', {
    path: filePath, content, idempotency_key: `${runId}-${suffix}`,
  });
  const text = result => result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || '';
  const checkLink = (receipt, filePath, document = false) => {
    const url = new URL(receipt.document_url);
    assert.equal(url.origin, baseURL);
    assert.equal(url.pathname, '/notebook');
    assert.equal(url.searchParams.get('workspaceId'), workspace.id);
    assert.equal(url.searchParams.get('path'), filePath);
    assert.equal(url.searchParams.get('documentId'), receipt.document_id);
    assert.equal(url.searchParams.get('lineageId'), receipt.lineage_id);
    if (document) assert.ok(receipt.document_id);
    assert.ok(receipt.lineage_id);
    return url.href;
  };
  const location = async (receipt, workspaceId = workspace.id) => owner.request.get('/api/files/location', {
    params: { workspaceId, ...(receipt.document_id ? { documentId: receipt.document_id } : {}),
      ...(receipt.lineage_id ? { lineageId: receipt.lineage_id } : {}) }, timeout: 90_000,
  });
  const screenshot = async (page, name) => {
    const viewport = page.viewportSize();
    assert.ok(viewport);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
    await page.screenshot({ path: path.join(artifactDirectory, name), fullPage: false, animations: 'disabled' });
  };
  const showDocument = async (page, href, marker) => {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    const views = page.getByRole('group', { name: 'Document view', exact: true });
    await expect(views).toBeVisible({ timeout: 90_000 });
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    if (!await editor.isVisible()) await views.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 90_000 });
    await expect(editor).toContainText(marker, { timeout: 90_000 });
    return editor;
  };
  const waitOperation = async response => {
    if (!response.ok()) {
      const detail = await response.json();
      throw new Error(`Managed file operation HTTP ${response.status()}: ${JSON.stringify(detail)}`);
    }
    const payload = await requireIngestE2EJson(response, 'Managed file operation');
    const identity = payload.operation ?? payload.data?.operation;
    assert.ok(identity, 'A file action must return its durable operation identity.');
    if (identity && ['queued', 'applying'].includes(identity.status)) {
      await expect.poll(async () => {
        const polled = await requireIngestE2EJson(await owner.request.get(`/api/files/operations/batches/${identity.batchId}`, { headers }), 'Poll file action');
        return polled.operation?.status ?? polled.data?.operation?.status ?? polled.data?.status;
      }, { timeout: 90_000 }).toBe('applied');
    } else if (identity) assert.equal(identity.status, 'applied');
    return payload;
  };
  const contexts = [];
  const waitEditorsReleased = async documentId => {
    await expect.poll(async () => Number((await fixtureDatabase.query(
      `SELECT count(*) AS count FROM collaboration_yjs_states WHERE document_id=$1
        AND (room_owner_token IS NOT NULL OR room_owner_backend_pid IS NOT NULL OR room_owner_backend_start IS NOT NULL)`,
      [documentId])).rows[0].count), { timeout: 90_000, intervals: [100, 250, 500, 1000] }).toBe(0);
  };
  await owner.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }]);
  let firstCursor;
  let created;
  let image;
  let diagram;
  try {
    await step('page all 601 siblings through OAuth MCP and expand an 18-level tree', async () => {
      const deep = Array.from({ length: 18 }, (_, index) => `level-${index}`).join('/');
      await fs.mkdir(physical(`tree/${deep}`), { recursive: true });
      await fs.mkdir(physical('tree/empty'), { recursive: true });
      await fs.writeFile(physical(`tree/${deep}/deep.md`), '# Deep leaf');
      await fs.writeFile(physical('tree/.private'), 'excluded');
      await Promise.all(Array.from({ length: 601 }, (_, index) => fs.writeFile(
        physical(`tree/file-${String(index).padStart(4, '0')}.md`), '# Tree fixture')));
      const entries = [];
      let cursor;
      do {
        const raw = await call('list_knowledge_tree', { path: 'tree', max_depth: 0, max_entries: 37, ...(cursor ? { cursor } : {}) });
        const page = requireIngestE2ESuccess(raw, 'Tree page');
        assert.ok(page.entries.length <= 37);
        assert.equal(page.has_more, page.next_cursor !== null);
        assert.equal(page.truncated_by_depth, true);
        assert.match(text(raw), /file-/);
        assert.ok(!text(raw).includes('.private'));
        if (!firstCursor) firstCursor = page.next_cursor;
        entries.push(...page.entries);
        cursor = page.next_cursor;
      } while (cursor);
      assert.equal(entries.length, 603);
      assert.equal(new Set(entries.map(entry => entry.path)).size, 603);
      let directory = 'tree/level-0';
      for (let index = 1; index < 18; index++) {
        const page = await success('list_knowledge_tree', { path: directory, max_depth: 0 });
        assert.equal(page.entries[0].children_state, 'depth_limited');
        directory = page.entries[0].path;
      }
      assert.equal((await success('list_knowledge_tree', { path: directory, max_depth: 0 })).entries[0].path, `tree/${deep}/deep.md`);
      const empty = await success('list_knowledge_tree', { path: 'tree/empty', max_depth: 0 });
      assert.equal(empty.truncated, false);
      assert.equal(empty.directories[0].children_state, 'complete');
      await fs.writeFile(physical('tree/new.md'), '# New');
      requireIngestE2EFailure(await call('list_knowledge_tree', { path: 'tree', max_depth: 0, cursor: firstCursor }), 'WORKSPACE_TREE_CHANGED');
      requireIngestE2EFailure(await call('list_knowledge_tree', { path: 'tree/empty', max_depth: 0, cursor: firstCursor }), 'INVALID_TREE_REQUEST');
      requireIngestE2EFailure(await mcp.call('list_knowledge_tree', { workspace_id: deniedWorkspace.id }));
      return { uniqueEntries: 603, traversedLevels: 18 };
    });
    await step('create, read and edit a document with identical absolute file identity links', async () => {
      const filePath = 'links/Überblick & Plan.md';
      created = await create(filePath, '# MCP link acceptance\n\nOriginal link content.\n', 'created');
      checkLink(created, filePath, true);
      const readRaw = await call('read_knowledge_source', { path: filePath });
      const read = requireIngestE2ESuccess(readRaw, 'Read created document');
      assert.equal(read.document_id, created.document_id);
      assert.equal(read.document_url, created.document_url);
      assert.ok(text(readRaw).includes(read.document_url));
      const editedRaw = await call('edit_knowledge_source', { path: filePath,
        old_text: 'Original link content.', new_text: 'Updated by MCP link test.',
        expected_sha256: read.sha256, idempotency_key: `${runId}-edit` });
      const edited = requireIngestE2ESuccess(editedRaw, 'Edit linked document');
      assert.equal(edited.authoritative_updated, true);
      assert.equal(edited.document_url, created.document_url);
      assert.ok(text(editedRaw).includes(edited.document_url));
      const tree = await success('list_knowledge_tree', { path: 'links', max_depth: 0 });
      assert.equal(tree.entries.find(entry => entry.path === filePath).document_url, created.document_url);
      const searchRaw = await call('search_knowledge', { query: 'Updated by MCP link test', path: 'links' });
      const search = requireIngestE2ESuccess(searchRaw, 'Search file link');
      assert.equal(search.results[0].document_url, created.document_url);
      assert.ok(text(searchRaw).includes(created.document_url));
    });
    await step('import an immutable HTTPS original and return its exact document link', async () => {
      const url = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
      const receipt = await success('import_knowledge_file', { path: 'links/imported.md', idempotency_key: `${runId}-import`,
        file: { download_url: url, file_id: 'primary-mcp-readme-c518f7a9', file_name: 'README.md', mime_type: 'text/markdown' } });
      checkLink(receipt, 'links/imported.md', true);
      assert.equal((await requireIngestE2EJson(await location(receipt), 'Resolve import')).path, 'links/imported.md');
      const retry = await success('import_knowledge_file', { path: 'links/imported.md', idempotency_key: `${runId}-import`,
        file: { download_url: url, file_id: 'primary-mcp-readme-c518f7a9', file_name: 'README.md', mime_type: 'text/markdown' } });
      assert.equal(retry.document_url, receipt.document_url);
    });
    await step('complete and read a binary upload with a stable lineage link', async () => {
      const bytes = await fs.readFile(new URL('../public/icons/icon-192.png', import.meta.url));
      const begun = await success('upload_knowledge_asset', { operation: 'begin', path: 'links/pixel.png',
        size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime_type: 'image/png' });
      assert.equal(begun.document_url, undefined);
      await success('upload_knowledge_asset', { operation: 'chunk', upload_id: begun.upload_id, offset: 0, data_base64: bytes.toString('base64') });
      image = await success('upload_knowledge_asset', { operation: 'complete', upload_id: begun.upload_id });
      checkLink(image, 'links/pixel.png');
      const readRaw = await call('read_knowledge_asset', { path: 'links/pixel.png' });
      const read = requireIngestE2ESuccess(readRaw, 'Read image link');
      assert.equal(read.document_url, image.document_url);
      assert.ok(text(readRaw).includes(image.document_url));
      assert.equal((await requireIngestE2EJson(await location(image), 'Resolve binary')).path, 'links/pixel.png');
    });
    await step('create, read and edit an Excalidraw scene with an absolute identity link', async () => {
      diagram = requireIngestE2ESuccess(await mcp.call('create_excalidraw_scene', {
        workspaceId: workspace.id, path: 'links/diagram.excalidraw', idempotencyKey: `${runId}-diagram`,
      }), 'Create Excalidraw');
      checkLink(diagram, 'links/diagram.excalidraw', true);
      assert.equal(diagram.documentUrl, diagram.document_url);
      const read = requireIngestE2ESuccess(await mcp.call('get_excalidraw_scene', {
        workspaceId: workspace.id, documentId: diagram.documentId,
      }), 'Read Excalidraw');
      assert.equal(read.document_url, diagram.document_url);
      const edited = requireIngestE2ESuccess(await mcp.call('edit_excalidraw_scene', {
        workspaceId: workspace.id, documentId: read.documentId, lifecycleGeneration: read.lifecycleGeneration,
        observedSceneSequence: read.sceneSequence, idempotencyKey: `${runId}-diagram-edit`,
        actions: [{ type: 'create', element: { id: 'linked-rectangle', type: 'rectangle', x: 120, y: 100,
          width: 120, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid',
          strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
          roundness: { type: 3 }, seed: 17, version: 1, versionNonce: 29, isDeleted: false,
          boundElements: null, updated: 1, link: null, locked: false } }],
      }), 'Edit Excalidraw');
      assert.equal(edited.status, 'applied');
      assert.equal(edited.document_url, diagram.document_url);
    });
    await step('open the returned document link on desktop without preselecting a workspace', async () => {
      const page = await owner.newPage();
      try {
        await showDocument(page, created.document_url, 'Updated by MCP link test.');
        await screenshot(page, 'desktop-document-link.png');
        const identityOnly = new URL(created.document_url);
        identityOnly.searchParams.delete('path');
        await showDocument(page, identityOnly.href, 'Updated by MCP link test.');
        assert.equal(new URL(page.url()).searchParams.get('path'), created.path);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toContainText('Updated by MCP link test.', { timeout: 90_000 });
      } finally { await page.close(); }
    });
    await step('preserve document, lineage and encoded path across a real logged-out login', async () => {
      const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }]);
      const page = await context.newPage();
      const noSession = await context.request.get('/api/files/location', { params: { workspaceId: workspace.id, documentId: created.document_id } });
      assert.equal(noSession.status(), 401);
      await page.goto(created.document_url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 90_000 });
      const from = new URL(new URL(page.url()).searchParams.get('from'), baseURL);
      assert.equal(from.searchParams.get('documentId'), created.document_id);
      assert.equal(from.searchParams.get('lineageId'), created.lineage_id);
      assert.equal(from.searchParams.get('path'), created.path);
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.locator('button[type="submit"]').click();
      await expect(page.getByRole('group', { name: 'Document view', exact: true })).toBeVisible({ timeout: 90_000 });
      assert.equal(new URL(page.url()).searchParams.get('documentId'), created.document_id);
      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      if (!await editor.isVisible()) await page.getByRole('group', { name: 'Document view', exact: true })
        .getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(editor).toContainText('Updated by MCP link test.', { timeout: 90_000 });
      await screenshot(page, 'after-login-document-link.png');
    });
    await step('open returned document, image and Excalidraw links on a 390px mobile viewport', async () => {
      const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 },
        isMobile: true, hasTouch: true, storageState: await owner.storageState() });
      contexts.push(context);
      const page = await context.newPage();
      await showDocument(page, created.document_url, 'Updated by MCP link test.');
      await screenshot(page, 'mobile-document-link.png');
      await page.goto(image.document_url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await expect(page.getByRole('img', { name: 'pixel.png', exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole('img', { name: 'pixel.png', exact: true })).toHaveCSS('opacity', '1');
      await expect.poll(() => page.getByRole('img', { name: 'pixel.png', exact: true }).evaluate(image => image.naturalWidth)).toBeGreaterThan(1);
      await screenshot(page, 'mobile-image-link.png');
      await page.goto(diagram.document_url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await expect(page.locator('.excalidraw')).toBeVisible({ timeout: 90_000 });
      await screenshot(page, 'mobile-excalidraw-link.png');
    });
    await step('follow a renamed document by identity while its old path holds another document', async () => {
      for (const context of contexts.splice(0)) await context.close();
      await waitEditorsReleased(created.document_id);
      const renamed = 'links/renamed.md';
      await waitOperation(await owner.request.post('/api/files/rename', { headers,
        data: { oldPath: created.path, newPath: renamed, idempotencyKey: `${runId}-rename` }, timeout: 180_000 }));
      await create(created.path, '# Replacement at old path\n', 'replacement-old');
      const resolved = await requireIngestE2EJson(await location(created), 'Resolve moved document');
      assert.equal(resolved.path, renamed);
      assert.equal((await location(created, deniedWorkspace.id)).status(), 404);
      const page = await owner.newPage();
      try {
        await showDocument(page, created.document_url, 'Updated by MCP link test.');
        assert.equal(new URL(page.url()).searchParams.get('path'), renamed);
        await screenshot(page, 'renamed-document-link.png');
      } finally { await page.close(); }
    });
    await step('refuse a deleted identity even after a replacement is created at its path', async () => {
      await waitEditorsReleased(created.document_id);
      await waitOperation(await owner.request.delete('/api/files/delete', { headers,
        data: { path: 'links/renamed.md', idempotencyKey: `${runId}-delete` }, timeout: 180_000 }));
      await create('links/renamed.md', '# Replacement after deletion\n', 'replacement-deleted');
      assert.equal((await location(created)).status(), 404);
      const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, storageState: await owner.storageState() });
      contexts.push(context);
      const page = await context.newPage();
      const rejected = page.waitForResponse(response => response.url().includes('/api/files/location?') && response.status() === 404);
      await page.goto(created.document_url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await rejected;
      await expect(page.getByText(/linked document.*(unavailable|no longer)|linked file.*unavailable/i)).toBeVisible({ timeout: 30_000 });
      assert.ok(!(await page.locator('body').innerText()).includes('Replacement after deletion'));
      await expect(page.getByText('links', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => {
        const bounds = await page.getByText(/linked document.*(unavailable|no longer)|linked file.*unavailable/i).boundingBox();
        return Boolean(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 1000);
      }).toBe(true);
      await screenshot(page, 'deleted-document-link.png');
    });
    await step('revocation also rejects a previously issued tree continuation', async () => {
      await mcp.revoke();
      const rejected = await call('list_knowledge_tree', { path: 'tree', max_depth: 0, cursor: firstCursor });
      requireIngestE2EFailure(rejected);
      assert.equal(rejected.structuredContent.http_status, 401);
    });
  } finally { for (const context of contexts) await context.close(); }
}
