import { expect, test, type Page, type WebSocket } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertNativePhysicalReceipt, authorizeProductionMcp, connectNative, enableProductionMcp,
  ProductionDocument, productionIdentity, responseJson, setDocumentReview,
  type McpToolResult, type ProductionWorkspace,
} from './helpers/document-review-production';

const reviewSwitch = (page: Page) => page.getByRole('switch', {
  name: /Require review for agent changes|Edit directly when safe|Review für Agentenänderungen erforderlich|Direkt bearbeiten, wenn sicher/u,
});

const fileReviewButtons = (page: Page) => page.getByRole('button', { name: /Versions & changes|Open agent changes/u });
const successfulMcp = (result: McpToolResult) => {
  expect(result.isError, result.content?.map(item => item.text || '').join('\n')).not.toBe(true);
  expect(Boolean(result.structuredContent), 'MCP must return its actual structured result.').toBe(true);
  return result.structuredContent!;
};

test('production native and OAuth MCP edits share live Yjs, checkpoint before success, and respect experimental review', async ({ browser }, info) => {
  test.skip(process.env.DOCUMENT_REVIEW_PRODUCTION_E2E !== '1', 'Explicit managed production E2E opt-in required.');
  expect(['127.0.0.1', 'localhost']).toContain(new URL(process.env.BASE_URL!).hostname);
  const owner = await productionIdentity(browser);
  const peer = await productionIdentity(browser, true);
  expect(peer.user.id).not.toBe(owner.user.id);
  const page = await owner.context.newPage();
  const peerPage = await peer.context.newPage();
  const settingsPage = await owner.context.newPage();
  const errors: string[] = [];
  const liveBrowserSockets = new Set<WebSocket>();
  for (const target of [page, peerPage, settingsPage]) {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => {
      if (message.type() === 'error' && message.text().startsWith('App error:')) errors.push(message.text());
    });
    target.on('websocket', socket => {
      liveBrowserSockets.add(socket);
      socket.on('close', () => liveBrowserSockets.delete(socket));
    });
  }
  const previousReview = await responseJson<{ data: { documentReviewEnabled: boolean } }>(
    await owner.context.request.get('/api/server-settings'), 'Save previous experimental setting');
  const ownerWorkspaces = await responseJson<{ workspaces: ProductionWorkspace[] }>(
    await owner.context.request.get('/api/workspaces'), 'Read owner workspaces');
  const peerWorkspaces = await responseJson<{ workspaces: ProductionWorkspace[] }>(
    await peer.context.request.get('/api/workspaces'), 'Read distinct collaborator workspaces');
  const workspace = ownerWorkspaces.workspaces.find(item => ['team', 'organization'].includes(item.type) && item.permissions.canWrite
    && item.permissions.canDelete && item.permissions.canRunAgent && peerWorkspaces.workspaces.some(shared => shared.id === item.id
      && shared.permissions.canRead && shared.permissions.canWrite));
  expect(Boolean(workspace), 'Two distinct users must have write access to one real team workspace.').toBe(true);
  const document = new ProductionDocument(owner.context, workspace!);
  let native: Awaited<ReturnType<typeof connectNative>> | undefined;
  let mcpSettings: Awaited<ReturnType<typeof enableProductionMcp>> | undefined;
  let mcp: Awaited<ReturnType<typeof authorizeProductionMcp>> | undefined;
  const closeEditors = async () => {
    await page.goto('about:blank');
    await peerPage.goto('about:blank');
    await settingsPage.goto('about:blank');
    await expect.poll(() => liveBrowserSockets.size).toBe(0);
  };
  try {
    await test.step('admin-only settings, default-off surfaces, two actual live collaborators', async () => {
      await setDocumentReview(owner.context, false);
      await settingsPage.goto('/en/settings?tab=experimental');
      await expect(settingsPage.locator('#document-review-enabled')).toBeEnabled();
      await expect(settingsPage.locator('#document-review-enabled')).not.toBeChecked();
      const peerSettings = await peer.context.newPage();
      try {
        await peerSettings.goto('/en/settings?tab=experimental');
        await expect(peerSettings.locator('#document-review-enabled')).toHaveCount(0);
        const forbidden = await peer.context.request.patch('/api/admin/experimental-settings', { data: { documentReviewEnabled: true } });
        expect(forbidden.status()).toBe(403);
      } finally { await peerSettings.close(); }
      await document.upload([...Array.from({ length: 100 }, (_, index) => `- Line ${String(index + 1).padStart(3, '0')} original`),
        '', 'Human control unchanged', '', 'Concurrent control unchanged', ''].join('\n'));
      for (const context of [owner.context, peer.context]) await context.addInitScript(({ id, origin }) => {
        if (window.location.origin !== origin) return;
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, { id: workspace!.id, origin: process.env.BASE_URL! });
      const editor = await document.open(page);
      const peerEditor = await document.open(peerPage);
      await expect(reviewSwitch(page)).toHaveCount(0);
      await expect(fileReviewButtons(page)).toHaveCount(0);
      const human = peerEditor.locator('p').filter({ hasText: /^Human control unchanged$/u });
      await human.click();
      await peerPage.keyboard.press('End');
      await peerPage.keyboard.insertText(' edited by the second user');
      await expect(editor).toContainText('Human control unchanged edited by the second user');
      await document.read();
      await expect.poll(() => document.disk()).toContain('Human control unchanged edited by the second user');
      const unavailable = await owner.context.request.post('/api/files/version-center/v1/resolve', {
        headers: document.headers, data: { contractVersion: 1, target: document.target, initialView: 'history', source: 'deep_link' },
      });
      expect(unavailable.status()).toBe(409);
      expect((await unavailable.json()).error.code).toBe('FVRC_CAPABILITY_UNAVAILABLE');
      await page.screenshot({ path: info.outputPath('production-review-off-live.png') });
      native = await connectNative(owner.context, document);
    });

    await test.step('three native edit_file calls form one visible version, with disk ready at each tool end', async () => {
      const receipts = await native!.turn(`This is an acceptance task on ${document.filePath}. Read its current Markdown using read first. `
        + 'Intentionally execute exactly THREE separate sequential edit_file calls in THIS user task: '
        + 'replace oldText "Line 010 original" with newText "Line 010 native"; '
        + 'then "Line 040 original" with "Line 040 native"; then "Line 060 original" with "Line 060 native". '
        + 'Use ordinary oldText/newText exact edits, copying expectedSha256 from read and then each previous success (or reread). '
        + 'Do not combine these into apply_patch in this test. Preserve every other item and the human control text. '
        + 'Use only read and edit_file; finish after the third successful edit.');
      expect(receipts.map(receipt => receipt.event.toolName)).toEqual(['edit_file', 'edit_file', 'edit_file']);
      receipts.forEach(assertNativePhysicalReceipt);
      for (const number of ['010', '040', '060']) {
        await expect(page.locator('.ProseMirror')).toContainText(`Line ${number} native`);
        await expect(peerPage.locator('.ProseMirror')).toContainText(`Line ${number} native`);
      }
      expect(document.disk()).toContain('Human control unchanged edited by the second user');
      await setDocumentReview(owner.context, true);
      const history = await document.timeline();
      expect(history.entries.filter(entry => entry.kind === 'revision' && entry.source === 'agent_apply')).toHaveLength(1);
      expect(history.policy.requestedMode).toBe('safe_direct');
      await expect(reviewSwitch(page)).not.toBeChecked();
      await setDocumentReview(owner.context, false);
      await expect(reviewSwitch(page)).toHaveCount(0);
    });

    await test.step('native apply_patch uses the same path with both editors closed and survives reopen', async () => {
      await closeEditors();
      const receipts = await native!.turn(`Read ${document.filePath} using read. Then use exactly ONE apply_patch call with one files[] entry `
        + 'for that path and two edits: "Line 080 original" -> "Line 080 closed native", '
        + '"Line 081 original" -> "Line 081 closed native". Copy expectedSha256 from read. '
        + 'Preserve all other content. Use only read and apply_patch, then stop.');
      expect(receipts.map(receipt => receipt.event.toolName)).toEqual(['apply_patch']);
      receipts.forEach(assertNativePhysicalReceipt);
      expect(document.disk()).toContain('Line 080 closed native');
      expect(document.disk()).toContain('Line 081 closed native');
      await document.open(page);
      await document.open(peerPage);
      await expect(peerPage.locator('.ProseMirror')).toContainText('Line 081 closed native');
      await expect(peerPage.locator('.ProseMirror')).toContainText('Human control unchanged edited by the second user');
      await expect(peerPage.locator('.ProseMirror')).toContainText('Concurrent control unchanged');
      await setDocumentReview(owner.context, true);
      expect((await document.timeline()).entries.filter(entry => entry.kind === 'revision' && entry.source === 'agent_apply')).toHaveLength(2);
      await setDocumentReview(owner.context, false);
    });

    await test.step('real OAuth PKCE consent grants an MCP client access to this workspace', async () => {
      mcpSettings = await enableProductionMcp(owner.context, workspace!);
      mcp = await authorizeProductionMcp(owner.context, workspace!, mcpSettings.protocolVersion);
      const listed = successfulMcp(await mcp.call('list_workspaces', {}));
      expect((listed.workspaces as Array<{ id?: string; workspace_id?: string }>).length).toBe(1);
    });

    await test.step('live MCP direct edit checkpoints, exact retry accepts its old hash, stale fresh edits fail', async () => {
      const read = successfulMcp(await mcp!.call('read_knowledge_source', { workspace_id: workspace!.id, path: document.filePath }));
      const beforeConcurrentOperations = (await document.operations()).map(operation => operation.operationId);
      const concurrent = peerPage.locator('.ProseMirror p').filter({ hasText: /^Concurrent control unchanged$/u });
      await concurrent.click();
      await peerPage.keyboard.press('End');
      await peerPage.keyboard.insertText(' edited while MCP prepared');
      for (const target of [page, peerPage]) await expect(target.locator('.ProseMirror'))
        .toContainText('Concurrent control unchanged edited while MCP prepared');
      await expect.poll(() => document.disk()).toContain('Concurrent control unchanged edited while MCP prepared');
      const concurrentCheckpoint = document.disk();
      const staleConcurrent = await mcp!.call('edit_knowledge_source', { workspace_id: workspace!.id, path: document.filePath,
        old_text: 'Line 020 original', new_text: 'Line 020 MCP live', expected_sha256: read.sha256,
        idempotency_key: `mcp-concurrent-stale-${randomUUID()}` });
      expect(staleConcurrent.isError).toBe(true);
      expect(staleConcurrent.content?.map(item => item.text || '').join('\n')).toMatch(/changed|match/iu);
      expect(document.disk()).toBe(concurrentCheckpoint);
      expect(document.disk()).toContain('Line 020 original');
      expect((await document.operations()).map(operation => operation.operationId)).toEqual(beforeConcurrentOperations);
      const current = successfulMcp(await mcp!.call('read_knowledge_source', { workspace_id: workspace!.id, path: document.filePath }));
      const request = { workspace_id: workspace!.id, path: document.filePath, old_text: 'Line 020 original',
        new_text: 'Line 020 MCP live', expected_sha256: current.sha256, idempotency_key: `mcp-live-${randomUUID()}` };
      const applied = successfulMcp(await mcp!.call('edit_knowledge_source', request));
      expect(applied.status).toBe('applied');
      expect(applied.review_required).toBe(false);
      expect(applied.requires_user_action).toBe(false);
      expect(applied.authoritative_updated).toBe(true);
      expect(Boolean(applied.operation_id), 'Live MCP edits must return the durable Yjs operation identity.').toBe(true);
      // Read the actual disk immediately after the tool's HTTP success.
      const checkpoint = document.disk();
      expect(checkpoint).toContain('Line 020 MCP live');
      expect(checkpoint).toContain('Concurrent control unchanged edited while MCP prepared');
      expect(applied.after_sha256).toBe(createHash('sha256').update(checkpoint).digest('hex'));
      await expect(peerPage.locator('.ProseMirror')).toContainText('Line 020 MCP live');
      const retried = successfulMcp(await mcp!.call('edit_knowledge_source', request));
      expect(retried.operation_id).toBe(applied.operation_id);
      expect(retried.review_required).toBe(false);
      expect(document.disk()).toBe(checkpoint);
      expect(retried.after_sha256).toBe(createHash('sha256').update(document.disk()).digest('hex'));
      const stale = await mcp!.call('edit_knowledge_source', { ...request, old_text: 'Line 021 original',
        new_text: 'Line 021 must remain original', idempotency_key: `mcp-stale-${randomUUID()}` });
      expect(stale.isError).toBe(true);
      expect(stale.content?.map(item => item.text || '').join('\n')).toMatch(/changed|match/iu);
      expect(document.disk()).toBe(checkpoint);
      await closeEditors();
      await mcp!.reconnect();
      const closedRead = successfulMcp(await mcp!.call('read_knowledge_source', { workspace_id: workspace!.id, path: document.filePath }));
      const closed = successfulMcp(await mcp!.call('edit_knowledge_source', { workspace_id: workspace!.id, path: document.filePath,
        old_text: 'Line 095 original', new_text: 'Line 095 MCP closed', expected_sha256: closedRead.sha256,
        idempotency_key: `mcp-closed-${randomUUID()}` }));
      expect(closed.status).toBe('applied');
      expect(closed.operation_id).not.toBe(applied.operation_id);
      expect(closed.review_required).toBe(false);
      expect(document.disk()).toContain('Line 095 MCP closed');
      expect(closed.after_sha256).toBe(createHash('sha256').update(document.disk()).digest('hex'));
      await document.open(page);
      await document.open(peerPage);
      await expect(peerPage.locator('.ProseMirror')).toContainText('Line 095 MCP closed');
      await expect(peerPage.locator('.ProseMirror')).toContainText('Line 020 MCP live');
      for (const target of [page, peerPage]) await expect(target.locator('.ProseMirror'))
        .toContainText('Concurrent control unchanged edited while MCP prepared');
      await setDocumentReview(owner.context, true);
      expect((await document.timeline()).entries.filter(entry => entry.kind === 'revision' && entry.source === 'agent_apply'))
        .toHaveLength(4); // Two native tasks and two MCP operations; exact retry adds none.
      await setDocumentReview(owner.context, false);
    });

    await test.step('pending graph remains intact across off/on, while fresh edits ignore stored review preference when off', async () => {
      await setDocumentReview(owner.context, true);
      await expect(reviewSwitch(page)).toBeEnabled();
      await reviewSwitch(page).click();
      await expect(reviewSwitch(page)).toBeChecked();
      const reviewPolicy = (await document.timeline()).policy;
      expect(reviewPolicy.requestedMode).toBe('review_required');
      expect(reviewPolicy.effectiveMode).toBe('review_required');
      const read = successfulMcp(await mcp!.call('read_knowledge_source', { workspace_id: workspace!.id, path: document.filePath }));
      const request = { workspace_id: workspace!.id, path: document.filePath, old_text: 'Line 070 original',
        new_text: 'Line 070 pending proposal', expected_sha256: read.sha256, idempotency_key: `mcp-review-${randomUUID()}` };
      const proposed = successfulMcp(await mcp!.call('edit_knowledge_source', request));
      expect(proposed.status).toBe('review_created');
      expect(proposed.proposal_lifecycle).toBe('open');
      expect(proposed.review_required).toBe(true);
      expect(proposed.authoritative_updated).toBe(false);
      expect(proposed.requires_user_action).toBe(true);
      expect(Boolean(proposed.proposal_id && proposed.operation_id && proposed.review_url)).toBe(true);
      expect(document.disk()).toContain('Line 070 original');
      expect(document.disk()).not.toContain('Line 070 pending proposal');
      expect(document.disk()).toContain('Concurrent control unchanged edited while MCP prepared');
      for (const target of [page, peerPage]) await expect(target.locator('.ProseMirror'))
        .toContainText('Concurrent control unchanged edited while MCP prepared');
      const operation = (await document.operations()).find(item => item.operationId === proposed.operation_id)!;
      expect(operation.operationStatus).toBe('needs_review');
      await setDocumentReview(owner.context, false);
      await expect(reviewSwitch(page)).toHaveCount(0);
      await expect(fileReviewButtons(page)).toHaveCount(0);
      const blockedRetry = await mcp!.call('edit_knowledge_source', request);
      expect(blockedRetry.isError).toBe(true);
      expect(blockedRetry.content?.map(item => item.text || '').join('\n'))
        .toMatch(/DOCUMENT_REVIEW_DISABLED_CONFLICT|PROPOSAL_UPGRADE_REQUIRED/u);
      for (const action of ['accept', 'direct-edit-grant']) {
        const response = await owner.context.request.post(`/api/files/collaboration/operations/${proposed.operation_id}/${action}`, {
          headers: document.headers, data: action === 'accept'
            ? { idempotencyKey: randomUUID(), proposalVersion: operation.proposalVersion }
            : { action: 'grant', idempotencyKey: randomUUID() },
        });
        expect(response.status()).toBe(409);
        expect((await response.json()).error.code).toBe('FVRC_CAPABILITY_UNAVAILABLE');
      }
      const receipts = await native!.turn(`Read ${document.filePath}, then use exactly one edit_file call to replace `
        + '"Line 090 original" with "Line 090 native while feature off" using oldText/newText and the current expectedSha256. '
        + 'Preserve the human paragraph and all other lines. Use only read and edit_file, then stop.');
      expect(receipts).toHaveLength(1);
      receipts.forEach(assertNativePhysicalReceipt);
      const freshRead = successfulMcp(await mcp!.call('read_knowledge_source', { workspace_id: workspace!.id, path: document.filePath }));
      const fresh = successfulMcp(await mcp!.call('edit_knowledge_source', { workspace_id: workspace!.id, path: document.filePath,
        old_text: 'Line 071 original', new_text: 'Line 071 MCP while feature off', expected_sha256: freshRead.sha256,
        idempotency_key: `mcp-fresh-${randomUUID()}` }));
      expect(fresh.status).toBe('applied');
      expect(fresh.review_required).toBe(false);
      expect(document.disk()).toContain('Line 071 MCP while feature off');
      expect(fresh.after_sha256).toBe(createHash('sha256').update(document.disk()).digest('hex'));
      expect(document.disk()).toContain('Line 090 native while feature off');
      expect((await document.operations()).find(item => item.operationId === proposed.operation_id)?.operationStatus).toBe('needs_review');
      await setDocumentReview(owner.context, true);
      await expect(reviewSwitch(page)).toBeChecked();
      expect((await document.timeline()).policy.requestedMode).toBe('review_required');
      const preserved = successfulMcp(await mcp!.call('edit_knowledge_source', request));
      expect(preserved.status).toBe('review_reused');
      expect(preserved.proposal_id).toBe(proposed.proposal_id);
      expect(preserved.operation_id).toBe(proposed.operation_id);
      expect(preserved.proposal_lifecycle).toBe('open');
      expect((await document.timeline()).entries.filter(entry => entry.kind === 'revision' && entry.source === 'agent_apply'))
        .toHaveLength(6); // The fresh native task and fresh MCP edit add one each; proposal retries add none.
      expect(document.disk()).not.toContain('Line 070 pending proposal');
      expect(document.disk()).toContain('Concurrent control unchanged edited while MCP prepared');
      for (const target of [page, peerPage]) await expect(target.locator('.ProseMirror'))
        .toContainText('Concurrent control unchanged edited while MCP prepared');
      await page.screenshot({ path: info.outputPath('production-review-on-pending.png') });
    });
    expect(errors).toEqual([]);
  } finally {
    const failures: string[] = [];
    for (const cleanup of [
      closeEditors,
      async () => native?.cleanup(),
      async () => mcp?.cleanup(),
      async () => document.cleanup(),
      async () => mcpSettings?.cleanup(),
      async () => setDocumentReview(owner.context, previousReview.data.documentReviewEnabled),
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error instanceof Error ? error.message : 'Cleanup failed'); }
    }
    await owner.context.close();
    await peer.context.close();
    expect(failures, 'All scoped UUID resources and previous feature/MCP settings must be restored.').toEqual([]);
  }
});

test('production admin review switch updates availability for another authenticated browser', async ({ browser }) => {
  test.skip(process.env.DOCUMENT_REVIEW_PRODUCTION_E2E !== '1', 'Explicit managed production E2E opt-in required.');
  test.setTimeout(90_000);
  const owner = await productionIdentity(browser);
  const peer = await productionIdentity(browser, true);
  expect(peer.user.id).not.toBe(owner.user.id);
  const page = await owner.context.newPage();
  const peerPage = await peer.context.newPage();
  const peerReviewFrames: boolean[] = [];
  const errors: string[] = [];
  for (const target of [page, peerPage]) {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => {
      if (message.type() === 'error' && message.text().startsWith('App error:')) errors.push(message.text());
    });
  }
  peerPage.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws/live-events') return;
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload)) as { type?: string; event?: { data?: string } };
        if (message.type !== 'event' || typeof message.event?.data !== 'string') return;
        const availability = JSON.parse(message.event.data) as { documentReviewEnabled?: boolean };
        if (typeof availability.documentReviewEnabled === 'boolean') peerReviewFrames.push(availability.documentReviewEnabled);
      } catch { /* Other live channels have their own frame format. */ }
    });
  });
  const previous = await responseJson<{ data: { documentReviewEnabled: boolean } }>(
    await owner.context.request.get('/api/document-review/availability'), 'Save previous review availability');
  const available = async () => (await responseJson<{ data: { documentReviewEnabled: boolean } }>(
    await owner.context.request.get('/api/document-review/availability'), 'Read public review availability')).data.documentReviewEnabled;
  try {
    await setDocumentReview(owner.context, false);
    await page.goto('/en/settings?tab=experimental');
    await peerPage.goto('/en/settings?tab=experimental');
    const toggle = page.locator('#document-review-enabled');
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await expect(peerPage.locator('#document-review-enabled')).toHaveCount(0);
    await expect.poll(() => peerReviewFrames.at(-1)).toBe(false);

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(available).toBe(true);
    await expect.poll(() => peerReviewFrames.at(-1)).toBe(true);
    await expect(toggle).toBeEnabled();

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(available).toBe(false);
    await expect.poll(() => peerReviewFrames.at(-1)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    try { await setDocumentReview(owner.context, previous.data.documentReviewEnabled); }
    finally { await owner.context.close(); await peer.context.close(); }
  }
});
