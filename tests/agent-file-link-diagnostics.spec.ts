import { expect, test, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { WorkspaceLinkDiagnostics } from '../app/lib/markdown/workspace-link-diagnostics';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool, type OrdinaryAgentToolDetails } from './helpers/ordinary-agent-tool';

type LinkToolDetails = OrdinaryAgentToolDetails & {
  linkDiagnostics?: WorkspaceLinkDiagnostics;
  results?: LinkToolDetails[];
};
type LinkToolResult = {
  isError?: boolean;
  details?: LinkToolDetails;
  content?: Array<{ type: string; text?: string }>;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function brokenReferences(page: Page, filePath: string, targets: string[]) {
  await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`);
  const panel = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Cross-references' }) });
  await panel.locator('summary').click();
  const tab = panel.getByRole('tab', { name: `Broken links (${targets.length})`, exact: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
  const list = panel.getByRole('tabpanel');
  for (const target of targets) await expect(list.getByText(target, { exact: true })).toBeVisible();
  await expect(list.getByText('Document not found', { exact: true })).toHaveCount(targets.length);
  return panel;
}

test('ordinary file tools return local link diagnostics matching desktop and mobile cross-references', async ({ browser }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local in-process agent tool host.');
  test.setTimeout(180_000);
  const existingTarget = `already-missing-${randomUUID()}.md`;
  const imageTarget = `missing-image-${randomUUID()}.jpg`;
  const documentTarget = `missing-document-${randomUUID()}.md`;
  const initial = `# Link check\n\n[Existing](${existingTarget})\n\nStatus: initial\n`;
  const written = `# Link check\n\n[Existing](${existingTarget})\n\n![Hero](${imageTarget})\n\n[Document](${documentTarget})\n\n[External](https://example.com)\n\nStatus: written\n`;
  await withOrdinaryAgentDocument(browser, initial, async ({ page, filePath, agentContext, content, revisionCount }) => {
    const run = async (toolName: 'read' | 'write' | 'edit_file' | 'apply_patch', params: Record<string, unknown>,
      toolCallId = `ordinary-link-check-${randomUUID()}`): Promise<LinkToolResult> => {
      const result = await runOrdinaryAgentTool({ toolName, toolCallId, params, context: agentContext }, { inProcess: true }) as LinkToolResult;
      expect(result.isError, result.details?.code).not.toBe(true);
      return result;
    };
    const before = await revisionCount();
    const read = await run('read', { path: filePath });
    const write = await run('write', { path: filePath, content: written, expectedSha256: read.details!.sha256 });
    expect(write.details?.linkDiagnostics).toMatchObject({ sourcePath: filePath, contentSha256: sha256(written),
      basis: 'applied', counts: { checked: 3, resolved: 0, missing: 3, ambiguous: 0, unverified: 0 } });
    expect(write.details?.linkDiagnostics?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: existingTarget, status: 'missing', change: 'existing' }),
      expect.objectContaining({ target: imageTarget, status: 'missing', change: 'introduced' }),
      expect.objectContaining({ target: documentTarget, status: 'missing', change: 'introduced' }),
    ]));
    expect(write.content?.filter(item => item.type === 'text').map(item => item.text).join('\n')).toContain('Local link check');
    expect(await content()).toBe(written);
    expect(await revisionCount()).toBe(before + 1);
    let panel = await brokenReferences(page, filePath, [existingTarget, imageTarget, documentTarget]);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('local-link-diagnostics-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    panel = await brokenReferences(page, filePath, [existingTarget, imageTarget, documentTarget]);
    await panel.scrollIntoViewIfNeeded();
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    expect(bounds!.width).toBeGreaterThan(200);
    await page.screenshot({ path: info.outputPath('local-link-diagnostics-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1500, height: 950 });
    const editRead = await run('read', { path: filePath });
    const edited = written.replace('Status: written', 'Status: edited');
    const edit = await run('edit_file', { path: filePath, expectedSha256: editRead.details!.sha256,
      oldText: 'Status: written', newText: 'Status: edited' });
    expect(edit.details?.linkDiagnostics).toMatchObject({ basis: 'applied', contentSha256: sha256(edited),
      counts: { checked: 3, resolved: 0, missing: 3 } });
    expect(edit.details?.linkDiagnostics?.issues.every(issue => issue.change === 'existing')).toBe(true);
    expect(await content()).toBe(edited);
    expect(await revisionCount()).toBe(before + 2);
    const repairRead = await run('read', { path: filePath });
    const repaired = edited.replace(`(${documentTarget})`, `(${filePath})`);
    const repairWrite = await run('write', { path: filePath, content: repaired, expectedSha256: repairRead.details!.sha256 });
    expect(repairWrite.details?.linkDiagnostics).toMatchObject({ basis: 'applied', contentSha256: sha256(repaired),
      counts: { checked: 3, resolved: 1, missing: 2 } });
    expect(await content()).toBe(repaired);
    expect(await revisionCount()).toBe(before + 3);
    const patchRead = await run('read', { path: filePath });
    const patched = repaired.replace('Status: edited', 'Status: patched');
    const patchParams = { files: [{ path: filePath, expectedSha256: patchRead.details!.sha256,
      edits: [{ oldText: 'Status: edited', newText: 'Status: patched' }] }] };
    const patchCallId = `ordinary-link-patch-${randomUUID()}`;
    const patch = await run('apply_patch', patchParams, patchCallId);
    expect(patch.details?.results?.[0]?.linkDiagnostics).toMatchObject({ basis: 'applied', contentSha256: sha256(patched),
      counts: { checked: 3, resolved: 1, missing: 2 } });
    expect(patch.details?.results?.[0]?.linkDiagnostics?.issues.every(issue => issue.change === 'existing')).toBe(true);
    expect(await content()).toBe(patched);
    expect(await revisionCount()).toBe(before + 4);
    const retry = await run('apply_patch', patchParams, patchCallId);
    expect(retry.details?.results?.[0]?.collaboration?.operationId).toBe(patch.details?.results?.[0]?.collaboration?.operationId);
    expect(retry.details?.results?.[0]?.linkDiagnostics).toMatchObject({ basis: 'current', contentSha256: sha256(patched),
      counts: { checked: 3, resolved: 1, missing: 2 } });
    expect(await revisionCount()).toBe(before + 4);
    await brokenReferences(page, filePath, [existingTarget, imageTarget]);
    await info.attach('ordinary-link-diagnostics-results.json', { contentType: 'application/json',
      body: JSON.stringify({ write: write.details?.linkDiagnostics, edit: edit.details?.linkDiagnostics,
        repairWrite: repairWrite.details?.linkDiagnostics,
        patch: patch.details?.results?.[0]?.linkDiagnostics, retry: retry.details?.results?.[0]?.linkDiagnostics }) });
  }, { initialReviewRequired: false, bindToolSessionToFixture: true });
});

test('review-required edits diagnose proposed links while leaving current content and review controls intact', async ({ browser }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local in-process agent tool host.');
  test.setTimeout(120_000);
  const existingTarget = `existing-review-missing-${randomUUID()}.md`;
  const proposedTarget = `proposed-missing-${randomUUID()}.md`;
  const initial = `# Review link check\n\n[Existing](${existingTarget})\n\nStatus: initial\n`;
  const replacement = `Status: proposed\n\n[Proposed](${proposedTarget})`;
  const proposed = initial.replace('Status: initial', replacement);
  await withOrdinaryAgentDocument(browser, initial, async ({ page, filePath, target, agentContext, content, revisionCount }) => {
    const before = await revisionCount();
    const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-link-review-${randomUUID()}`,
      params: { path: filePath }, context: agentContext }, { inProcess: true });
    expect(read.isError).not.toBe(true);
    const edit = await runOrdinaryAgentTool({ toolName: 'edit_file', toolCallId: `ordinary-link-review-${randomUUID()}`,
      params: { path: filePath, expectedSha256: read.details!.sha256, oldText: 'Status: initial', newText: replacement },
      context: agentContext }, { inProcess: true }) as LinkToolResult;
    expect(edit.isError, edit.details?.code).not.toBe(true);
    expect(edit.details?.outcome).toBe('review_required');
    expect(edit.details?.linkDiagnostics).toMatchObject({ basis: 'proposed', sourcePath: filePath,
      contentSha256: sha256(proposed), counts: { checked: 2, resolved: 0, missing: 2 } });
    expect(edit.details?.linkDiagnostics?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: existingTarget, change: 'existing' }),
      expect.objectContaining({ target: proposedTarget, change: 'introduced' }),
    ]));
    expect(edit.details?.linkDiagnostics?.contentSha256).not.toBe(sha256(initial));
    expect(edit.content?.filter(item => item.type === 'text').map(item => item.text).join('\n')).toContain('Local link check');
    expect(await content()).toBe(initial);
    expect(await revisionCount()).toBe(before);
    await brokenReferences(page, filePath, [existingTarget]);
    const operationId = edit.details?.proposal?.operationId;
    expect(operationId).toBeTruthy();
    await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
      selectedEntry: { kind: 'agent_operation', id: operationId! }, initialView: 'reviews', source: 'deep_link' }));
    const graph = page.getByTestId('graph-review-comparison');
    await expect(graph).toBeVisible({ timeout: 30_000 });
    await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled();
    await expect(graph.getByRole('button', { name: 'Reject proposal', exact: true })).toBeEnabled();
    await info.attach('proposed-link-diagnostics-review.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
    await graph.getByRole('button', { name: 'Reject proposal', exact: true }).click();
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
    await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).phase).toBe('succeeded');
    expect(await content()).toBe(initial);
    expect(await revisionCount()).toBe(before);
    await info.attach('proposed-link-diagnostics.json', { contentType: 'application/json', body: JSON.stringify(edit.details?.linkDiagnostics) });
  }, { initialReviewRequired: true, bindToolSessionToFixture: true });
});
