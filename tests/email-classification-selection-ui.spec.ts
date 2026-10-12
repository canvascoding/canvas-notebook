import { expect, test, type BrowserContext } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { projectEmailClassification } from '../app/lib/email/classification/policy';
import { emailOriginSelectionKey } from '../app/lib/email/classification/mailbox-types';
import type { EmailClassificationFeed, EmailClassificationFeedItem } from '../app/lib/email/classification/feed-types';
import de from '../messages/de.json';

async function selectionFixture(context: BrowserContext) {
  const session = await (await context.request.get('/api/auth/get-session')).json();
  expect(session.user?.id).toBeTruthy();
  const origin = { mailboxRef: `emb:${'a'.repeat(64)}`, accountSource: 'local' as const, accountId: 'selection-qa',
    accountScope: 'personal' as const, accountOwnerId: session.user.id as string, mailboxId: null, workspaceId: null,
    workspaceName: null, emailAddress: 'selection@example.test', displayName: 'Selection QA', folder: 'INBOX', canonicalId: '',
    capabilities: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManage: true } };
  const account = { id: origin.accountId, provider: 'imap', authType: 'password', emailAddress: origin.emailAddress,
    displayName: origin.displayName, isPrimary: true, status: 'active', policy: { readFrom: ['*'], sendTo: ['*'] } };
  const item = (id: string, character: string, isRead: boolean, days: number): EmailClassificationFeedItem => {
    const ownOrigin = { ...origin, canonicalId: id };
    return { messageRef: `emm:${character.repeat(64)}`, selectionKey: emailOriginSelectionKey(ownOrigin), origin: ownOrigin,
      message: { from: 'QA Sender', subject: id, date: new Date(Date.now() - days * 86_400_000).toISOString(), snippet: 'Synthetic UI fixture', isRead },
      classification: projectEmailClassification({ raw: null, unavailableState: id === 'Alte gelesene Mail' ? 'not_selected' : 'pending' }),
      personalFocus: { done: false, version: 0 } };
  };
  const items = [item('Alte ungelesene Mail', 'b', false, 120), item('Aktuelle gelesene Mail', 'c', true, 20), item('Alte gelesene Mail', 'd', true, 120)];
  const writes: string[] = [];
  await context.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (path.startsWith('/api/user-hints')) return route.fulfill({ json: { page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [] } });
    if (path === '/api/email/classification/availability') return route.fulfill({ json: { success: true,
      data: { enabled: true, available: true, revision: 1, defaultMode: 'focus', reason: null } } });
    if (path === '/api/email/classification/mailboxes') return route.fulfill({ json: { success: true, data: { mailboxes: [origin] } } });
    if (path === '/api/email/accounts' || path === '/api/email/mailboxes') return route.fulfill({ json: { success: true, data: { mode: 'local', accounts: [account] } } });
    if (path === '/api/email/folders') return route.fulfill({ json: { success: true, data: { folders: [{ id: 'INBOX', path: 'INBOX', name: 'Inbox', role: 'inbox', messageCount: 3, unseenCount: 1 }] } } });
    if (path.endsWith('/outbox')) return route.fulfill({ json: { success: true, data: [] } });
    if (path === '/api/email/classification/feed') {
      const view = (url.searchParams.get('view') ?? 'focus') as EmailClassificationFeed['view'];
      const feed: EmailClassificationFeed = { scope: { kind: 'all' }, requestedMode: 'focus', mode: 'focus', view,
        items: view === 'all' ? items : view === 'pending' ? items.slice(0, 2) : [], nextCursor: null,
        snapshot: { id: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 600_000 }, hasUpdates: false,
        counts: { total: 3, groups: { important: 0, reply: 0, review: 0, pending: 2, other: 1, spam: 0, done: 0 }, categories: {} },
        coverage: [{ mailboxRef: origin.mailboxRef, state: 'complete', lastSyncAt: Date.now(), indexed: 3, pending: 2, failed: 0, stale: 0 }],
        limits: { initialLookbackDays: 30, maxHistoricalMessages: 5000 } };
      return route.fulfill({ json: { success: true, data: feed } });
    }
    if (path === '/api/email/classification/message') return route.fulfill({ json: { success: true, data: { ...items[2], assessment: null } } });
    if (path === '/api/email/messages/list') return route.fulfill({ json: { success: true, data: { account,
      messages: items.map(value => ({ ...value.message, id: value.origin.canonicalId, folder: 'INBOX' })), total: 3, hasMore: false, nextOffset: null } } });
    if (path.startsWith('/api/email/accounts/selection-qa/messages/')) return route.fulfill({ json: { success: true,
      data: { message: { ...items[2].message, id: items[2].origin.canonicalId, folder: 'INBOX', to: [origin.emailAddress], body: 'Synthetic old read email body', bodyHtml: '<p>Synthetic old read email body</p>' } } } });
    if ((path.includes('/email/') || path === '/api/user-preferences') && !['GET', 'HEAD'].includes(request.method())) {
      writes.push(path); return route.fulfill({ status: 403, json: { success: false, error: 'UI fixture writes disabled.' } });
    }
    return route.continue();
  });
  return writes;
}

test.describe('Unread or recent email selection UI', () => {
  test.setTimeout(90_000);
  test('real admin settings explain both branches and reject a lookback above 30 without saving', async ({ browser }, info) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 1000 } });
    try {
      const original = (await (await context.request.get('/api/admin/email-classification/settings')).json()).data.settings;
      const page = await context.newPage(); await page.goto('/de/settings?tab=system-email', { waitUntil: 'load' });
      const card = page.getByTestId('email-classification-settings');
      await expect(card).toContainText(de.emailClassificationSettings.selectionHint);
      await card.getByRole('button', { name: de.emailClassificationSettings.configuration, exact: true }).click();
      await card.getByText(de.emailClassificationSettings.advanced, { exact: true }).click();
      const lookback = page.locator('#email-classification-initialLookbackDays');
      await expect(lookback).toHaveAttribute('max', '30');
      await lookback.fill('31'); expect(await lookback.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(true);
      const response = await context.request.patch('/api/admin/email-classification/settings', {
        headers: { Origin: process.env.BASE_URL!, 'Sec-Fetch-Site': 'same-origin' },
        data: { expectedRevision: original.revision, configuration: { ...original.configuration, initialLookbackDays: 31 } },
      });
      expect(response.status()).toBe(400);
      const after = (await (await context.request.get('/api/admin/email-classification/settings')).json()).data.settings;
      expect(after).toEqual(original);
      await lookback.fill('30');
      await page.screenshot({ path: info.outputPath('selection-settings-desktop.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('selection-settings-mobile.png'), animations: 'disabled' });
    } finally { await context.close(); }
  });

  test('controlled feed keeps excluded mail accessible with an honest status and only two awaiting ratings', async ({ browser }, info) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    try {
      const writes = await selectionFixture(context); const page = await context.newPage();
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto('/de/emails?mode=focus&scope=all&view=all', { waitUntil: 'load' });
      const nav = page.getByTestId('email-focus-navigation');
      await expect(nav.getByTestId('email-focus-row')).toHaveCount(3);
      await expect(nav.getByRole('button', { name: 'Noch nicht vorbereitet: 2', exact: true })).toBeVisible();
      await expect(nav).toContainText(de.emailFocus.reasons.not_selected);
      await nav.getByRole('button', { name: 'Noch nicht vorbereitet: 2', exact: true }).click();
      await expect(nav.getByTestId('email-focus-row')).toHaveCount(2);
      await expect(nav.getByTestId('email-focus-row').filter({ hasText: 'Alte gelesene Mail' })).toHaveCount(0);
      await nav.getByRole('button', { name: 'Alle E-Mails: 3', exact: true }).click();
      await nav.getByTestId('email-focus-row').filter({ hasText: 'Alte gelesene Mail' }).click();
      const reader = page.getByTestId('email-classification-details');
      await expect(reader).toContainText(de.emailFocus.reasons.not_selected);
      await expect(page.frameLocator('iframe').getByText('Synthetic old read email body')).toBeVisible();
      await page.screenshot({ path: info.outputPath('selection-mail-desktop-light.png'), animations: 'disabled' });
      await page.evaluate(() => { localStorage.setItem('theme', 'dark'); document.documentElement.classList.add('dark'); });
      await page.screenshot({ path: info.outputPath('selection-mail-desktop-dark.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await nav.getByTestId('email-focus-row').filter({ hasText: 'Alte gelesene Mail' }).click();
      await expect(page.getByRole('dialog').getByTestId('email-classification-details')).toContainText(de.emailFocus.reasons.not_selected);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('selection-mail-mobile-dark.png'), animations: 'disabled' });
      await page.evaluate(() => { localStorage.setItem('theme', 'light'); document.documentElement.classList.remove('dark'); });
      await page.screenshot({ path: info.outputPath('selection-mail-mobile-light.png'), animations: 'disabled' });
      expect(writes).toEqual([]); expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
