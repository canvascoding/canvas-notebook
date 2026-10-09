import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import type { EmailRecipientCandidate, EmailRecipientDiscoveryResult } from '../app/lib/email/recipient-discovery-types';

type Draft = {
  id: string; accountId: string; workspaceId: string | null; mailboxId: string | null; senderAddress: string;
  status: string; version: number; subject: string; body: string; to: string[]; cc: string[]; bcc: string[];
  attachments: unknown[]; isHtml: boolean; origin: string; updatedAt: string; createdAt: string;
};

function draft(id: string, overrides: Partial<Draft> = {}): Draft {
  return { id, accountId: 'recipient-a', workspaceId: null, mailboxId: null, senderAddress: 'owner@example.test',
    status: 'awaiting_review', version: 1, subject: `Recipient proposal ${id}`, body: '<p>Review this proposal.</p>',
    to: ['existing@example.test'], cc: [], bcc: ['blind@example.test'], attachments: [], isHtml: true,
    origin: 'agent', updatedAt: '2026-10-08T09:00:00Z', createdAt: '2026-10-08T09:00:00Z', ...overrides };
}

function candidate(name: string, address: string, role: EmailRecipientCandidate['source']['role'] = 'to'): EmailRecipientCandidate {
  return { name, address, reason: 'name_match', source: { messageId: `source-${address}`,
    folder: 'Sent / Team conversations', role, date: '2024-03-04T12:00:00Z' } };
}

function discovery(candidates: EmailRecipientCandidate[], incomplete = false): EmailRecipientDiscoveryResult {
  return { status: incomplete ? 'incomplete' : candidates.length > 1 ? 'ambiguous' : candidates.length ? 'resolved' : 'not_found',
    candidates, candidateCount: candidates.length, omittedCount: Math.max(0, candidates.length - 5),
    coverage: { hasMore: false, nextOffset: null, incomplete } };
}

function defaultCandidates(query: string) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]/gu, '') || 'recipient';
  return Array.from({ length: 6 }, (_, index) => candidate(`${query} Sample ${index + 1}`, `${slug}-${index}@example.test`));
}

async function installRecipientFixture(context: BrowserContext, initial: Draft[] = []) {
  const account = { id: 'recipient-a', accountScope: 'personal', workspaceId: null, provider: 'imap', authType: 'password',
    emailAddress: 'owner@example.test', displayName: 'Recipient QA', isPrimary: true, status: 'active',
    imapHost: 'example.test', connectionState: 'ready', policy: { readFrom: ['*'], sendTo: ['*'] },
    capabilities: { canRead: true, canWrite: true, canManage: true, canDelete: true, canRunAgent: true } };
  const requests: Array<Record<string, unknown>> = [];
  const writes: Array<{ id: string; body: Record<string, unknown> }> = [];
  const unexpected: string[] = [];
  const drafts = new Map(initial.map(item => [item.id, { ...item }]));
  let recipientResponder: ((body: Record<string, unknown>) => Promise<unknown>) | undefined;
  await context.route('https://api.github.com/repos/canvascoding/canvas-notebook/releases/latest', route => route.fulfill({ json: { tag_name: '0.0.0', html_url: 'https://github.com/canvascoding/canvas-notebook/releases', body: '' } }));
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/user-hints')) return route.fulfill({ json: { page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [] } });
    if (path === '/api/notifications/summary') return route.fulfill({ json: { success: true, data: {
      unreadCount: 0, counts: { unread: 0, chat: 0, todos: 0, todoUnread: 0, todoAttention: 0, emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 },
      items: [], sections: { notifications: [], todos: [], todoUnread: [], todoAttention: [], emailAttention: [] },
    } } });
    if (path === '/api/email/classification/availability' || path === '/api/email/classification/mailboxes') {
      return route.fulfill({ status: 404, json: { success: false, code: 'CLASSIFICATION_UNAVAILABLE' } });
    }
    if (path === '/api/email/accounts' || path === '/api/email/mailboxes') return route.fulfill({ json: { success: true, data: { mode: 'local', accounts: [account] } } });
    if (path === '/api/email/folders') return route.fulfill({ json: { success: true, data: { folders: [
      { id: 'INBOX', path: 'INBOX', name: 'Inbox', role: 'inbox', messageCount: 1, unseenCount: 0 },
      { id: 'Sent', path: 'Sent', name: 'Sent', role: 'sent', messageCount: 0, unseenCount: 0 },
    ] } } });
    if (path === '/api/email/messages/list') return route.fulfill({ json: { success: true, data: { account, folder: 'INBOX',
      messages: [{ id: 'reply-message', folder: 'INBOX', from: 'Original sender <sender@example.test>',
        to: ['owner@example.test', 'other@example.test'], cc: ['copy@example.test'], subject: 'Recipient reply fixture',
        snippet: 'Original message for recipient suggestions', isRead: true, date: '2026-10-08T09:00:00Z' }],
      total: 1, hasMore: false, nextOffset: null } } });
    if (path === '/api/email/accounts/recipient-a/messages/reply-message') return route.fulfill({ json: { success: true, data: { message: {
      id: 'reply-message', folder: 'INBOX', from: 'Original sender <sender@example.test>', replyTo: ['reply@example.test'],
      to: ['owner@example.test', 'other@example.test'], cc: ['copy@example.test'], subject: 'Recipient reply fixture',
      body: 'Original message for recipient suggestions', bodyHtml: '<p>Original message for recipient suggestions</p>',
      isRead: true, date: '2026-10-08T09:00:00Z',
    } } } });
    if (path === '/api/email/recipients') {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push(body);
      const data = recipientResponder ? await recipientResponder(body) : body.mode === 'reply'
        ? { basis: 'current_message', replyRecipients: { to: [candidate('Reply address', 'reply@example.test', 'reply-to')], cc: [] },
          optionalAdditionalRecipients: [candidate('Other participant', 'other@example.test'), candidate('Copy participant', 'copy@example.test', 'cc')], omittedCount: 0 }
        : discovery(defaultCandidates(String(body.query || '')));
      // Aborted browser requests may close their route while a deliberate stale-response gate is pending.
      return route.fulfill({ json: { success: true, data } }).catch(() => {});
    }
    const outbox = path.match(/^\/api\/(?:workspaces\/([^/]+)\/email|email)\/outbox(?:\/([^/]+))?(?:\/(send|reject))?$/u);
    if (outbox) {
      const [, workspaceId, id, action] = outbox;
      if (request.method() === 'GET') return route.fulfill({ json: { success: true, data: id ? drafts.get(id)
        : [...drafts.values()].filter(item => workspaceId ? item.workspaceId === decodeURIComponent(workspaceId) : !item.workspaceId) } });
      const current = drafts.get(id);
      if (request.method() === 'PATCH' && current && !action) {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (body.expectedVersion !== current.version) return route.fulfill({ status: 409, json: { success: false, error: 'Draft changed.' } });
        writes.push({ id, body }); Object.assign(current, body, { version: current.version + 1 });
        return route.fulfill({ json: { success: true, data: current } });
      }
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 403, json: { success: false, error: 'Delivery is disabled by this browser fixture.' } });
    }
    if (path.includes('/email/') && !['GET', 'HEAD'].includes(request.method())) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 403, json: { success: false, error: 'Live email writes are disabled by this browser fixture.' } });
    }
    return route.continue();
  });
  return { requests, writes, unexpected, drafts, setRecipientResponder: (handler: typeof recipientResponder) => { recipientResponder = handler; } };
}

async function openCompose(page: Page) {
  await page.goto('/emails', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Compose$|^Verfassen$/iu }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.locator('#email-compose-to') });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openReview(page: Page, id: string, workspaceId?: string) {
  await page.goto(`/?outboxDraft=${encodeURIComponent(id)}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''}`, { waitUntil: 'domcontentloaded' });
  const dialog = page.getByTestId('email-review-host');
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  return dialog;
}

async function expectViewportFit(page: Page, dialog: Locator, controls: Locator[], width: number) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const control of controls) {
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test.describe('Email recipient discovery', () => {
  test.setTimeout(120_000);

  test('Compose looks up names progressively, exposes sources and requires explicit address choices', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    const fixture = await installRecipientFixture(context);
    const page = await context.newPage();
    try {
      await page.clock.install();
      const dialog = await openCompose(page);
      const to = dialog.locator('#email-compose-to');
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
      await page.clock.runFor(500); expect(fixture.requests).toEqual([]);
      await to.click(); await page.clock.runFor(500); expect(fixture.requests).toEqual([]);
      await to.fill('A'); await page.clock.runFor(500); expect(fixture.requests).toEqual([]);
      await to.fill('An'); await to.fill('Anna');
      await page.clock.runFor(399); expect(fixture.requests).toEqual([]);
      await page.clock.runFor(1);
      await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(5);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({ mode: 'find', accountId: 'recipient-a', mailboxWorkspaceId: null, query: 'Anna' });
      const first = dialog.getByRole('listbox').getByRole('option').first();
      await expect(first).toContainText('anna-0@example.test');
      await expect(first).toContainText(/Source dated|Quelle vom/iu);
      const details = dialog.getByRole('listbox').locator('details').first();
      await expect(details).not.toHaveAttribute('open');
      await details.locator('summary').click();
      await expect(details).toHaveAttribute('open', '');
      await expect(details).toContainText('Sent / Team conversations');
      await expect(details).not.toContainText('source-anna-0');
      await first.click();
      await expect(to).toHaveValue('');
      await expect(dialog.getByRole('button', { name: /Remove anna-0@example\.test|anna-0@example\.test entfernen/iu })).toBeVisible();
      await expect(dialog.locator('[aria-invalid="true"]')).toHaveCount(0);

      await to.fill('Bruno'); await page.clock.runFor(400);
      await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(5);
      await to.press('ArrowDown'); await to.press('Enter');
      await expect(dialog.getByRole('button', { name: /Remove bruno-0@example\.test|bruno-0@example\.test entfernen/iu })).toBeVisible();
      const count = fixture.requests.length;
      await to.fill('manual@example.test'); await page.clock.runFor(600);
      expect(fixture.requests).toHaveLength(count);
      await dialog.locator('#email-compose-subject').click();
      await expect(dialog.getByRole('button', { name: /Remove manual@example\.test|manual@example\.test entfernen/iu })).toBeVisible();

      for (const [raw, action] of [['Name <one@example.test> <two@example.test>', 'blur'], ['one@example.test two@example.test', 'enter']] as const) {
        await to.fill(raw);
        if (action === 'blur') await dialog.locator('#email-compose-subject').click(); else await to.press('Enter');
        await expect(dialog.locator('[aria-invalid="true"]').filter({ hasText: raw })).toBeVisible();
        await expect(dialog.getByRole('alert')).toContainText(/complete email address|vollständige E-Mail-Adresse/iu);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await context.close(); }
  });

  test('Reply uses Reply-To and loads optional participants only through an explicit request and To/Cc choices', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    const fixture = await installRecipientFixture(context);
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await page.getByText('Recipient reply fixture', { exact: true }).first().click();
      await page.getByRole('button', { name: /^Reply options$|^Antwortoptionen$/iu }).click();
      await page.getByRole('menuitem', { name: /^Reply$|^Antworten$/iu }).click();
      const dialog = page.getByRole('dialog').filter({ has: page.locator('#email-compose-to') });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: /Remove reply@example\.test|reply@example\.test entfernen/iu })).toBeVisible();
      expect(fixture.requests).toEqual([]);
      await dialog.getByRole('button', { name: /^More participants$|^Weitere Teilnehmer$/iu }).click();
      await expect(dialog.getByText('Other participant', { exact: true })).toBeVisible();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({ mode: 'reply', accountId: 'recipient-a', messageId: 'reply-message', folder: 'INBOX', replyMode: 'reply', exclude: ['reply@example.test'] });
      await expect(dialog.locator('#email-compose-cc')).toHaveValue('');
      await dialog.getByRole('button', { name: /Add other@example\.test to To|other@example\.test in An aufnehmen/iu }).click();
      await dialog.getByRole('button', { name: /Add copy@example\.test to Cc|copy@example\.test in Cc aufnehmen/iu }).click();
      await expect(dialog.getByRole('button', { name: /Remove other@example\.test|other@example\.test entfernen/iu })).toBeVisible();
      await expect(dialog.getByRole('button', { name: /Remove copy@example\.test|copy@example\.test entfernen/iu })).toBeVisible();
      expect(fixture.requests).toHaveLength(1);
      await expect(dialog.getByText(/No additional participants|Keine weiteren Teilnehmer/iu)).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { await context.close(); }
  });

  test('Review keeps recipient details collapsed, shares To/Cc/Bcc lookup and saves explicit selections', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    const fixture = await installRecipientFixture(context, [draft('review-picker')]);
    const page = await context.newPage();
    try {
      const dialog = await openReview(page, 'review-picker');
      await expect(dialog.getByTestId('email-review-to')).not.toBeVisible();
      expect(fixture.requests).toEqual([]);
      await dialog.getByTestId('email-review-recipient-details').click();
      for (const [field, query, index] of [['to', 'Anna', 0], ['cc', 'Bruno', 1], ['bcc', 'Clara', 2]] as const) {
        const input = dialog.getByTestId(`email-review-${field}`);
        await input.fill(query);
        await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(5);
        await input.press('ArrowDown');
        for (let step = 0; step < index; step++) await input.press('ArrowDown');
        await input.press('Tab');
        await expect(input).toHaveValue('');
      }
      await expect(dialog.getByTestId('email-review-save')).toBeEnabled();
      await dialog.getByTestId('email-review-save').click();
      await expect.poll(() => fixture.writes.length).toBe(1);
      expect(fixture.writes[0].body).toMatchObject({ expectedVersion: 1,
        to: ['existing@example.test', 'anna-0@example.test'], cc: ['bruno-1@example.test'], bcc: ['blind@example.test', 'clara-2@example.test'] });
      expect(fixture.requests).toHaveLength(3);
      expect(fixture.requests.every(body => body.accountId === 'recipient-a' && body.mailboxWorkspaceId === null)).toBe(true);
      expect(fixture.unexpected).toEqual([]);
    } finally { await context.close(); }
  });

  test('Slow personal-mailbox and earlier-draft results cannot appear after a Review scope switch', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    const workspaceResponse = await context.request.get('/api/workspaces');
    expect(workspaceResponse.ok()).toBe(true);
    const workspacePayload = await workspaceResponse.json() as { workspaces: Array<{ id: string; permissions?: { canRead?: boolean; canWrite?: boolean } }> };
    const workspace = workspacePayload.workspaces.find(item => item.permissions?.canWrite && item.permissions?.canRead !== false);
    expect(workspace, 'The managed browser runtime needs one writable workspace.').toBeTruthy();
    const fixture = await installRecipientFixture(context, [draft('scope-personal'),
      draft('scope-work-a', { workspaceId: workspace!.id, mailboxId: 'fixture-mailbox', subject: 'Workspace A proposal' }),
      draft('scope-work-b', { workspaceId: workspace!.id, mailboxId: 'fixture-mailbox', subject: 'Workspace B proposal' })]);
    const gates = new Map<string, { promise: Promise<void>; release(): void }>();
    for (const query of ['SlowOne', 'SlowTwo']) {
      let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); gates.set(query, { promise, release });
    }
    fixture.setRecipientResponder(async body => {
      const query = String(body.query);
      if (gates.has(query)) { await gates.get(query)!.promise; return discovery([candidate('Stale participant', 'stale@example.test', 'from')]); }
      return discovery([candidate('Fresh participant', 'fresh@example.test')]);
    });
    const page = await context.newPage();
    try {
      const dialog = await openReview(page, 'scope-personal');
      for (const [query, destination, subject] of [['SlowOne', 'scope-work-a', 'Workspace A proposal'], ['SlowTwo', 'scope-work-b', 'Workspace B proposal']] as const) {
        await dialog.getByTestId('email-review-recipient-details').click();
        await dialog.getByTestId('email-review-to').fill(query);
        await expect.poll(() => fixture.requests.some(body => body.query === query)).toBe(true);
        await dialog.getByTestId(`email-review-draft-${destination}`).click();
        const unsaved = page.getByTestId('email-review-unsaved-dialog');
        await expect(unsaved).toBeVisible();
        await unsaved.getByRole('button', { name: /Discard changes|Änderungen verwerfen/iu }).click();
        await expect(dialog.getByTestId('email-review-subject')).toHaveValue(subject);
        await dialog.getByTestId('email-review-recipient-details').click();
        await dialog.getByTestId('email-review-to').fill('Fresh');
        await expect(dialog.getByRole('option', { name: /fresh@example\.test/iu })).toBeVisible();
        expect(fixture.requests.at(-1)).toMatchObject({ accountId: 'recipient-a', mailboxWorkspaceId: workspace!.id, query: 'Fresh' });
        gates.get(query)!.release();
        await expect(dialog.getByText('stale@example.test', { exact: true })).not.toBeVisible();
        // Leave the next iteration with closed details and no unsaved recipient intent.
        await dialog.getByTestId('email-review-to').fill('');
        await dialog.getByTestId('email-review-subject').click();
        await dialog.getByTestId('email-review-recipient-details').click();
      }
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { for (const gate of gates.values()) gate.release(); await context.close(); }
  });

  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    test(`Compose and Review suggestions fit the ${viewport.width}px viewport`, async ({ browser }, testInfo) => {
      const context = await createAuthenticatedContext(browser, { viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const fixture = await installRecipientFixture(context, [draft('viewport-review')]);
      fixture.setRecipientResponder(async () => discovery(Array.from({ length: 6 }, (_, i) => candidate(`A descriptive participant name ${i + 1}`, `very-long-recipient-address-for-layout-${i}@long-company-name.example.test`))));
      const page = await context.newPage();
      try {
        const compose = await openCompose(page);
        await compose.locator('#email-compose-to').fill('Layout');
        await expect(compose.getByRole('listbox').getByRole('option')).toHaveCount(5);
        await expectViewportFit(page, compose, [compose.locator('#email-compose-to'), compose.getByRole('listbox').getByRole('option').first()], viewport.width);
        await page.screenshot({ path: testInfo.outputPath(`recipient-compose-${viewport.width}.png`), animations: 'disabled' });
        await compose.getByRole('button', { name: /^Cancel$|^Abbrechen$/iu }).click();
        const review = await openReview(page, 'viewport-review');
        await review.getByTestId('email-review-recipient-details').click();
        await review.getByTestId('email-review-to').fill('Layout');
        await expect(review.getByRole('listbox').getByRole('option')).toHaveCount(5);
        await expect(review.locator('label[for="email-review-to"]')).toBeInViewport();
        await expectViewportFit(page, review, [review.getByTestId('email-review-to'), review.getByRole('listbox').getByRole('option').first()], viewport.width);
        await expect(review.getByTestId('email-review-send')).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`recipient-review-${viewport.width}.png`), animations: 'disabled' });
        expect(fixture.unexpected).toEqual([]);
      } finally { await context.close(); }
    });
  }
});
