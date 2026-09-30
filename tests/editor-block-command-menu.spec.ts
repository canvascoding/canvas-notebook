import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

test('block commands remain above notebook chrome and scroll in short windows', async ({ browser }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(120_000);
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const filePath = `block-menu-${randomUUID()}.md`;
  let workspaceId: string | undefined;

  try {
    const response = await context.request.get('/api/workspaces');
    expect(response.ok()).toBe(true);
    const { workspaces } = await response.json();
    workspaceId = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace')?.id;
    expect(workspaceId).toBeTruthy();
    await context.addInitScript((id) => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspaceId!);
    await uploadWorkspaceTextFile({
      request: context.request, workspaceId: workspaceId!, filePath,
      content: 'Block menu regression\n\nSecond paragraph',
    });
    await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 45_000 });
    if (await editor.getAttribute('contenteditable') !== 'true') {
      await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
    }
    const menu = page.locator('.tiptap-slash-menu');
    const list = menu.locator('.tiptap-slash-command-list');

    for (const height of [720, 480, 360]) {
      await page.setViewportSize({ width: 1280, height });
      await editor.locator('p').first().hover();
      await page.locator('.tiptap-block-drag-handle').click();
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      if (height < 720) {
        const toolbar = await page.getByTestId('notebook-toolbar').boundingBox();
        expect(box!.y).toBeLessThan(toolbar!.y + toolbar!.height);
      }
      // Bounds alone miss stacking-context bugs: chrome can cover a menu that
      // is geometrically inside the viewport. Check the actual hit target.
      expect(await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return [10, 65, rect.height - 10].every((offset) => (
          element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + offset))
        ));
      }), `menu must receive pointer input above notebook chrome at height ${height}`).toBe(true);
      expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await list.hover();
      await page.mouse.wheel(0, 600);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath(`block-menu-${height}.png`) });
      if (height === 360) {
        await list.locator('[cmdk-item]').last().click();
        await expect(page.getByRole('dialog', { name: 'Insert collapsible section' })).toBeVisible();
      } else {
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }
    }
  } finally {
    await page.goto('about:blank');
    if (workspaceId) {
      await context.request.delete('/api/files/delete', {
        headers: { 'x-canvas-workspace-id': workspaceId }, data: { path: filePath },
      });
    }
    await context.close();
  }
});
