import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import { createAuthenticatedContext } from './helpers/managed-test-context';

test('HEIF workspace uploads convert to a JPEG that opens in the image viewer', async ({ browser }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed document runtime.');
  test.setTimeout(90_000);
  const context = await createAuthenticatedContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { workspaces } = await (await context.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string; permissions: { canWrite: boolean } }) =>
    entry.name === 'Shared Test Workspace' && entry.permissions.canWrite);
  expect(workspace).toBeTruthy();
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const name = `security-heif-${randomUUID()}`;
  await context.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  try {
    const uploaded = await context.request.post('/api/files/upload', { headers, multipart: {
      path: '.', files: { name: `${name}.heic`, mimeType: 'image/heic',
        buffer: await readFile('tests/fixtures/security-image.heic') },
    } });
    expect(uploaded.status()).toBe(200);
    expect((await uploaded.json()).files).toEqual([`${name}.jpg`]);
    await page.goto(`/notebook?path=${encodeURIComponent(`${name}.jpg`)}`);
    const image = page.getByTestId('notebook-desktop-document').getByRole('img', { name: `${name}.jpg`, exact: true });
    await expect(image).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => [element.naturalWidth, element.naturalHeight]))
      .toEqual([80, 40]);
    await expect(image).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('heif-upload-converted.png') });
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank').catch(() => undefined);
    await context.request.delete('/api/files/delete', { headers, data: { path: `${name}.jpg` } });
    await context.close();
  }
});
