import { test, expect } from '@playwright/test';

async function openHome(page: import('@playwright/test').Page) {
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  await page.route('**/api/files/quick-access?*', route => {
    const limit = Number(new URL(route.request().url()).searchParams.get('limit'));
    return route.fulfill({ json: { success: true, data: {
      files: Array.from({ length: Math.min(limit, 20) }, (_, index) => ({ path: `Projektplan-${index}.md`, name: `Projektplan-${index}.md`, title: `Projektplan ${index + 1}` })),
      total: 20, workspaceFileCount: 20, view: 'recent', favorites: [],
    } } });
  });
  await page.route('**/api/home/chats?*', route => route.fulfill({ json: { success: true, data: { chats: [], hasMore: false } } }));
  await page.route('**/api/mobile-app-promotion', route => route.fulfill({ json: { success: true, promotion: { eligible: false } } }));
  await page.goto('/de');
  await expect(page.getByTestId('home-files').locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
}

test('two desktop views snap, navigate with keyboard, and allow long content', async ({ page }, info) => {
  await page.setViewportSize({ width: 1299, height: 847 });
  await openHome(page);
  const nav = page.getByRole('navigation', { name: 'Startseitenansichten' });
  const first = page.locator('#home-continue');
  const second = page.locator('#home-workspace');
  const main = page.locator('[data-home-scroll]');
  await expect(nav.getByRole('button', { name: 'Weiterarbeiten' })).toHaveAttribute('aria-current', 'step');
  await expect(second.getByRole('heading')).not.toBeInViewport();
  await expect(page.locator('[data-prompt-hero-textarea]')).toBeInViewport();
  await expect.poll(() => main.evaluate(el => getComputedStyle(el).scrollSnapType)).toBe('y mandatory');
  await page.screenshot({ path: info.outputPath('desktop-work.png') });
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 650);
  await expect(nav.getByRole('button', { name: 'Workspace', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect.poll(async () => Math.abs((await second.boundingBox())!.y - (await main.boundingBox())!.y)).toBeLessThan(2);
  await expect(second.getByRole('link', { name: /E-Mail/ })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('desktop-workspace.png') });
  await nav.getByRole('button', { name: 'Weiterarbeiten' }).focus();
  await page.keyboard.press('Enter');
  await expect(first).toBeFocused();
  await expect(nav.getByRole('button', { name: 'Weiterarbeiten' })).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Weitere anzeigen' }).click();
  await expect(page.getByTestId('home-files').locator('li')).toHaveCount(10);
  await expect.poll(() => main.evaluate(el => getComputedStyle(el).scrollSnapType)).toBe('none');
  await page.getByRole('button', { name: 'Weniger anzeigen', exact: true }).click();
  await expect(page.getByTestId('home-files').locator('li')).toHaveCount(3);
  await expect.poll(() => main.evaluate(el => getComputedStyle(el).scrollSnapType)).toBe('y mandatory');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await nav.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(second).toBeFocused();
  await expect.poll(async () => Math.abs((await second.boundingBox())!.y - (await main.boundingBox())!.y)).toBeLessThan(2);
  await page.setViewportSize({ width: 1299, height: 600 });
  await expect.poll(() => main.evaluate(el => getComputedStyle(el).scrollSnapType)).toBe('none');
});

for (const width of [390, 768]) {
  test(`small ${width}px view scrolls normally and keeps workspace reachable`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await openHome(page);
    await expect(page.getByRole('navigation', { name: 'Startseitenansichten' })).toBeHidden();
    await expect.poll(() => page.locator('[data-home-scroll]').evaluate(el => getComputedStyle(el).scrollSnapType)).toBe('none');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`mobile-${width}-work.png`) });
    await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
    await expect(page.locator('#home-workspace')).toBeFocused();
    await expect.poll(async () => Math.abs((await page.locator('#home-workspace').boundingBox())!.y - (await page.locator('[data-home-scroll]').boundingBox())!.y)).toBeLessThan(2);
    await expect(page.locator('#home-workspace').getByRole('link', { name: /E-Mail/ })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`mobile-${width}-workspace.png`) });
    await page.getByRole('button', { name: 'Zurück zum Weiterarbeiten' }).click();
    await expect(page.locator('#home-continue')).toBeFocused();
  });
}

test('tools stay in the launcher and its existing pages retain their entries', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  await expect(page.getByRole('button', { name: 'Weitere Tools', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Apps öffnen' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Terminal', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Weitere Apps', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: 'Terminal', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Browser Lab', exact: true })).toHaveAttribute('href', '/de/browser/lab');
  await menu.getByRole('menuitem', { name: 'Zurück zum Schnellzugriff' }).click();
  await menu.getByRole('menuitem', { name: 'Dateien', exact: true }).click();
  await expect(page).toHaveURL(/\/de\/files/, { timeout: 15000 });
  await page.getByRole('button', { name: 'Apps öffnen' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Terminal', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Weitere Apps', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: 'Terminal', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Browser Lab', exact: true })).toHaveCount(0);
});

test('dark mode keeps both views legible and reduced motion skips scrolling animation', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await openHome(page);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: info.outputPath('dark-work.png'), animations: 'disabled' });
  await page.getByRole('navigation', { name: 'Startseitenansichten' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect.poll(async () => Math.abs((await page.locator('#home-workspace').boundingBox())!.y - (await page.locator('[data-home-scroll]').boundingBox())!.y)).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath('dark-workspace.png'), animations: 'disabled' });
});

for (const width of [390, 1440]) {
  test(`launcher prioritizes apps and preserves actions at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openHome(page);
    await expect(page.locator('#home-workspace a[href="/de/knowledge-graph"]')).toHaveCount(0);
    const trigger = page.getByRole('button', { name: 'Apps öffnen' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Apps öffnen' });
    const notebook = menu.getByRole('menuitem', { name: 'Notebook', exact: true });
    await expect(notebook).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Dateien', exact: true })).toBeFocused();
    await expect(menu.locator('a[href]')).toHaveCount(5);
    await expect(menu.getByRole('menuitem', { name: 'Dokument-Graph', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`launcher-${width}-quick.png`), animations: 'disabled' });
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await menu.getByRole('menuitem', { name: 'Studio-Aktionen öffnen' }).click();
    const actions = width < 768 ? page.getByRole('dialog') : menu;
    await expect(actions.getByRole(width < 768 ? 'link' : 'menuitem', { name: 'In neuem Tab öffnen' })).toHaveAttribute('href', '/de/studio');
    if (width < 768) {
      await expect(page.locator('[role=menu]')).toHaveCount(0);
      await expect.poll(() => actions.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(actions).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Weitere Apps', exact: true }).click();
    await expect(menu.getByRole('menuitem', { name: 'Dokument-Graph', exact: true })).toHaveAttribute('href', '/de/knowledge-graph');
    await expect(menu.getByRole('menuitem', { name: 'Automationen', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Notebook', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`launcher-${width}-more.png`), animations: 'disabled' });
    await menu.getByRole('menuitem', { name: 'Einstellungen-Aktionen öffnen' }).click();
    await expect(actions.locator('a[href="/de/settings?tab=integrations"]')).toBeVisible();
    if (width < 768) {
      await expect(page.locator('[role=menu]')).toHaveCount(0);
      await expect.poll(() => actions.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(actions).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(notebook).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Dokument-Graph', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });
}
