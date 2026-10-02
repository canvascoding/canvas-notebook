import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';
import { runLocalAgentTool } from './helpers/local-agent-tool-client';

for (const workspaceKind of ['personal', 'team'] as const) {
  for (const editorOpen of [true, false]) {
    test(`three separate agent edits yield one turn version (${workspaceKind}, editor ${editorOpen ? 'open' : 'closed'})`, async ({ browser }, info) => {
      test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local collaboration stack.');
      test.setTimeout(180_000);
      const lines = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}: original`);
      await withOrdinaryAgentDocument(browser, `${lines.join('\n')}\n`, async fixture => {
        const { agentContext, filePath, content, revisionCount, page } = fixture;
        const socket = process.env.CANVAS_LOCAL_AGENT_TOOL_SOCKET!;
        const control = (turnAction: 'begin' | 'finish') => runLocalAgentTool({
          toolName: 'read', toolCallId: `ordinary-turn-${randomUUID()}`, params: { path: filePath },
          context: agentContext, turnAction }, socket);
        const before = await revisionCount();
        if (!editorOpen) await page.close();
        await control('begin');
        for (const number of [10, 40, 60]) {
          const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-turn-${randomUUID()}`,
            params: { path: filePath }, context: agentContext }, { inProcess: true });
          const edited = await runOrdinaryAgentTool({ toolName: number === 40 ? 'apply_patch' : 'edit_file',
            toolCallId: `ordinary-turn-${randomUUID()}`, context: agentContext,
            params: number === 40 ? { files: [{ path: filePath, expectedSha256: read.details!.sha256,
              edits: [{ oldText: `Line ${number}: original`, newText: `Line ${number}: updated` }] }] }
              : { path: filePath, expectedSha256: read.details!.sha256,
                oldText: `Line ${number}: original`, newText: `Line ${number}: updated` } }, { inProcess: true });
          expect(edited.isError, JSON.stringify(edited.details)).not.toBe(true);
          lines[number - 1] = `Line ${number}: updated`;
          const expected = `${lines.join('\n')}\n`;
          expect(await readFile(path.join(agentContext.workspaceRoot as string, filePath), 'utf8')).toBe(expected);
          expect(await content()).toBe(expected);
          expect(await revisionCount()).toBe(before);
        }
        await control('finish');
        expect(await revisionCount()).toBe(before + 1);
        // A second user request in this same session owns its own version.
        await control('begin');
        const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-turn-${randomUUID()}`,
          params: { path: filePath }, context: agentContext }, { inProcess: true });
        const callId = `ordinary-turn-${randomUUID()}`;
        const params = { path: filePath, expectedSha256: read.details!.sha256,
          oldText: 'Line 80: original', newText: 'Line 80: updated' };
        const edit = await runOrdinaryAgentTool({ toolName: 'edit_file',toolCallId:callId, params,context:agentContext }, { inProcess:true });
        expect(edit.isError).not.toBe(true);
        const retry = await runOrdinaryAgentTool({ toolName:'edit_file',toolCallId:callId,params,context:agentContext }, { inProcess:true });
        expect(retry.isError).not.toBe(true);
        expect(retry.details?.collaboration?.operationId).toBe(edit.details?.collaboration?.operationId);
        await control('finish');
        expect(await revisionCount()).toBe(before + 2);
        if (editorOpen) {
          await page.getByRole('button', { name: /^(?:Version history|Versionshistorie)(?: \(view only\)| \(nur ansehen\))?$/iu }).click();
          const center = page.getByTestId('file-version-center');
          await expect(center).toBeVisible();
          // The latest version is displayed as the current row, once.
          await expect(center.locator('button[data-entry-kind="current"]')).toHaveCount(1);
          await expect(center.locator('button[data-entry-kind="revision"]')).toHaveCount(before + 1);
          const comparison = page.waitForResponse(response => response.url().includes('/api/files/version-center/v1/compare'));
          await center.locator('button[data-entry-kind="revision"]').first().click();
          expect((await comparison).ok()).toBe(true);
          await page.screenshot({ path: info.outputPath('one-version-per-agent-turn.png') });
          await center.getByRole('button', { name: 'Restore version', exact: true }).click();
          const restored = page.waitForResponse(response => response.request().method() === 'POST'
            && response.url().includes('/api/files/version-center/v1/restore'));
          await page.getByRole('button', { name: 'Restore as new version', exact: true }).click();
          expect((await restored).ok()).toBe(true);
          expect(await content()).toBe(`${lines.join('\n')}\n`);
          await expect.poll(() => readFile(path.join(agentContext.workspaceRoot as string, filePath), 'utf8'))
            .toBe(`${lines.join('\n')}\n`);
          expect(await revisionCount()).toBe(before + 3);
        }
      }, { workspaceKind, initialReviewRequired:false, bindToolSessionToFixture:true });
    });
  }
}

test('one turn keeps CRLF and BOM file checkpoints out of the visible history', async ({ browser }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local collaboration stack.');
  test.setTimeout(120_000);
  const initial = '\uFEFF# Format\r\n\r\nFirst: original\r\n\r\nSecond: original\r\n';
  await withOrdinaryAgentDocument(browser, initial, async ({ agentContext, filePath, revisionCount }) => {
    const control = (turnAction: 'begin' | 'finish') => runLocalAgentTool({ toolName: 'read',
      toolCallId: `ordinary-format-${randomUUID()}`, params: { path: filePath }, context: agentContext,
      turnAction }, process.env.CANVAS_LOCAL_AGENT_TOOL_SOCKET!);
    const before = await revisionCount();
    await control('begin');
    let expected = initial;
    for (const label of ['First', 'Second']) {
      const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-format-${randomUUID()}`,
        params: { path: filePath }, context: agentContext }, { inProcess: true });
      const edit = await runOrdinaryAgentTool({ toolName: 'edit_file', toolCallId: `ordinary-format-${randomUUID()}`,
        params: { path: filePath, expectedSha256: read.details!.sha256,
          oldText: `${label}: original`, newText: `${label}: updated` }, context: agentContext }, { inProcess: true });
      expect(edit.isError, JSON.stringify(edit.details)).not.toBe(true);
      expected = expected.replace(`${label}: original`, `${label}: updated`);
      expect(await readFile(path.join(agentContext.workspaceRoot as string, filePath), 'utf8')).toBe(expected);
      expect(await revisionCount()).toBe(before);
    }
    await control('finish');
    expect(await revisionCount()).toBe(before + 1);
  }, { initialReviewRequired: false, bindToolSessionToFixture: true });
});
