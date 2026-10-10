import { expect, test, type Browser } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool, type OrdinaryAgentToolDetails } from './helpers/ordinary-agent-tool';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { withOwnedTestCleanup } from './helpers/owned-test-cleanup';

// The rich Markdown serializer includes a blank line on both sides of tables.
const INITIAL = '# Content plan\n\nHuman introduction\n\n\n'
  + '| Article | Status   |\n'
  + '| ------- | -------- |\n'
  + '| Alpha   | ✅ Online |\n'
  + '| Beta    | Draft    |\n\n\nHuman footer\n';
const tablePattern = /^\|.*(?:\n\|.*)*/mu;
const surroundingContent = (markdown: string) => markdown.replace(tablePattern, '<table>');
const tableRows = (markdown: string) => markdown.match(tablePattern)![0].split('\n')
  .filter((_, index) => index !== 1)
  .map(row => row.split('|').slice(1, -1).map(cell => cell.trim()));

async function withOwnedTableWorkspace(browser: Browser, run: (workspaceId: string) => Promise<void>) {
  const context = await createAuthenticatedContext(browser);
  const workspaceName = `E2E table agent editing ${randomUUID()}`;
  let workspaceId: string | undefined;
  let ownerUserId: string | undefined;
  let fixtureFinished = false;
  await withOwnedTestCleanup(async () => {
    const session = await context.request.get('/api/auth/get-session');
    expect(session.ok()).toBeTruthy();
    ownerUserId = (await session.json()).user.id as string;
    const created = await context.request.post('/api/workspaces', { data: { type: 'personal', name: workspaceName } });
    const receipt = (await created.json()).workspace;
    if (typeof receipt?.id === 'string') workspaceId = receipt.id;
    expect(created.status()).toBe(201);
    expect(receipt).toMatchObject({ id: workspaceId, name: workspaceName, ownerUserId, type: 'personal',
      permissions: { canWrite: true, canRunAgent: true, canDelete: true, canManageWorkspace: true } });
    await run(workspaceId!);
    fixtureFinished = true;
  }, [
    { label: 'exact owned table workspace', run: async () => {
      if (!workspaceId) return;
      if (!fixtureFinished) throw new Error(`Retain owned workspace ${workspaceId} until its document fixture cleanup is verified.`);
      const session = await context.request.get('/api/auth/get-session');
      expect(session.ok()).toBeTruthy();
      expect((await session.json()).user.id).toBe(ownerUserId);
      const listing = await context.request.get('/api/workspaces');
      expect(listing.ok()).toBeTruthy();
      expect((await listing.json()).workspaces.find((item: { id: string }) => item.id === workspaceId))
        .toMatchObject({ id: workspaceId, name: workspaceName, ownerUserId, type: 'personal', status: 'active' });
      const deleted = await context.request.delete(`/api/workspaces/${workspaceId}`);
      expect(deleted.status()).toBe(200);
      expect(await deleted.json()).toEqual({ success: true });
      const after = await context.request.get('/api/workspaces');
      expect(after.ok()).toBeTruthy();
      expect((await after.json()).workspaces.some((item: { id: string }) => item.id === workspaceId)).toBe(false);
    } },
    { label: 'table workspace owner context', run: () => context.close() },
  ]);
}

for (const editKind of ['exact', 'replace', 'patch'] as const) {
  test(`${editKind} edits and cell-ID edits change a live table, then a copied table target deletes its row`, async ({ browser }, info) => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local in-process agent tool host.');
    test.setTimeout(300_000);
    await withOwnedTableWorkspace(browser, async workspaceId => withOrdinaryAgentDocument(browser, INITIAL,
      async ({ page, context, target, filePath, representation, agentContext, content }) => {
        expect(representation).toBe('tiptap_blocks');
        expect(await content()).toBe(INITIAL);
        await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
        const editor = page.locator('.tiptap-editor-shell .ProseMirror');
        const table = editor.locator('table');
        await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
        await expect(table).toHaveCount(1);
        await expect(table.locator('tr')).toHaveCount(3);
        await expect(table.locator('tr').nth(1).locator('td').nth(1)).toHaveText('✅ Online');
        const evidence: Array<{ edit: string; details: OrdinaryAgentToolDetails }> = [];
        const operationIds = new Set<string>();
        const run = async (toolName: 'read' | 'edit_file' | 'apply_patch', params: Record<string, unknown>) => {
          const result = await runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-table-${randomUUID()}`,
            params, context: agentContext }, { inProcess: true });
          expect(result.isError, JSON.stringify(result.details)).not.toBe(true);
          expect(result.details).toBeTruthy();
          return result.details!;
        };
        const read = async () => {
          const details = await run('read', { path: filePath, source: 'blocks', structureLimit: 100 });
          expect(details.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
          expect(details.document).toBeTruthy();
          expect(details.structure?.nextOffset).toBeNull();
          return details;
        };
        const assertApplied = async (details: OrdinaryAgentToolDetails, status: string,
          expectedRows = [['Article', 'Status'], ['Alpha', status], ['Beta', 'Draft']]) => {
          expect(details.outcome, JSON.stringify(details)).toBe('applied');
          expect(details.collaboration).toMatchObject({ reviewRequired: false });
          expect(details.collaboration?.durability).toMatch(/^(?:persisted_yjs|checkpointed_file)$/u);
          expect(details.collaboration?.operationId).toEqual(expect.any(String));
          expect(operationIds.has(details.collaboration!.operationId!)).toBe(false);
          operationIds.add(details.collaboration!.operationId!);
          const receipt = await context.request.get('/api/files/collaboration/operations', {
            headers: { 'x-canvas-workspace-id': target.workspaceId }, params: { documentId: target.documentId },
          });
          expect(receipt.ok()).toBeTruthy();
          const operations = (await receipt.json()).operations;
          expect(operations.find((operation: { operationId: string }) => operation.operationId === details.collaboration!.operationId))
            .toMatchObject({ operationId: details.collaboration!.operationId, documentId: target.documentId,
              operationStatus: expect.stringMatching(/^(?:persisted_yjs|checkpointed_file)$/u),
              durability: expect.stringMatching(/^(?:persisted_yjs|checkpointed_file)$/u) });
          await expect(table.locator('tr').nth(1).locator('td').nth(1)).toHaveText(status);
          await expect(table.locator('tr')).toHaveCount(expectedRows.length);
          await expect(editor.locator('p').filter({ hasText: /^Human introduction$/u })).toHaveCount(1);
          await expect(editor.locator('p').filter({ hasText: /^Human footer$/u })).toHaveCount(1);
          const persisted = await content();
          expect(tableRows(persisted)).toEqual(expectedRows);
          expect(surroundingContent(persisted)).toBe(surroundingContent(INITIAL));
          expect(createHash('sha256').update(persisted).digest('hex')).toBe(details.afterSha256);
          expect(await readFile(path.join(agentContext.workspaceRoot as string, filePath), 'utf8')).toBe(persisted);
        };

        const source = await read();
        const replacement = { oldText: '✅ Online', newText: '🗑️ Archiviert' };
        let statusEdit: OrdinaryAgentToolDetails;
        if (editKind === 'patch') {
          const patched = await run('apply_patch', { files: [{ path: filePath, expectedSha256: source.sha256,
            edits: [replacement] }] });
          statusEdit = patched.results![0]!;
        } else if (editKind === 'replace') {
          const currentTable = (await content()).match(tablePattern)![0];
          statusEdit = await run('edit_file', { path: filePath, expectedSha256: source.sha256,
            mode: 'replace', oldText: currentTable, content: currentTable.replace(replacement.oldText, replacement.newText) });
        } else {
          statusEdit = await run('edit_file', { path: filePath, expectedSha256: source.sha256, ...replacement });
        }
        await assertApplied(statusEdit, '🗑️ Archiviert');
        evidence.push({ edit: editKind, details: statusEdit });

        const afterStatus = await read();
        const statusCell = afterStatus.structure!.blocks.find(block => block.type === 'tableCell' && block.text === '🗑️ Archiviert');
        expect(statusCell).toBeTruthy();
        // Deliberately copy the cell ID displayed by read, rather than finding its paragraph ID ourselves.
        const cellEdit = await run('edit_file', { path: filePath, document: afterStatus.document, blockId: statusCell!.id,
          oldText: '🗑️ Archiviert', newText: '🗑️ Archiviert bestätigt' });
        await assertApplied(cellEdit, '🗑️ Archiviert bestätigt');
        evidence.push({ edit: 'cell ID exact edit', details: cellEdit });

        const afterCell = await read();
        expect(afterCell.document).toEqual(source.document);
        const removableCell = afterCell.structure!.blocks.find(block => block.type === 'tableCell' && block.text === 'Beta');
        expect(removableCell).toBeTruthy();
        expect(removableCell?.tableOperationTarget).toMatchObject({ cellId: removableCell!.id,
          subtreeHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
        const tableBlock = afterCell.structure!.blocks.find(block => block.type === 'table');
        expect(tableBlock).toBeTruthy();
        expect(removableCell!.tableOperationTarget!.subtreeHash).toBe(tableBlock!.subtreeHash);
        const cellPage = await run('read', { path: filePath, source: 'blocks', structureLimit: 1,
          structureOffset: afterCell.structure!.blocks.findIndex(block => block.id === removableCell!.id) });
        expect(cellPage.document).toEqual(source.document);
        expect(cellPage.collaboration).toMatchObject({ source: 'live_yjs', representation: 'tiptap_blocks' });
        expect(cellPage.structure!.blocks).toHaveLength(1);
        expect(cellPage.structure!.blocks[0]!.type).toBe('tableCell');
        expect(cellPage.structure!.blocks[0]!.tableOperationTarget).toEqual(removableCell!.tableOperationTarget);
        const rowDelete = await run('edit_file', { path: filePath, document: cellPage.document,
          operations: [{ kind: 'table_operation', ...cellPage.structure!.blocks[0]!.tableOperationTarget, action: 'deleteRow' }] });
        await assertApplied(rowDelete, '🗑️ Archiviert bestätigt',
          [['Article', 'Status'], ['Alpha', '🗑️ Archiviert bestätigt']]);
        evidence.push({ edit: 'copied table operation target deletes row', details: rowDelete });

        await page.reload();
        await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
        await expect(table.locator('tr')).toHaveCount(2);
        await expect(table.locator('tr').nth(1).locator('td').nth(1)).toHaveText('🗑️ Archiviert bestätigt');
        await expect(table).not.toContainText('Beta');
        await expect(editor.getByText('Human introduction', { exact: true })).toBeVisible();
        await expect(editor.getByText('Human footer', { exact: true })).toBeVisible();
        expect(operationIds.size).toBe(3);
        const evidencePath = info.outputPath(`${editKind}-agent-table-editing-evidence.json`);
        await writeFile(evidencePath, JSON.stringify({
          editKind, representation, document: source.document, source: 'live_yjs', evidence,
          paginatedCell: cellPage.structure!.blocks[0],
          persistedMarkdown: await content(), reloadPreservesTable: true,
        }, null, 2));
        await info.attach('agent-table-editing-evidence.json', { contentType: 'application/json', path: evidencePath });
        const screenshotPath = info.outputPath(`${editKind}-agent-table-editing-final.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await info.attach('agent-table-editing-final.png', { contentType: 'image/png', path: screenshotPath });
      }, { workspaceId, initialReviewRequired: false, bindToolSessionToFixture: true, navigationTimeoutMs: 180_000,
        retryStaleCleanup: true }));
  });
}
