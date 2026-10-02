import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileVersionTimelineEntryV1 } from '../app/lib/file-version-center/contracts/v1';

import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

test('review off writes an existing Markdown document to Yjs and the file before tool success', async ({ browser }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the local collaboration stack.');
  test.setTimeout(120_000);
  const initial = '# Plan\n\nEins\n\nZwei\n';
  const updated = '# Plan\n\nEins geändert\n\nZwei\n';
  await withOrdinaryAgentDocument(browser, initial, async ({ filePath, agentContext, content, revisionCount, page, context, target }) => {
    await expect(page.locator('[data-file-review-policy]').getByRole('switch')).not.toBeChecked();
    const before = await revisionCount();
    const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-direct-write-${randomUUID()}`,
      params: { path: filePath }, context: agentContext }, { inProcess: true });
    expect(read.isError).not.toBe(true);
    const writeCallId = `ordinary-direct-write-${randomUUID()}`;
    const writeParams = { path: filePath, content: updated, expectedSha256: read.details!.sha256 };
    const written = await runOrdinaryAgentTool({ toolName: 'write', toolCallId: writeCallId,
      params: writeParams,
      context: agentContext }, { inProcess: true });
    expect(written.isError, written.details?.code).not.toBe(true);
    expect(written.details?.collaboration, JSON.stringify(written.details)).toMatchObject({ reviewRequired: false });
    expect(await content()).toBe(updated);
    const fullPath = path.join(agentContext.workspaceRoot as string, filePath);
    expect(await readFile(fullPath, 'utf8')).toBe(updated);
    expect(await revisionCount()).toBe(before + 1);
    expect(written.details?.collaboration?.durability).toMatch(/^(?:persisted_yjs|checkpointed_file)$/u);
    expect(createHash('sha256').update(updated).digest('hex')).toBe(written.details?.afterSha256);
    const retry = await runOrdinaryAgentTool({ toolName: 'write', toolCallId: writeCallId,
      params: writeParams, context: agentContext }, { inProcess: true });
    expect(retry.isError).not.toBe(true);
    expect(retry.details?.collaboration?.operationId).toBe(written.details?.collaboration?.operationId);
    expect(await revisionCount()).toBe(before + 1);
    const noOp = await runOrdinaryAgentTool({ toolName: 'write',
      toolCallId: `ordinary-direct-write-${randomUUID()}`,
      params: { path: filePath, content: updated, expectedSha256: written.details?.afterSha256 },
      context: agentContext }, { inProcess: true });
    expect(noOp.isError).not.toBe(true);
    expect(await readFile(fullPath, 'utf8')).toBe(updated);
    expect(await revisionCount()).toBe(before + 1);
    const timelineResponse = await context.request.post('/api/files/version-center/v1/resolve', {
      headers: { 'x-canvas-workspace-id': target.workspaceId, 'x-canvas-version-history-provenance': '1' },
      data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
    });
    expect(timelineResponse.status()).toBe(200);
    const { entries } = await timelineResponse.json() as { entries: FileVersionTimelineEntryV1[] };
    const current = entries.find(entry => entry.kind === 'current');
    const saved = entries.filter((entry): entry is Extract<FileVersionTimelineEntryV1, { kind: 'revision' }> =>
      entry.kind === 'revision').sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
    expect(current?.kind).toBe('current');
    if (current?.kind !== 'current' || !saved) throw new Error('The owned document needs a current and saved version.');
    expect(current.displayRevisionId).toBe(saved.revisionId);
    expect(current.revisionId, 'The physical write fence remains distinct from immutable agent history.').not.toBe(saved.revisionId);
    expect(saved.content.sha256).toBe(written.details?.afterSha256);
    expect(current.sha256).toBe(saved.content.sha256);
    await page.getByRole('button', { name: /^(?:Version history|Versionshistorie)(?: \(view only\)| \(nur ansehen\))?$/iu }).click();
    const center = page.getByTestId('file-version-center');
    await expect(center).toBeVisible();
    await expect(center.locator('button[data-entry-kind="current"]')).toContainText(`Version ${saved.revisionNumber}`);
    await expect(center.locator('button[data-entry-kind="revision"]')).toHaveCount(before);
  }, { initialReviewRequired: false, bindToolSessionToFixture: true });
});

test('three distant exact edits in one patch create one physical checkpoint and one revision', async ({ browser }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the local collaboration stack.');
  test.setTimeout(120_000);
  const lines = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}: original`);
  const initial = `${lines.join('\n')}\n`;
  const edited = [...lines];
  for (const number of [10, 40, 60]) edited[number - 1] = `Line ${number}: updated`;
  const expected = `${edited.join('\n')}\n`;
  await withOrdinaryAgentDocument(browser, initial, async ({ filePath, agentContext, content, revisionCount, page }) => {
    await expect(page.locator('[data-file-review-policy]').getByRole('switch')).not.toBeChecked();
    const before = await revisionCount();
    const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-direct-patch-${randomUUID()}`,
      params: { path: filePath }, context: agentContext }, { inProcess: true });
    expect(read.isError).not.toBe(true);
    const callId = `ordinary-direct-patch-${randomUUID()}`;
    const params = { files: [{ path: filePath, expectedSha256: read.details!.sha256,
      edits: [10, 40, 60].map(number => ({ oldText: `Line ${number}: original`, newText: `Line ${number}: updated` })) }] };
    const patch = await runOrdinaryAgentTool({ toolName: 'apply_patch', toolCallId: callId,
      params, context: agentContext }, { inProcess: true });
    expect(patch.isError, patch.details?.code).not.toBe(true);
    expect(patch.details?.results?.[0]?.collaboration).toMatchObject({ reviewRequired: false });
    expect(await content()).toBe(expected);
    const fullPath = path.join(agentContext.workspaceRoot as string, filePath);
    expect(await readFile(fullPath, 'utf8')).toBe(expected);
    expect(await revisionCount()).toBe(before + 1);
    const retry = await runOrdinaryAgentTool({ toolName: 'apply_patch', toolCallId: callId,
      params, context: agentContext }, { inProcess: true });
    expect(retry.isError).not.toBe(true);
    expect(retry.details?.results?.[0]?.collaboration?.operationId)
      .toBe(patch.details?.results?.[0]?.collaboration?.operationId);
    expect(await revisionCount()).toBe(before + 1);
  }, { initialReviewRequired: false, bindToolSessionToFixture: true });
});

for (const reviewRequired of [false, true]) {
  test(`agent Markdown edit without an open collaboration client honors review ${reviewRequired ? 'on' : 'off'}`, async ({ browser }) => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the local collaboration stack.');
    test.setTimeout(120_000);
    const initial = '# Closed editor\n\nStatus: original\n';
    const updated = '# Closed editor\n\nStatus: updated\n';
    await withOrdinaryAgentDocument(browser, initial, async ({ page, filePath, agentContext, content, revisionCount }) => {
      const before = await revisionCount();
      await page.close();
      const read = await runOrdinaryAgentTool({ toolName: 'read',
        toolCallId: `ordinary-closed-editor-${randomUUID()}`,
        params: { path: filePath }, context: agentContext }, { inProcess: true });
      expect(read.isError).not.toBe(true);
      const edit = await runOrdinaryAgentTool({ toolName: 'edit_file',
        toolCallId: `ordinary-closed-editor-${randomUUID()}`,
        params: { path: filePath, oldText: 'Status: original', newText: 'Status: updated',
          expectedSha256: read.details!.sha256 }, context: agentContext }, { inProcess: true });
      expect(edit.isError, edit.details?.code).not.toBe(true);
      expect(edit.details?.collaboration?.reviewRequired).toBe(reviewRequired);
      expect(await content()).toBe(reviewRequired ? initial : updated);
      expect(await readFile(path.join(agentContext.workspaceRoot as string, filePath), 'utf8'))
        .toBe(reviewRequired ? initial : updated);
      expect(await revisionCount()).toBe(before + (reviewRequired ? 0 : 1));
    }, { initialReviewRequired: reviewRequired, bindToolSessionToFixture: true });
  });
}
