import { expect, test, type BrowserContext } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';

async function installSearchFixture(context: BrowserContext) {
  await context.route('**/api/user-hints**', route => route.fulfill({ json: { page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [] } }));
  const searches: Array<Record<string, unknown>> = [];
  const blockedWrites: string[] = [];
  const detailFolders: string[] = [];
  const account = { id: 'search-qa', provider: 'imap', authType: 'password', emailAddress: 'qa@example.test', displayName: 'Search QA', isPrimary: true, status: 'active', imapHost: 'example.test', policy: { readFrom: ['*'], sendTo: ['*'] } };
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/user-hints')) return route.fulfill({ json: { page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [] } });
    if ((path === '/api/email/accounts' || path === '/api/email/mailboxes')) return route.fulfill({ json: { success: true, data: { mode: 'local', accounts: [account] } } });
    if (path === '/api/email/folders') return route.fulfill({ json: { success: true, data: { folders: [
      { id: 'INBOX', path: 'INBOX', name: 'Inbox', role: 'inbox', messageCount: 2, unseenCount: 0 },
      { id: 'Sent', path: 'Sent', name: 'Sent', role: 'sent', messageCount: 1, unseenCount: 0 },
    ] } } });
    if (path.endsWith('/outbox')) return route.fulfill({ json: { success: true, data: [] } });
    if (path === '/api/email/messages/list') {
      const body = request.postDataJSON() as Record<string, unknown>;
      searches.push(body);
      return route.fulfill({ json: { success: true, data: { account, messages: [{ id: 'message-1', folder: 'INBOX', from: 'Anna <anna@example.test>', subject: body.query ? `Result: ${body.query}` : 'Welcome to search', date: '2026-09-22T09:00:00Z', snippet: 'Full body search result', isRead: true }], total: 1, hasMore: false, nextOffset: null, folder: body.folder } } });
    }
    if (/\/api\/email\/accounts\/[^/]+\/messages\/message-1$/.test(path)) { detailFolders.push(new URL(request.url()).searchParams.get('folder') || ''); return route.fulfill({ json: { success: true, data: { message: { id: 'message-1', from: 'Anna <anna@example.test>', to: ['qa@example.test'], subject: 'Welcome to search', body: 'Full body search result', bodyHtml: '<p>Full body search result</p>', isRead: true } } } }); }
    if (path.includes('/email/') && !['GET', 'HEAD'].includes(request.method())) {
      blockedWrites.push(path);
      return route.fulfill({ status: 403, json: { success: false, error: 'Live email writes disabled.' } });
    }
    return route.continue();
  });
  return { searches, blockedWrites, detailFolders };
}

test.describe('Email search and focus', () => {
  test.setTimeout(120_000);
  test('repeats the same search, forwards boolean syntax, changes scope and resets', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 720 } });
    const fixture = await installSearchFixture(context);
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      const input = page.getByTestId('email-search-input');
      await expect(input).toBeVisible();
      await expect.poll(() => fixture.searches.length).toBeGreaterThan(0);
      const expression = '(invoice OR quote) AND subject:"Project Alpha"';
      await input.fill(expression);
      await input.press('Enter');
      await expect.poll(() => fixture.searches.filter((entry) => entry.query === expression).length).toBe(1);
      await expect(page.getByTestId('email-search-submit')).toBeEnabled();
      await input.press('Enter');
      await expect.poll(() => fixture.searches.filter((entry) => entry.query === expression).length).toBe(2);
      await page.getByTestId('email-search-scope').selectOption('all');
      await expect.poll(() => fixture.searches.at(-1)?.folder).toBe('all');
      await page.getByText(`Result: ${expression}`, { exact: true }).first().click();
      await expect.poll(() => fixture.detailFolders.at(-1)).toBe('INBOX');
      await expect(page.frameLocator('iframe').getByText('Full body search result')).toBeVisible();
      const readerDialog = page.getByRole('dialog');
      if (await readerDialog.isVisible()) await readerDialog.getByRole('button', { name: /^close$|^schließen$/i }).click();
      await page.getByTestId('email-search-reset').click();
      await expect(input).toHaveValue('');
      await expect.poll(() => fixture.searches.at(-1)?.query).toBe('');
      expect(fixture.blockedWrites).toEqual([]);
    } finally { await context.close(); }
  });

  test('search options generate a valid expression and invalid input does not run a search', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const fixture = await installSearchFixture(context);
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await page.getByTestId('email-search-options').click();
      await page.locator('#email-search-terms').fill('invoice quote');
      await page.locator('#email-search-from').fill('anna@example.test');
      await page.locator('#email-search-match').selectOption('any');
      await page.getByRole('button', { name: /Apply search|Suche anwenden/i }).click();
      await expect.poll(() => fixture.searches.at(-1)?.query).toBe('("invoice" OR "quote") AND from:"anna@example.test"');
      const count = fixture.searches.length;
      await page.getByTestId('email-search-input').fill('invoice OR');
      await page.getByTestId('email-search-input').press('Enter');
      await expect(page.getByText(/Invalid search:|Ungültige Suche:/)).toBeVisible();
      expect(fixture.searches).toHaveLength(count);
    } finally { await context.close(); }
  });

  test('a slow earlier response cannot replace a newer search', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const fixture = await installSearchFixture(context);
    let releaseSlow!: () => void;
    let slowStarted = false;
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
    await context.route('**/api/email/messages/list', async route => {
      const body = route.request().postDataJSON();
      if (body.query !== 'slow') return route.fallback();
      slowStarted = true;
      await slowGate;
      await route.fulfill({ json: { success: true, data: { messages: [{ id: 'stale', from: 'old@example.test', subject: 'Stale response', date: '2026-09-22', snippet: 'stale' }], total: 1 } } }).catch(() => {});
    });
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      const input = page.getByTestId('email-search-input');
      await input.fill('slow');
      await input.press('Enter');
      await expect.poll(() => slowStarted).toBe(true);
      await input.fill('newer');
      await input.press('Enter');
      await expect.poll(() => fixture.searches.at(-1)?.query).toBe('newer');
      releaseSlow();
      await expect(page.getByText('Result: newer', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Stale response', { exact: true })).not.toBeVisible();
    } finally { releaseSlow(); await context.close(); }
  });

  test('focus hides sidebars and manually reopening chat restores the prior folder view', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1920, height: 900 } });
    await installSearchFixture(context);
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      const focus = page.getByTestId('email-focus-toggle');
      await expect(focus).toBeVisible();
      if (await focus.getAttribute('aria-pressed') === 'true') await focus.click();
      const chat = page.getByTestId('chat-dock-toggle');
      if (!(await page.getByTestId('chat-dock-desktop').isVisible())) await chat.click();
      const showFolders = page.getByRole('button', { name: /Show folders|Folder anzeigen/i });
      if (await showFolders.isVisible()) await showFolders.click();
      await expect(page.getByRole('button', { name: /Collapse folders|Folder einklappen/i })).toBeVisible();
      await focus.click();
      await expect(focus).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('chat-dock-desktop')).not.toBeVisible();
      await chat.click();
      await expect(focus).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('chat-dock-desktop')).toBeVisible();
      await expect(page.getByRole('button', { name: /Collapse folders|Folder einklappen/i })).toBeVisible();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: /Collapse folders|Folder einklappen/i })).toBeVisible();
    } finally { await context.close(); }
  });

  for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 640 }, { width: 320, height: 640 }]) {
    test(`keeps search and focus controls within ${viewport.width}px viewport`, async ({ browser }, testInfo) => {
      const context = await createAuthenticatedContext(browser, { viewport });
      await installSearchFixture(context);
      const page = await context.newPage();
      try {
        await page.goto('/emails', { waitUntil: 'domcontentloaded' });
        for (const id of ['email-search-input', 'email-search-submit', 'email-focus-toggle']) {
          const control = page.getByTestId(id);
          await expect(control).toBeVisible();
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
          expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        }
        await page.getByTestId('email-focus-toggle').click();
        await expect(page.getByTestId('email-search-input')).toBeVisible();
        await page.getByTestId('email-search-options').click();
        await expect(page.getByText(/AND.*OR|OR.*AND/).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`email-search-${viewport.width}.png`), animations: 'disabled' });
      } finally { await context.close(); }
    });
  }
});
