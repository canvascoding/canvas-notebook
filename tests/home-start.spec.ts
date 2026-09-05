import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function prepare(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  const workspaces = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.workspaces.find((item: { type: string; permissions: { canWrite: boolean } }) => item.type === 'personal' && item.permissions.canWrite);
  expect(workspace).toBeTruthy();
  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  return workspace.id as string;
}

for (const width of [390, 768, 1440]) {
  test(`home keeps work accessible and details optional at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const workspaceId = await prepare(page);
    const path = `home-layout-${randomUUID()}.md`;
    const headers = { 'x-canvas-workspace-id': workspaceId };
    expect((await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } })).ok()).toBeTruthy();
    try {
      expect((await page.request.post('/api/files/quick-access', { headers, data: { path } })).ok()).toBeTruthy();
      await page.goto('/de');
      const files = page.getByTestId('home-files');
      await expect(files.getByRole('heading', { name: 'Weiterarbeiten' })).toBeVisible();
      const newNote = files.getByRole('button', { name: 'Neue Notiz' });
      await expect(newNote).toBeInViewport();
      await expect(files.locator(`a[href*="${path}"]`).first()).toBeInViewport();
      await expect(page.getByTestId('home-agent-id')).toBeHidden();
      await expect(page.locator('#home-suggestions')).toHaveCount(0);
      await page.getByRole('button', { name: 'Ideen und Beispiele' }).click();
      await expect(page.locator('#home-suggestions')).toBeVisible();
      await page.getByRole('button', { name: 'Ideen und Beispiele' }).click();
      await expect(page.locator('#home-suggestions')).toHaveCount(0);
      await page.locator('[data-prompt-hero-textarea]').focus();
      await expect(page.getByTestId('home-agent-id')).toBeVisible();
      if (width < 1024) {
        await expect(page.locator('#home-attention-items')).toBeHidden();
        await page.getByRole('button', { name: 'Benachrichtigungen anzeigen' }).click();
        await expect(page.locator('#home-attention-items')).toBeVisible();
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`home-${width}.png`), fullPage: true });
      await files.getByRole('textbox', { name: 'Notizen und Dateien suchen …' }).fill(path);
      await expect(files.getByRole('link', { name: new RegExp(path.replace('.md', '')) })).toHaveCount(1);
      await files.getByRole('link', { name: new RegExp(path.replace('.md', '')) }).click();
      await expect(page).toHaveURL(new RegExp(`/notebook\\?.*path=${path}`));
    } finally {
      expect((await page.request.delete('/api/files/delete', { headers, data: { path } })).ok()).toBeTruthy();
    }
  });
}

test('a new note opens in the notebook and appears when returning home', async ({ page }) => {
  const workspaceId = await prepare(page);
  const name = `Home note ${randomUUID()}`;
  const path = `${name}.md`;
  const headers = { 'x-canvas-workspace-id': workspaceId };
  let created = false;
  try {
    await page.goto('/de');
    await page.getByTestId('home-files').getByRole('button', { name: 'Neue Notiz' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Anderen Ordner wählen')).toBeHidden();
    await page.getByLabel('Name der Notiz').fill(name);
    const response = page.waitForResponse((item) => item.url().endsWith('/api/files/create') && item.request().method() === 'POST');
    await page.getByRole('button', { name: 'Erstellen und öffnen' }).click();
    expect((await response).ok()).toBeTruthy();
    created = true;
    await expect(page).toHaveURL(/\/notebook\?/);
    await expect.poll(async () => {
      const result = await (await page.request.get('/api/files/quick-access?view=recent', { headers })).json();
      return result.data.files.some((file: { path: string; openedAt: number | null }) => file.path === path && file.openedAt !== null);
    }).toBe(true);
    await page.goto('/de');
    await expect(page.getByTestId('home-files').getByRole('link', { name: new RegExp(name) })).toBeVisible();
  } finally {
    if (created) expect((await page.request.delete('/api/files/delete', { headers, data: { path } })).ok()).toBeTruthy();
  }
});
