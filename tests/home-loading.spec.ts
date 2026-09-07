import { test, expect } from '@playwright/test';

for (const width of [390, 1440]) {
for (const count of [0, 1, 5]) {
  test(`home reserves space while loading ${count} files at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const login = await page.request.post('/api/auth/sign-in/email', {
      headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
      data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    let releaseFiles!: () => void;
    let releaseWorkspace!: () => void;
    const filesReady = new Promise<void>(resolve => { releaseFiles = resolve; });
    const workspaceReady = new Promise<void>(resolve => { releaseWorkspace = resolve; });
    await page.route('**/api/workspaces', async route => {
      const response = await route.fetch();
      await workspaceReady;
      await route.fulfill({ response });
    });
    await page.route('**/api/files/quick-access?*', async route => {
      await filesReady;
      const limit = Number(new URL(route.request().url()).searchParams.get('limit'));
      await route.fulfill({ json: { success: true, data: {
        files: Array.from({ length: Math.min(count, limit) }, (_, index) => ({ path: `Projektplan-${index}.md`, name: `Projektplan-${index}.md`, title: `Projektplan ${index + 1}` })),
        total: count, workspaceFileCount: count, view: 'all', favorites: [],
      } } });
    });
    await page.route('**/api/notifications/summary', async route => {
      await filesReady;
      const items = Array.from({ length: count }, (_, index) => ({ id: `notice-${index}`, type: 'studio.completed', title: `Entwurf ${index + 1} ist bereit`, detail: 'Prüfe den neuen Entwurf.', occurredAt: new Date().toISOString(), unread: true, priority: 'normal', workspaceId: 'fixture', workspaceName: 'Marketing', target: { kind: 'studio', generationId: `image-${index}` } }));
      await route.fulfill({ json: { success: true, data: { unreadCount: count, counts: { unread: count, chat: 0, todos: 0, todoUnread: 0, todoAttention: 0, emailAttention: 0, studio: count, automation: 0 }, items, sections: { notifications: items, todos: [], todoUnread: [], todoAttention: [], emailAttention: [] } } } });
    });
    await page.goto('/de');
    const files = page.getByTestId('home-files');
    await expect(files.getByRole('status')).toBeVisible();
    const beforeWorkspace = await files.boundingBox();
    releaseWorkspace();
    await expect(files.getByRole('button', { name: 'Neue Notiz' })).toBeVisible();
    await expect(files.getByRole('status')).toBeVisible();
    const before = await files.boundingBox();
    const card = page.getByRole('complementary', { name: 'Benachrichtigungen' });
    const cardBefore = await card.boundingBox();
    expect(Math.abs(before!.height - beforeWorkspace!.height)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: info.outputPath('skeletons.png') });
    releaseFiles();
    await expect(files.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    await expect(card.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    const cardAfter = await card.boundingBox();
    expect(Math.abs(cardAfter!.height - cardBefore!.height)).toBeLessThanOrEqual(2);
    const after = await files.boundingBox();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: info.outputPath('loaded.png') });
  });
}
}
