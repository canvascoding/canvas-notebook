import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createAuthenticatedContext, enterMarkdownEditMode, uploadWorkspaceTextFile } from './helpers/managed-test-context';

test('Mermaid renders math with the shared patched KaTeX after reload', async ({ browser }, testInfo) => {
  const context = await createAuthenticatedContext(browser);
  const filePath = `security-mermaid-${randomUUID()}.md`;
  let workspaceId: string | undefined;
  try {
    const response = await context.request.get('/api/workspaces');
    expect(response.ok()).toBeTruthy();
    const payload = await response.json() as { workspaces: Array<{ id: string; permissions: { canWrite: boolean } }> };
    workspaceId = payload.workspaces.find(workspace => workspace.permissions.canWrite)?.id;
    expect(workspaceId).toBeTruthy();
    await context.addInitScript(id => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspaceId!);
    await uploadWorkspaceTextFile({ request: context.request, workspaceId: workspaceId!, filePath,
      content: '# Mermaid math\n\n```mermaid\nflowchart LR\n A["$$E=mc^2$$"] --> B["Patched renderer"]\n```\n' });
    const page = await context.newPage();
    await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
    await enterMarkdownEditMode(page);
    const diagram = page.locator('.tiptap-mermaid-node');
    await expect(diagram.locator('svg').first()).toBeVisible({ timeout: 30_000 });
    await expect(diagram.locator('.katex').first()).toBeVisible();
    await expect(diagram).toContainText('Patched renderer');
    await page.screenshot({ path: testInfo.outputPath('mermaid-math.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(diagram.locator('svg').first()).toBeVisible({ timeout: 30_000 });
    await expect(diagram.locator('.katex').first()).toBeVisible();
  } finally {
    if (workspaceId) {
      const removed = await context.request.delete('/api/files/delete', {
        headers: { 'x-canvas-workspace-id': workspaceId }, data: { path: filePath },
      });
      expect(removed.ok(), 'Remove only the owned Mermaid fixture').toBeTruthy();
    }
    await context.close();
  }
});
