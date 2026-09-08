import { expect, test, type Page } from '@playwright/test';

async function prepare(page: Page) {
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((candidate: { type: string }) => candidate.type === 'personal');
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  await page.route('**/api/files/quick-access?*', route => route.fulfill({ json: { success: true, data: { files: [], total: 0, workspaceFileCount: 0, view: 'recent', favorites: [] } } }));
  await page.route('**/api/home/chats?*', route => route.fulfill({ json: { success: true, data: { chats: [], hasMore: false } } }));
  await page.route('**/api/mobile-app-promotion', route => route.fulfill({ json: { success: true, promotion: { eligible: false } } }));
  return workspace as { id: string };
}

async function mockWidgets(page: Page, workspaceId: string, options: {
  brokenStudioImage?: boolean;
  failEmail?: boolean;
  longAutomationResult?: boolean;
} = {}) {
  const widgetRequests: string[] = [];
  await page.route('**/api/home/workspace-widgets?*', route => {
    widgetRequests.push(route.request().url());
    expect(new URL(route.request().url()).searchParams.get('workspaceId')).toBe(workspaceId);
    const cachedAt = '2026-09-08T12:00:00.000Z';
    const ready = <T,>(data: T) => ({ status: 'ready' as const, data, cachedAt, stale: false });
    return route.fulfill({ json: { success: true, data: {
      emails: options.failEmail ? { status: 'error', errorCode: 'source_unavailable' } : ready([
        { id: 'mail-sales', accountId: 'sales', accountLabel: 'sales@example.com', folder: 'INBOX', from: 'Mara', subject: 'Launch-Freigabe', date: '2026-09-07T12:00:00Z' },
        { id: 'mail-primary', accountId: 'primary', accountLabel: 'team@example.com', folder: 'INBOX', from: 'Jonas', subject: 'Wochenplanung', date: '2026-09-07T11:00:00Z' },
      ]),
      todos: ready([{ id: 'todo-critical', title: 'Launch prüfen', priority: 'high', dueAt: '2026-09-08T10:00:00Z', readState: 'unread' }]),
      automation: ready({ id: 'job-latest', name: 'Kampagnen-Report', status: 'active', lastRunAt: '2026-09-07T12:00:00Z', lastRunStatus: 'success', nextRunAt: '2026-09-08T12:00:00Z', resultText: options.longAutomationResult
        ? '**Aktuelle Woche:** KW 36\n- **Wöchentliche Follower-Zahlen** fehlen vollständig für Instagram, LinkedIn, X und mehrere weitere Kanäle mit einem absichtlich sehrlangenwortohnetrennzeichen'.repeat(4)
        : 'Kampagnendaten wurden aktualisiert.' }),
      studio: ready({ id: 'generation-latest', prompt: 'Editoriales Produktbild für den Launch', createdAt: '2026-09-07T12:00:00Z', status: 'completed', output: { id: 'output', mediaUrl: options.brokenStudioImage ? '/images/missing-widget-preview.png' : '/images/examples/aura_serum_produktfoto.png', mimeType: 'image/png' } }),
    } } });
  });
  return widgetRequests;
}

test('workspace widgets fill page two and progressively reveal quick selections', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  const requests = await mockWidgets(page, workspace.id);
  await page.goto('/de');
  expect(requests).toHaveLength(0);

  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const workspacePage = page.locator('#home-workspace');
  const cards = workspacePage.locator('article[data-testid^="workspace-widget-"]');
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId('workspace-widget-email-summary').getByText('2 ungelesene Nachrichten')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-todos-summary').getByText('Launch prüfen')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-automation-summary').getByText('Kampagnen-Report')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-studio-summary').getByText('Editoriales Produktbild für den Launch')).toBeVisible();
  await expect.poll(() => page.getByTestId('workspace-widget-studio-summary').locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);

  const emailCard = page.getByTestId('workspace-widget-email');
  const emailQuickSelection = page.getByTestId('workspace-widget-email-quick-selection');
  await expect(emailQuickSelection.getByText('Launch-Freigabe')).toBeHidden();
  await emailCard.hover();
  await expect(emailQuickSelection.getByText('Launch-Freigabe')).toBeVisible();
  await expect(emailCard.getByRole('link', { name: /Launch-Freigabe/ })).toHaveAttribute('href', /accountId=sales.*messageId=mail-sales/);

  const todoCard = page.getByTestId('workspace-widget-todos');
  await todoCard.getByRole('link', { name: 'To-dos öffnen', exact: true }).focus();
  await expect(todoCard.getByText('Schnellauswahl')).toBeVisible();
  await expect(todoCard.getByRole('link', { name: /Launch prüfen/ })).toHaveAttribute('href', new RegExp(`todo=todo-critical.*workspaceId=${workspace.id}`));

  const firstBox = await cards.nth(0).boundingBox();
  const secondBox = await cards.nth(1).boundingBox();
  expect(firstBox?.height).toBeGreaterThanOrEqual(240);
  expect(Math.abs((firstBox?.height ?? 0) - (secondBox?.height ?? 0))).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workspace-widgets-desktop.png'), animations: 'disabled' });
});

test('touch layout keeps quick selections visible in one column', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id);
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const cards = page.locator('#home-workspace article[data-testid^="workspace-widget-"]');
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId('workspace-widget-email-quick-selection').getByText('Schnellauswahl')).toBeVisible();
  const [firstBox, secondBox] = await cards.evaluateAll(elements => elements.slice(0, 2).map(element => {
    const box = element.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));
  expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workspace-widgets-mobile.png'), animations: 'disabled' });
});

test('one unavailable source does not block the other workspace widgets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id, { failEmail: true });
  await page.goto('/de');
  await page.getByRole('navigation', { name: 'Startseitenansichten' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByTestId('workspace-widget-email').getByText('Gerade nicht verfügbar')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-todos-summary').getByText('Launch prüfen')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-automation-summary').getByText('Kampagnen-Report')).toBeVisible();
  await expect(page.getByTestId('workspace-widget-studio-summary').getByText('Editoriales Produktbild für den Launch')).toBeVisible();
});

test('workspace widgets keep their hierarchy in dark mode', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id);
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.goto('/de');
  await page.getByRole('navigation', { name: 'Startseitenansichten' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  const studioCard = page.getByTestId('workspace-widget-studio');
  await studioCard.hover();
  await expect(page.getByTestId('workspace-widget-studio-quick-selection').getByText('Editoriales Produktbild für den Launch')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: info.outputPath('workspace-widgets-dark.png'), animations: 'disabled' });
});

test('long automation output stays inside its card and renders as plain preview text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id, { longAutomationResult: true });
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const card = page.getByTestId('workspace-widget-automation');
  await card.hover();
  const preview = card.getByText(/Aktuelle Woche:/);
  await expect(preview).toBeVisible();
  await expect(preview).not.toContainText('**');
  const readGeometry = () => card.evaluate(element => {
    const cardBox = element.getBoundingClientRect();
    const footerBox = element.querySelector(':scope > a:last-child')?.getBoundingClientRect();
    const detailsBox = element.querySelector('[data-testid$="-quick-selection"]')?.getBoundingClientRect();
    return { cardBottom: cardBox.bottom, detailsBottom: detailsBox?.bottom, footerBottom: footerBox?.bottom, footerTop: footerBox?.top };
  });
  await expect.poll(async () => {
    const geometry = await readGeometry();
    return (geometry.detailsBottom ?? 0) <= (geometry.footerTop ?? 0) + 1;
  }).toBe(true);
  const geometry = await readGeometry();
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.cardBottom + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('broken studio previews fall back without breaking the card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await prepare(page);
  await mockWidgets(page, workspace.id, { brokenStudioImage: true });
  await page.goto('/de');
  await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
  const summary = page.getByTestId('workspace-widget-studio-summary');
  await expect(summary.locator('img')).toHaveCount(0);
  await expect(summary.getByText('Editoriales Produktbild für den Launch')).toBeVisible();
});
