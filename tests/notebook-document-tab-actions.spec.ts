import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

test('document tabs expose file actions for the clicked file with the explorer hidden', async ({ browser }, info) => {
  test.setTimeout(90_000);
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { type: string }) => entry.type === 'personal');
  const paths = [`tab-actions-a-${randomUUID()}.md`, `tab-actions-b-${randomUUID()}.md`];
  try {
    for (const path of paths) {
      await uploadWorkspaceTextFile({ request: page.request, workspaceId: workspace.id, filePath: path, content: `# ${path}\n\nTab actions QA.\n` });
    }
    await page.addInitScript(id => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, chatDocked: false, explorerOpen: false }));
    }, workspace.id);
    await page.goto(`/de/notebook?workspaceId=${workspace.id}&path=${encodeURIComponent(paths[0])}`);
    const firstTab = page.getByRole('tab', { name: paths[0], exact: true });
    await expect(firstTab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Bearbeiten', exact: true })).toBeVisible();
    await firstTab.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Pfad kopieren', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Umbenennen', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('active-tab-context-menu.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');

    // Open a second document through the URL, retaining the first persisted tab.
    await page.goto(`/de/notebook?workspaceId=${workspace.id}&path=${encodeURIComponent(paths[1])}`);
    const secondTab = page.getByRole('tab', { name: paths[1], exact: true });
    await expect(secondTab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Bearbeiten', exact: true })).toBeVisible();
    await firstTab.click({ button: 'right' });
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await menu.getByRole('menuitem', { name: 'Umbenennen', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(paths[0]);
    await page.keyboard.press('Escape');
    await firstTab.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Im Dateibrowser anzeigen', exact: true }).click();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Bearbeiten', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sidebar ausblenden', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.setViewportSize({ width: 900, height: 700 });
    await secondTab.click({ button: 'right' });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
    await page.screenshot({ path: info.outputPath('inactive-tab-context-menu-small.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await secondTab.click();
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  } finally {
    for (const path of paths) {
      const response = await page.request.delete('/api/files/delete', {
        headers: { 'x-canvas-workspace-id': workspace.id }, data: { path },
      });
      expect(response.ok()).toBeTruthy();
    }
    await context.close();
  }
});
