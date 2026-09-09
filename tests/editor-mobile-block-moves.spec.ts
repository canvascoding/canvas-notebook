import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('mobile block menu retains its anchor after toolbar focus is lost', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(60_000);
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const filePath = `editor-mobile-moves-${randomUUID()}.md`;
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('Alpha\n\nBravo\n\nCharlie'),
  } } })).ok()).toBe(true);
  try {
    await page.goto(`/notebook?path=${filePath}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    // The development badge overlaps the first mobile control; hide it through
    // its own UI. Production has no badge. Do not change application styles.
    const devTools = page.getByRole('button', { name: 'Open Next.js Dev Tools', exact: true });
    if (await devTools.count()) {
      await devTools.click();
      await page.getByText('Preferences', { exact: true }).click();
      await page.getByRole('button', { name: 'Hide', exact: true }).click();
    }
    const order = () => editor.locator(':scope > [data-id]').evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute('data-id'), text: element.textContent,
    })));
    const initial = await order();
    await editor.getByText('Bravo', { exact: true }).tap();
    // Model the reduced content area, not an operating-system IME.
    await page.setViewportSize({ width: 390, height: 544 });
    const trigger = page.getByTestId('markdown-mobile-move-block');
    await trigger.tap();
    // Exceed the toolbar's one-second pointer-interaction grace period.
    await page.waitForTimeout(1_200);
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box?.width).toBe(40);
    await page.screenshot({ path: info.outputPath('mobile-block-menu.png') });
    await page.getByRole('menuitem', { name: /^Move block up/ }).tap();
    await expect.poll(order).toEqual([initial[1], initial[0], initial[2]]);
    await page.getByRole('button', { name: 'Undo', exact: true }).filter({ visible: true }).tap();
    await expect.poll(order).toEqual(initial);
    await trigger.tap();
    await page.waitForTimeout(1_200);
    await page.getByRole('menuitem', { name: /^Move block down/ }).tap();
    await expect.poll(order).toEqual([initial[0], initial[2], initial[1]]);
    await expect(page.getByTestId('markdown-save-state')).toContainText('File checkpoint current');
  } finally {
    await page.close();
    await page.request.delete('/api/files/delete', { headers, data: { path: filePath } });
  }
});
