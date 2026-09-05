import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

let loginCookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;

async function prepare(page: Page) {
  if (loginCookies) {
    await page.context().addCookies(loginCookies);
  } else {
    const response = await page.request.post('/api/auth/sign-in/email', {
      headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
      data: { email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD },
    });
    expect(response.ok()).toBeTruthy();
    loginCookies = await page.context().cookies();
  }
  const workspaces = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.workspaces.find((item: { type: string; permissions: { canWrite: boolean } }) => item.type === 'personal' && item.permissions.canWrite);
  expect(workspace).toBeTruthy();
  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  return workspace.id as string;
}

for (const width of [390, 768, 1440]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 1024, hasTouch: width < 1024 });
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
        await expect(page.locator('[data-prompt-hero-textarea]')).not.toBeFocused();
        await page.screenshot({ path: info.outputPath(`home-${width}-initial.png`) });
        await expect(page.locator('#home-suggestions')).toHaveCount(0);
        await page.getByRole('button', { name: 'Ideen und Beispiele' }).click();
        await expect(page.locator('#home-suggestions')).toBeVisible();
        await page.getByRole('button', { name: 'Ideen und Beispiele' }).click();
        await expect(page.locator('#home-suggestions')).toHaveCount(0);
        await page.locator('[data-prompt-hero-textarea]').focus();
        await expect(page.getByTestId('home-agent-id')).toBeVisible();
        const modeTabs = page.getByRole('tablist', { name: 'Arbeitsmodus' });
        await modeTabs.getByRole('tab', { name: 'Studio', exact: true }).click();
        await expect(modeTabs.getByRole('tab', { name: 'Studio', exact: true })).toHaveAttribute('aria-selected', 'true');
        await modeTabs.getByRole('tab', { name: 'Notebook', exact: true }).click();
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
  });
}

for (const width of [390, 1440]) {
  test.describe(`note creation ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 1024, hasTouch: width < 1024 });
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
        await page.getByText('Anderen Ordner wählen', { exact: true }).first().click();
        await expect(page.getByLabel('Anderen Ordner wählen')).toBeVisible();
        await page.getByText('Anderen Ordner wählen', { exact: true }).first().click();
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

  });
}

for (const width of [390, 1440]) {
  test.describe(`workflows ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 1024, hasTouch: width < 1024 });
    test('file views, import, empty search and request recovery', async ({ page }, info) => {
      const workspaceId = await prepare(page);
      const headers = { 'x-canvas-workspace-id': workspaceId };
      const prefix = `home-qa-${randomUUID()}`;
      const paths: string[] = [];
      try {
        for (let i = 0; i < 7; i++) {
          const path = `${prefix}-${i}.md`;
          expect((await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } })).ok()).toBeTruthy();
          paths.push(path);
          expect((await page.request.post('/api/files/quick-access', { headers, data: { path } })).ok()).toBeTruthy();
        }
        expect((await page.request.patch('/api/files/metadata', { headers, data: { path: paths[6], isFavorite: true, pinned: true } })).ok()).toBeTruthy();
        await page.goto('/de');
        const files = page.getByTestId('home-files');
        const rows = files.locator('ul > li');
        await expect(rows).toHaveCount(5);
        await files.getByRole('button', { name: 'Zuletzt geöffnet', exact: true }).click();
        await expect(rows).toHaveCount(5);
        await files.getByRole('button', { name: 'Weitere Dateien anzeigen' }).click();
        await expect(rows.filter({ hasText: prefix })).toHaveCount(7);
        await files.getByRole('button', { name: 'Weniger anzeigen' }).click();
        await expect(rows).toHaveCount(5);
        await files.getByRole('button', { name: 'Favoriten', exact: true }).click();
        await expect(files.locator(`ul a[href*="${paths[6]}"]`)).toBeVisible();
        await files.getByRole('button', { name: 'Favoriten', exact: true }).click();
        await expect(files.locator(`ul a[href*="${paths[6]}"]`)).toBeVisible();
        await files.getByText('Weitere Ansichten', { exact: true }).click();
        await files.getByRole('button', { name: 'Häufig geöffnet', exact: true }).click();
        await expect(rows.filter({ hasText: prefix })).toHaveCount(7);
        await files.getByText('Weitere Ansichten', { exact: true }).click();
        await files.getByRole('button', { name: 'Deine Dateien', exact: true }).click();
        const search = files.getByRole('textbox', { name: 'Notizen und Dateien suchen …' });
        await search.fill(`${prefix}-missing`);
        await expect(files.getByText('Keine passenden Dateien')).toBeVisible();
        await files.getByRole('button', { name: 'Suche löschen' }).click();
        await expect(files.getByText('Keine passenden Dateien')).toHaveCount(0);
        const importPath = `${prefix}-import.txt`;
        paths.push(importPath);
        await files.locator('input[type=file]').setInputFiles({ name: importPath, mimeType: 'text/plain', buffer: Buffer.from('Playwright homepage import fixture') });
        await expect(files.getByRole('button', { name: 'Dateien importieren', exact: true })).toBeEnabled();
        await search.fill(importPath);
        await expect(files.locator(`ul a[href*="${importPath}"]`)).toBeVisible();
        await page.screenshot({ path: info.outputPath(`home-${width}-search.png`) });
        await page.route('**/api/files/quick-access?**', route => route.fulfill({ status: 503, json: { success: false } }));
        await files.getByRole('button', { name: 'Suche löschen' }).click();
        await expect(files.getByRole('alert')).toHaveText('Deine Dateien konnten nicht geladen werden.');
        await page.unroute('**/api/files/quick-access?**');
        await files.getByRole('button', { name: 'Erneut versuchen' }).click();
        await expect(files.getByRole('alert')).toHaveCount(0);
        await search.fill(importPath);
        await files.locator(`ul a[href*="${importPath}"]`).click();
        await expect(page).toHaveURL(/\/notebook\?/);
        await expect(page.getByText('Playwright homepage import fixture', { exact: false }).first()).toBeVisible();
      } finally {
        if (paths.length) expect((await page.request.delete('/api/files/delete', { headers, data: { path: paths } })).ok()).toBeTruthy();
      }
    });

    test('notification actions and disclosure with controlled fixtures', async ({ page }, info) => {
      const workspaceId = await prepare(page);
      let items = Array.from({ length: 5 }, (_, i) => ({ id: `qa-studio-${i}`, type: 'studio.completed', title: `QA Bild ${i + 1} ist fertig`, detail: 'Ergebnis ansehen und im Projekt weiterverwenden.', occurredAt: new Date(Date.now() - i * 1000).toISOString(), unread: true, priority: 'normal', workspaceId, workspaceName: 'QA Workspace', target: { kind: 'studio', generationId: `qa-generation-${i}` } }));
      let failAction = false;
      await page.route('**/api/notifications/summary', async route => {
        if (route.request().method() === 'PATCH') {
          if (failAction) return route.fulfill({ status: 503, json: { success: false } });
          const body = route.request().postDataJSON();
          items = items.filter(item => item.id !== body.itemId);
          return route.fulfill({ json: { success: true } });
        }
        return route.fulfill({ json: { success: true, data: { unreadCount: items.length, counts: { unread: items.length, chat: 0, todos: 0, todoUnread: 0, todoAttention: 0, emailAttention: 0, studio: items.length, automation: 0 }, items, sections: { notifications: items, todos: [], todoUnread: [], todoAttention: [], emailAttention: [] } } } });
      });
      await page.goto('/de');
      const panel = page.getByRole('complementary', { name: 'Benachrichtigungen' });
      await expect(page.getByTestId('home-files').locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
      if (width < 1024) {
        await expect(panel.locator('ul')).toBeHidden();
        await panel.getByRole('button', { name: 'Benachrichtigungen anzeigen', exact: true }).click();
        await expect(panel.locator('li')).toHaveCount(5);
      } else {
        await expect(panel.locator('li')).toHaveCount(3);
        await panel.getByRole('button', { name: '2 weitere Hinweise anzeigen' }).click();
        await expect(panel.locator('li')).toHaveCount(5);
      }
      await expect(panel.getByRole('link').first()).toHaveAttribute('href', `/de/studio?generation=qa-generation-0&workspaceId=${workspaceId}`);
      const panelBounds = await panel.boundingBox();
      expect(panelBounds).not.toBeNull();
      for (const button of await panel.locator('li button').all()) {
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width);
      }
      await page.screenshot({ path: info.outputPath(`home-${width}-notifications.png`), fullPage: true });
      await panel.locator('li').first().screenshot({ path: info.outputPath(`home-${width}-notification-actions.png`), animations: 'disabled' });
      failAction = true;
      await panel.getByRole('button', { name: 'Als gelesen markieren' }).first().click();
      await expect(panel.getByRole('alert')).toBeVisible();
      failAction = false;
      await panel.getByRole('button', { name: 'Als gelesen markieren' }).first().click();
      await expect(panel.getByText('QA Bild 1 ist fertig')).toHaveCount(0);
      await panel.getByRole('button', { name: 'Aus Benachrichtigungen entfernen' }).first().click();
      await expect(panel.getByText('QA Bild 2 ist fertig')).toHaveCount(0);
      if (width < 1024) {
        await panel.getByRole('button', { name: 'Weniger anzeigen', exact: true }).first().click();
        await expect(panel.locator('ul')).toBeHidden();
      }
      const moreTools = page.getByRole('button', { name: 'Weitere Tools', exact: true });
      await expect(page.locator('#home-more-tools')).toHaveCount(0);
      await moreTools.click();
      await expect(page.locator('#home-more-tools')).toBeVisible();
      await moreTools.click();
      await expect(page.locator('#home-more-tools')).toHaveCount(0);
    });
  });
}

for (const width of [390, 1440]) {
  test.describe(`account menu ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 1024, hasTouch: width < 1024 });
    test('profile menu opens settings and signs out through the real session', async ({ page }, info) => {
      await prepare(page);
      await page.goto('/de');
      await expect(page.getByTestId('home-files')).toBeVisible();
      await expect(page.getByTestId('home-files').locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
      const trigger = page.getByRole('button', { name: /^Benutzermenü für/ });
      await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toHaveCount(0);
      if (width < 1024) await trigger.tap(); else await trigger.click();
      await expect(page.getByRole('menuitem', { name: 'Einstellungen', exact: true })).toBeVisible();
      const bounds = await page.getByRole('menu').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`home-${width}-account-menu.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Einstellungen', exact: true }).click();
      await expect(page).toHaveURL(/\/de\/settings/);
      await page.goto('/de');
      await page.getByRole('button', { name: /^Benutzermenü für/ }).click();
      const signOut = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-out') && response.request().method() === 'POST');
      await page.getByRole('menuitem', { name: 'Abmelden', exact: true }).click();
      expect((await signOut).ok()).toBeTruthy();
      loginCookies = undefined;
      await expect(page).toHaveURL(/\/de\/login/);
      await page.goto('/de');
      await expect(page).toHaveURL(/\/de\/login/);
    });
  });
}
