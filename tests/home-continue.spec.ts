import { test, expect, type Page } from '@playwright/test';

async function prepare(page: Page) {
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const personal = workspaces.find((workspace: { type: string }) => workspace.type === 'personal');
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), personal.id);
  await page.route('**/api/mobile-app-promotion', route => route.fulfill({ json: { success: true, promotion: { eligible: false } } }));
  return { personal, workspaces };
}

async function fixtures(page: Page) {
  const now = Date.now();
  await page.route('**/api/files/quick-access?*', route => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get('q') || '';
    const files = Array.from({ length: 12 }, (_, index) => ({ path: `Plan-${index}.md`, name: `Plan-${index}.md`, title: `Projektplan ${index}`, openedAt: now - index * 1000, isFavorite: index === 1 })).filter(file => file.title.includes(query) && (url.searchParams.get('view') !== 'favorites' || file.isFavorite));
    return route.fulfill({ json: { success: true, data: { files: files.slice(0, 10), total: files.length, workspaceFileCount: 12, view: url.searchParams.get('view'), favorites: [] } } });
  });
  await page.route('**/api/home/chats?*', route => {
    const query = new URL(route.request().url()).searchParams.get('q') || '';
    const chats = [{ sessionId: 'continue-chat', title: 'Kampagnenplanung', activityAt: now - 100_000, hasUnread: true }].filter(chat => chat.title.includes(query));
    return route.fulfill({ json: { success: true, data: { chats, hasMore: false } } });
  });
}

for (const width of [390, 1440]) {
  test(`combined continuation, filters, search and direct chat at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { personal } = await prepare(page);
    await fixtures(page);
    await page.goto('/de');
    const panel = page.getByTestId('home-files');
    const rows = panel.locator('li');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText('Kampagnenplanung');
    await expect(rows.nth(2)).toContainText('Neue Antwort');
    await expect(rows.nth(2).getByRole('link')).toHaveAttribute('href', `/de/notebook?session=continue-chat&workspaceId=${personal.id}&chat=open`);
    await page.screenshot({ path: info.outputPath(`continue-${width}.png`), animations: 'disabled' });
    await panel.getByRole('button', { name: 'Weitere anzeigen', exact: true }).click();
    await expect(rows).toHaveCount(10);
    await expect(panel.getByRole('link', { name: 'Alle Chats' })).toHaveAttribute('href', `/de/notebook?workspaceId=${personal.id}&chat=open&history=open`);
    await panel.getByRole('button', { name: 'Dateien', exact: true }).click();
    await expect(rows).toHaveCount(3);
    await panel.getByRole('combobox', { name: 'Dateiansicht' }).selectOption('favorites');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Projektplan 1');
    await panel.getByRole('button', { name: 'Chats', exact: true }).click();
    await expect(rows).toHaveCount(1);
    const search = panel.getByRole('textbox', { name: 'Chats suchen …' });
    await search.fill('fehlt');
    await expect(rows).toHaveCount(0);
    await search.fill('Kampagnen');
    await expect(rows).toHaveCount(1);
    // Isolate navigation from the chat runtime; the existing conversation URL must be used.
    await page.route('**/de/notebook?*', route => route.request().isNavigationRequest() ? route.fulfill({ contentType: 'text/html', body: '<main>Conversation</main>' }) : route.continue());
    await rows.getByRole('link').click();
    await expect(page).toHaveURL(/session=continue-chat/);
  });
}

test('skeletons wait for both sources and a chat failure leaves files usable', async ({ page }) => {
  await prepare(page);
  await fixtures(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let failed = true;
  await page.route('**/api/home/chats?*', async route => {
    await held;
    return route.fulfill(failed ? { status: 503, json: { success: false } } : { json: { success: true, data: { chats: [], hasMore: false } } });
  });
  await page.goto('/de');
  const panel = page.getByTestId('home-files');
  await expect(panel.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  await expect(panel.locator('li')).toHaveCount(0);
  const height = (await panel.locator('[aria-busy]').boundingBox())!.height;
  release();
  await expect(panel.locator('li')).toHaveCount(3);
  await expect(panel.getByText('Chats konnten nicht geladen werden.')).toBeVisible();
  expect((await panel.locator('[aria-busy]').boundingBox())!.height).toBeGreaterThanOrEqual(height);
  failed = false;
  await panel.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(panel.locator('li')).toHaveCount(3);
  await expect(panel.getByText('Chats konnten nicht geladen werden.')).toHaveCount(0);
});

test('workspace switches discard earlier results and reset the overview', async ({ page }) => {
  const { personal, workspaces } = await prepare(page);
  const other = workspaces.find((workspace: { id: string }) => workspace.id !== personal.id);
  expect(other).toBeTruthy();
  await fixtures(page);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/home/chats?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('q') === 'delayed') { started(); await held; }
    await route.fulfill({ json: { success: true, data: { chats: [{ sessionId: 'scoped', title: params.get('workspaceId') === personal.id ? 'Personal conversation' : 'Other conversation', activityAt: Date.now(), hasUnread: false }], hasMore: false } } });
  });
  await page.goto('/de');
  const panel = page.getByTestId('home-files');
  await expect(panel.getByText('Personal conversation')).toBeVisible();
  await panel.getByRole('textbox').fill('delayed');
  await requested;
  await page.getByTestId('workspace-switcher').click();
  await page.getByTestId(`workspace-option-${other.id}`).click();
  await expect(panel.getByText('Personal conversation')).toHaveCount(0);
  await expect(panel.getByText('Other conversation')).toBeVisible();
  release();
  await expect(panel.getByText('Personal conversation')).toHaveCount(0);
});


test('chats remain available when files fail and an empty workspace stays calm', async ({ page }) => {
  await prepare(page);
  await fixtures(page);
  await page.route('**/api/files/quick-access?*', route => route.fulfill({ status: 503, json: { success: false } }));
  await page.goto('/de');
  const panel = page.getByTestId('home-files');
  await expect(panel.locator('li')).toHaveCount(1);
  await expect(panel.getByText('Kampagnenplanung')).toBeVisible();
  await expect(panel.getByText('Dateien konnten nicht geladen werden.')).toBeVisible();
  await page.route('**/api/files/quick-access?*', route => route.fulfill({ json: { success: true, data: { files: [], total: 0, workspaceFileCount: 0, view: 'recent', favorites: [] } } }));
  await page.route('**/api/home/chats?*', route => route.fulfill({ json: { success: true, data: { chats: [], hasMore: false } } }));
  await page.reload();
  await expect(panel.getByText('Hier kannst du bald weiterarbeiten')).toBeVisible();
  await expect(panel.locator('li')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Weitere anzeigen', exact: true })).toHaveCount(0);
});
