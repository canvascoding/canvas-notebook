import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import type { EmailClassificationFeed, EmailClassificationFeedItem } from '../app/lib/email/classification/feed-types';
import type { EmailClassificationMessageDetail } from '../app/lib/email/classification/state-service';
import type { EmailClassificationSettings } from '../app/lib/email/classification/settings-types';

// Opt-in only. The managed native TLS mail fixtures and Notebook must already be
// running. Run with E2E_EXTERNAL_SERVER=1 and --workers=1 after the final build.
// Core email, classification, settings and preference requests are never mocked.
type Account = { label: string; accountId: string; workspaceId: string | null; emailAddress: string };
type Fixture = {
  baseUrl: string;
  privatePaths: { auth: string; readonlyAuth: string; credentials: string; caCert: string };
  owned: { accounts: Account[]; messages: Array<{ label: string; key: string; subject: string }> };
  readonlyFixture?: { available: boolean; userId: string; authStatePath: string };
  checks: Record<string, { ids?: Array<{ id: string; uid: number | string; subject: string }> }>;
};
type Credentials = {
  domain: string; users: Record<string, { email: string; username: string; password: string }>;
  smtp: { host: string; port: number; secure: boolean }; imap: { host: string; port: number; secure: boolean };
  mailpitHttp: string;
};
type MailpitSummary = { ID: string; Subject: string; From: { Address: string }; To: Array<{ Address: string }> };
type MailpitDetail = MailpitSummary & { Text: string; HTML: string };
type Message = { id: string; folder: string; uid?: number; subject: string; body: string; isRead: boolean; isAnswered?: boolean };

const fixtureFile = process.env.CANVAS_EMAIL_CLASSIFICATION_FIXTURE_FILE;
const fixture: Fixture | undefined = fixtureFile ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : undefined;
const modeName = { focus: /^Fokus$|^Focus$/i, classic: /^Klassisch$|^Classic$/i };
const allView = /^Alle E-Mails:|^All emails:/i;
const mutationHeaders = () => ({ Origin: fixture!.baseUrl, 'Sec-Fetch-Site': 'same-origin' });
type BrowserDiagnostic = { kind: 'pageerror' | 'http'; name?: string; messageHash?: string; pathname?: string; status?: number };
const browserDiagnostics = new WeakMap<BrowserContext, BrowserDiagnostic[]>();

async function emailReady(page: Page) {
  await expect(page.getByTestId('email-focus-header'), 'Actual email source and classification controls must finish loading.').toBeVisible({ timeout: 30_000 });
}
async function closeContext(context: BrowserContext) {
  const failures = browserDiagnostics.get(context) ?? [];
  try {
    if (failures.length) await test.info().attach('email-browser-diagnostics', {
      body: Buffer.from(JSON.stringify(failures, null, 2)), contentType: 'application/json',
    });
  } finally { await context.close(); }
}

function account(label: string): Account {
  const result = fixture!.owned.accounts.find(item => item.label === label);
  if (!result) throw new Error(`Missing owned fixture account: ${label}.`);
  return result;
}
function subject(key: string): string {
  const result = fixture!.owned.messages.find(item => item.key === key);
  if (!result) throw new Error(`Missing synthetic fixture message: ${key}.`);
  return result.subject;
}
function credentials(): Credentials {
  const result: Credentials = JSON.parse(readFileSync(fixture!.privatePaths.credentials, 'utf8'));
  if (result.domain !== 'email-classification.test' || result.smtp.host !== '127.0.0.1'
    || result.imap.host !== '127.0.0.1' || new URL(result.mailpitHttp).hostname !== '127.0.0.1') {
    throw new Error('This test requires the isolated local email fixture.');
  }
  return result;
}
async function data<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), `GET ${path.split('?')[0]}`).toBe(200);
  return (await response.json() as { success: boolean; data: T }).data;
}
async function patch(request: APIRequestContext, path: string, body: unknown) {
  const response = await request.patch(path, { headers: mutationHeaders(), data: body });
  expect(response.status(), `PATCH ${path}`).toBe(200);
  return response;
}
async function authenticated(browser: Browser, readonly = false): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: fixture!.baseUrl, storageState: readonly
    ? fixture!.readonlyFixture!.authStatePath : fixture!.privatePaths.auth, viewport: { width: 1440, height: 960 } });
  const failures: BrowserDiagnostic[] = [];
  browserDiagnostics.set(context, failures);
  context.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.origin === new URL(fixture!.baseUrl).origin && failures.length < 100) {
      failures.push({ kind: 'http', pathname: url.pathname, status: response.status() });
    }
  });
  context.on('page', page => page.on('pageerror', error => {
    if (failures.length < 100) failures.push({ kind: 'pageerror', name: error.name,
      messageHash: createHash('sha256').update(error.message).digest('hex').slice(0, 16) });
  }));
  const response = await context.request.get('/api/auth/get-session');
  const session = await response.json() as { user?: { id: string; role?: string } };
  expect(response.status()).toBe(200);
  expect(Boolean(session.user?.id), 'The private storage state must contain a current actual session.').toBe(true);
  if (readonly) expect(session.user?.id).toBe(fixture!.readonlyFixture!.userId);
  else expect(session.user?.role).toBe('admin');
  await context.addInitScript(() => localStorage.setItem('theme', 'light'));
  await context.route('**/api/user-hints**', route => route.fulfill({ json: {
    page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [],
  } }));
  return context;
}
async function feed(request: APIRequestContext, query = 'scope=all&mode=focus&view=all') {
  return data<EmailClassificationFeed>(request, `/api/email/classification/feed?${query}&limit=100`);
}
async function detail(request: APIRequestContext, ref: string) {
  return data<EmailClassificationMessageDetail>(request, `/api/email/classification/message?messageRef=${encodeURIComponent(ref)}`);
}
function itemFrom(current: EmailClassificationFeed, label: string, title: string) {
  const item = current.items.find(row => row.origin.accountId === account(label).accountId && row.message.subject === title);
  if (!item) throw new Error(`Owned synthetic item absent from actual index: ${label}.`);
  return item;
}
async function preferences(request: APIRequestContext) {
  return data<{ emailExperienceMode?: 'focus' | 'classic' }>(request, '/api/user-preferences');
}
async function setMode(request: APIRequestContext, mode: 'focus' | 'classic' | null) {
  await patch(request, '/api/user-preferences', { emailExperienceMode: mode });
}
async function settings(request: APIRequestContext) {
  return (await data<{ settings: EmailClassificationSettings }>(request, '/api/admin/email-classification/settings')).settings;
}
async function enabled(request: APIRequestContext, value: boolean) {
  const current = await settings(request);
  if (current.configuration.enabled !== value) await patch(request, '/api/admin/email-classification/settings', {
    expectedRevision: current.revision, configuration: { ...current.configuration, enabled: value },
  });
}
async function assessmentKeepsBodyVisible(page: Page, item: EmailClassificationFeedItem, bodyText: string) {
  const panel = page.getByTestId('email-assessment-scroll').last();
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const dimensions = await panel.evaluate(element => {
    const container = element.closest('[role="dialog"]') ?? element.parentElement!;
    const bounds = container.getBoundingClientRect();
    return { panelHeight: element.clientHeight, visibleReaderHeight: Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.top),
      overflow: getComputedStyle(element).overflowY };
  });
  expect(dimensions.overflow).toBe('auto');
  expect(dimensions.panelHeight).toBeLessThanOrEqual(dimensions.visibleReaderHeight / 2 + 2);
  const body = page.locator('article').filter({ has: page.getByRole('heading', { name: item.message.subject, exact: true }) })
    .last().locator('pre').filter({ hasText: bodyText });
  await expect(body).toBeVisible();
  await expect(body).toBeInViewport({ ratio: 1 });
  const [panelBounds, bodyBounds] = await Promise.all([panel.boundingBox(), body.boundingBox()]);
  expect(bodyBounds!.y).toBeGreaterThanOrEqual(panelBounds!.y + panelBounds!.height - 1);
}
async function allRows(page: Page) {
  await page.getByTestId('email-focus-navigation').getByRole('button', { name: allView }).click();
}
async function openMessage(page: Page, item: EmailClassificationFeedItem, bodyText: string) {
  const loaded = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === `/api/email/accounts/${encodeURIComponent(item.origin.accountId)}/messages/${encodeURIComponent(item.origin.canonicalId)}`;
  });
  await page.getByTestId('email-focus-row').filter({ hasText: item.message.subject }).click();
  const response = await loaded;
  expect(response.status(), 'The selected source must load its real message.').toBe(200);
  expect(new URL(response.url()).searchParams.get('mailboxWorkspaceId')).toBe(item.origin.workspaceId);
  const reader = page.locator('article').filter({ has: page.getByRole('heading', { name: item.message.subject, exact: true }) }).last();
  await expect(reader).toBeVisible();
  const iframe = reader.locator('iframe');
  if (await iframe.count()) await expect(reader.frameLocator('iframe').getByText(bodyText, { exact: false })).toBeVisible();
  else await expect(reader.locator('pre').getByText(bodyText, { exact: false })).toBeVisible();
}
async function message(request: APIRequestContext, item: EmailClassificationFeedItem) {
  const query = new URLSearchParams({ folder: item.origin.folder });
  if (item.origin.workspaceId) query.set('mailboxWorkspaceId', item.origin.workspaceId);
  return (await data<{ message: Message }>(request, `/api/email/accounts/${encodeURIComponent(item.origin.accountId)}/messages/${encodeURIComponent(item.origin.canonicalId)}?${query}`)).message;
}
async function action(request: APIRequestContext, item: EmailClassificationFeedItem, name: string) {
  const response = await request.post(`/api/email/accounts/${encodeURIComponent(item.origin.accountId)}/messages/actions`, {
    headers: mutationHeaders(), data: { operation: 'action', messageId: item.origin.canonicalId, action: name,
      folder: item.origin.folder, mailboxWorkspaceId: item.origin.workspaceId },
  });
  expect(response.status(), `Owned fixture action ${name}`).toBe(200);
}
async function restoreFlags(request: APIRequestContext, item: EmailClassificationFeedItem, original: Message) {
  const current = await message(request, item);
  if (current.isRead !== original.isRead) await action(request, item, original.isRead ? 'mark-read' : 'mark-unread');
  if (current.isAnswered !== original.isAnswered) await action(request, item, original.isAnswered ? 'mark-answered' : 'clear-answered');
}
async function theme(page: Page, value: 'light' | 'dark') {
  await page.evaluate(next => { localStorage.setItem('theme', next); window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: next })); }, value);
  await expect(page.locator('html')).toHaveClass(new RegExp(value));
}
async function mailpitRows(): Promise<MailpitSummary[]> {
  const response = await fetch(`${credentials().mailpitHttp}/api/v1/messages?limit=500`);
  expect(response.status, 'Local Mailpit list').toBe(200);
  return (await response.json() as { messages: MailpitSummary[] }).messages;
}
async function cleanupTransport(title: string) {
  // The UUID subject identifies only this run's attachment or explicitly sent reply.
  for (const row of (await mailpitRows()).filter(row => row.Subject === title)) {
    const response = await fetch(`${credentials().mailpitHttp}/api/v1/messages`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [row.ID] }),
    });
    expect(response.ok, 'Delete only this run’s Mailpit message').toBe(true);
  }
  const privateConfig = credentials();
  for (const label of ['customer', 'personal-b', 'work']) {
    const identity = privateConfig.users[label];
    const client = new ImapFlow({ ...privateConfig.imap, auth: { user: identity.username, pass: identity.password },
      logger: false, tls: { ca: readFileSync(fixture!.privatePaths.caCert), rejectUnauthorized: true, servername: 'localhost' } });
    try {
      await client.connect();
      for (const folder of (await client.list()).filter(folder => /^(INBOX|Sent)$/i.test(folder.path))) {
        const lock = await client.getMailboxLock(folder.path);
        try {
          const uids = await client.search({ header: { subject: title } }, { uid: true });
          if (uids && uids.length) await client.messageDelete(uids, { uid: true });
        } finally { lock.release(); }
      }
    } finally { await client.logout().catch(() => undefined); }
  }
}
async function cleanup(tasks: Array<() => Promise<unknown>>) {
  let failed = 0;
  for (const task of tasks) { try { await task(); } catch { failed += 1; } }
  if (failed) throw new Error(`${failed} owned fixture cleanup operations failed; other restoration operations were still attempted.`);
}

test.describe('Actual local classified email experience', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  test.skip(!fixtureFile, 'Requires the private managed email-classification fixture.');
  test.beforeAll(() => {
    expect(process.env.E2E_EXTERNAL_SERVER, 'Use the already managed Notebook server.').toBe('1');
    expect(['localhost', '127.0.0.1']).toContain(new URL(fixture!.baseUrl).hostname);
    expect(fixture!.owned.accounts.every(row => row.emailAddress.endsWith('@email-classification.test'))).toBe(true);
  });

  test('defaults to focused all-mailbox work, persists modes and reuses ratings after central off/on', async ({ browser }, testInfo) => {
    const context = await authenticated(browser);
    const previous = await preferences(context.request);
    const initiallyEnabled = (await settings(context.request)).configuration.enabled;
    try {
      expect(initiallyEnabled, 'The approved synthetic Jev run must be complete before this test.').toBe(true);
      const before = await feed(context.request);
      const owned = before.items.filter(row => fixture!.owned.accounts.some(source => source.accountId === row.origin.accountId));
      expect(owned.length).toBeGreaterThanOrEqual(7);
      expect(owned.every(row => row.classification?.evaluatedAt !== null && row.classification?.evaluatedAt !== undefined)).toBe(true);
      await setMode(context.request, null);
      const page = await context.newPage();
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await emailReady(page);
      const header = page.getByTestId('email-focus-header');
      await expect(header.getByRole('button', { name: modeName.focus })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#email-focus-scope')).toHaveValue('all');
      const focus = await feed(context.request, 'scope=all&mode=focus&view=focus');
      await expect(page.getByTestId('email-focus-row')).toHaveCount(focus.items.length);
      expect(focus.items.every(row => ['important', 'reply'].includes(row.classification!.group))).toBe(true);
      await expect(page.getByRole('button', { name: /^Noch prüfen:|^Needs review:/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Noch nicht vorbereitet:|^Not yet prepared:/i })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('email-focus-desktop-light.png'), animations: 'disabled' });
      await theme(page, 'dark');
      await page.screenshot({ path: testInfo.outputPath('email-focus-desktop-dark.png'), animations: 'disabled' });
      for (const scope of ['personal', 'work', `mailbox:${itemFrom(before, 'work', subject('work-complaint')).origin.mailboxRef}`]) {
        await page.locator('#email-focus-scope').selectOption(scope);
        await expect(page.locator('#email-focus-scope')).toHaveValue(scope);
        const query = scope.startsWith('mailbox:') ? `scope=mailbox&mailboxRef=${encodeURIComponent(scope.slice(8))}` : `scope=${scope}`;
        const scoped = await feed(context.request, `${query}&mode=focus&view=focus`);
        await expect(page.getByTestId('email-focus-row')).toHaveCount(scoped.items.length);
        expect(scoped.items.every(row => scope === 'personal' ? !row.origin.workspaceId : Boolean(row.origin.workspaceId))).toBe(true);
      }
      await header.getByRole('button', { name: modeName.classic }).click();
      await expect.poll(async () => (await preferences(context.request)).emailExperienceMode).toBe('classic');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await emailReady(page);
      await expect(header.getByRole('button', { name: modeName.classic })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#email-focus-scope')).toHaveValue(`mailbox:${itemFrom(before, 'work', subject('work-complaint')).origin.mailboxRef}`);
      for (const scope of ['personal', 'work']) {
        await page.locator('#email-focus-scope').selectOption(scope);
        const scoped = await feed(context.request, `scope=${scope}&mode=classic&view=all`);
        await expect(page.getByTestId('email-focus-row')).toHaveCount(scoped.items.length);
        expect(scoped.items.every(row => scope === 'personal' ? !row.origin.workspaceId : Boolean(row.origin.workspaceId))).toBe(true);
      }
      await page.locator('#email-focus-scope').selectOption('all');
      const classic = await feed(context.request, 'scope=all&mode=classic&view=all');
      expect(classic.items.map(row => Date.parse(row.message.date))).toEqual(classic.items.map(row => Date.parse(row.message.date)).sort((a, b) => b - a));
      await expect(page.getByTestId('email-focus-row')).toHaveCount(classic.items.length);
      await header.getByRole('button', { name: modeName.focus }).click();
      await enabled(context.request, false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await emailReady(page);
      await expect(header.getByRole('button', { name: modeName.focus })).toBeDisabled();
      await expect(header.getByText(/zentral deaktiviert|disabled centrally/i)).toBeVisible();
      const disabled = await feed(context.request, 'scope=all&mode=classic&view=all');
      expect(disabled.items.length).toBeGreaterThanOrEqual(owned.length);
      expect(disabled.items.every(row => row.classification === null)).toBe(true);
      await enabled(context.request, true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await emailReady(page);
      await expect(header.getByRole('button', { name: modeName.focus })).toBeEnabled();
      const after = await feed(context.request);
      for (const row of owned) expect(after.items.find(next => next.messageRef === row.messageRef)?.classification).toEqual(row.classification);
    } finally {
      try { await cleanup([
        () => enabled(context.request, initiallyEnabled),
        () => setMode(context.request, previous.emailExperienceMode ?? null),
      ]); } finally { await closeContext(context); }
    }
  });

  test('keeps colliding IMAP UIDs on their source and downloads the selected work-mailbox attachment', async ({ browser }, testInfo) => {
    const context = await authenticated(browser);
    const previous = await preferences(context.request);
    const current = await feed(context.request);
    const personal = itemFrom(current, 'personal-b', subject('security'));
    const work = itemFrom(current, 'work', subject('work-complaint'));
    const originals = await Promise.all([message(context.request, personal), message(context.request, work)]);
    const title = `QA E2E attachment ${randomUUID()}`;
    const attachmentText = `Owned work attachment: ${title}`;
    let created: EmailClassificationFeedItem | undefined;
    try {
      expect(Number(fixture!.checks['personal-b'].ids!.find(row => row.subject === personal.message.subject)!.uid)).toBe(1);
      expect(Number(fixture!.checks.work.ids!.find(row => row.subject === work.message.subject)!.uid)).toBe(1);
      expect(personal.selectionKey).not.toBe(work.selectionKey);
      await setMode(context.request, 'focus');
      const page = await context.newPage();
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await emailReady(page);
      await allRows(page);
      await openMessage(page, personal, 'unberechtigten Zugriff auf unser Testkonto');
      await openMessage(page, work, 'der zugesagte Termin war vor zehn Tagen');
      await expect(page.getByTestId('email-focus-row').filter({ hasText: work.message.subject })).toContainText(account('work').emailAddress);
      await expect(page.getByTestId('email-classification-expand')).toBeVisible();
      await page.getByTestId('email-classification-expand').click();
      await expect(page.getByText(/Ein Strich bedeutet|A dash means/i)).toBeVisible();
      await assessmentKeepsBodyVisible(page, work, 'der zugesagte Termin war vor zehn Tagen');
      await page.screenshot({ path: testInfo.outputPath('email-origin-assessment.png'), animations: 'disabled' });
      const privateConfig = credentials();
      const sender = privateConfig.users.customer;
      const transport = nodemailer.createTransport({ ...privateConfig.smtp, auth: { user: sender.username, pass: sender.password }, requireTLS: true,
        tls: { ca: readFileSync(fixture!.privatePaths.caCert), rejectUnauthorized: true, servername: 'localhost' }, disableFileAccess: true, disableUrlAccess: true });
      try { await transport.sendMail({ from: sender.email, to: account('work').emailAddress, subject: title, text: title,
        attachments: [{ filename: 'owned-work-source.txt', content: attachmentText, contentType: 'text/plain' }] }); }
      catch { throw new Error('The synthetic local TLS attachment fixture could not be delivered.'); }
      finally { transport.close(); }
      await expect.poll(async () => {
        const response = await context.request.post('/api/email/messages/list', { headers: mutationHeaders(), data: {
          accountId: account('work').accountId, mailboxWorkspaceId: account('work').workspaceId, folder: 'INBOX', limit: 50, offset: 0, filter: 'all',
        } });
        return response.ok() && (await response.json()).data.messages.some((row: Message) => row.subject === title);
      }, { intervals: [1000, 2000], timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        created = (await feed(context.request)).items.find(row => row.origin.accountId === account('work').accountId && row.message.subject === title);
        return Boolean(created);
      }, { intervals: [1000, 2000], timeout: 30_000 }).toBe(true);
      await page.getByTestId('email-focus-header').getByRole('button', { name: /^Aktualisieren$|^Refresh$/i }).click();
      await openMessage(page, created!, title);
      await page.getByRole('button', { name: /Download-Optionen für den Anhang|Attachment download options/i }).click();
      const link = page.getByRole('menuitem', { name: /Lokal herunterladen|Download locally/i });
      const downloadUrl = new URL((await link.getAttribute('href'))!, fixture!.baseUrl);
      expect(downloadUrl.pathname).toContain(`/accounts/${account('work').accountId}/messages/`);
      expect(downloadUrl.searchParams.get('mailboxWorkspaceId')).toBe(account('work').workspaceId);
      const downloading = page.waitForEvent('download');
      await link.click();
      const download = await downloading;
      const target = testInfo.outputPath('owned-work-source.txt');
      await download.saveAs(target);
      expect(await fs.readFile(target, 'utf8')).toBe(attachmentText);
    } finally {
      try { await cleanup([
        async () => { if (created) await action(context.request, created, 'permanent-delete'); },
        () => cleanupTransport(title),
        () => restoreFlags(context.request, personal, originals[0]),
        () => restoreFlags(context.request, work, originals[1]),
        () => setMode(context.request, previous.emailExperienceMode ?? null),
      ]); } finally { await closeContext(context); }
    }
  });

  test('resumes the fixed-sender reply and keeps readonly personal done separate from the administrator', async ({ browser }, testInfo) => {
    const admin = await authenticated(browser);
    const previous = await preferences(admin.request);
    const current = await feed(admin.request);
    const personal = itemFrom(current, 'personal-b', subject('security'));
    const work = itemFrom(current, 'work', subject('work-complaint'));
    const original = await message(admin.request, personal);
    const originalWork = await message(admin.request, work);
    const title = `QA E2E reply ${randomUUID()}`;
    let readonly: BrowserContext | undefined;
    let readonlyMode: 'focus' | 'classic' | undefined;
    let readonlyDone: boolean | undefined;
    try {
      await setMode(admin.request, 'focus');
      const page = await admin.newPage();
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await emailReady(page);
      await allRows(page);
      await openMessage(page, personal, 'unberechtigten Zugriff auf unser Testkonto');
      await page.getByRole('button', { name: /^Antwortoptionen$|^Reply options$/i }).click();
      await page.getByRole('menuitem', { name: /^Antworten$|^Reply$/i }).click();
      const compose = page.getByRole('dialog').filter({ has: page.locator('#email-compose-subject') });
      await expect(compose.getByText(account('personal-b').emailAddress, { exact: true })).toBeVisible();
      await compose.locator('#email-compose-subject').fill(title);
      await compose.locator('[contenteditable="true"]').first().fill(`Synthetic human reply ${title}`);
      await compose.getByTestId('email-compose-minimize').click();
      await page.getByTestId('email-focus-header').getByRole('button', { name: modeName.classic }).click();
      await page.locator('#email-focus-scope').selectOption('work');
      await page.getByTestId('email-focus-header').getByRole('button', { name: modeName.focus }).click();
      await page.getByRole('button', { name: /^Entwurf fortsetzen$|^Resume draft$/i }).click();
      await expect(compose.locator('#email-compose-subject')).toHaveValue(title);
      await expect(compose.getByText(account('personal-b').emailAddress, { exact: true })).toBeVisible();
      const sending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/email/accounts/${account('personal-b').accountId}/messages/actions`
        && response.request().postDataJSON()?.operation === 'send');
      await compose.getByRole('button', { name: /^Senden$|^Send$/i }).click();
      const sent = await sending;
      expect(sent.status(), 'Actual explicit UI send').toBe(200);
      expect(sent.request().postDataJSON().mailboxWorkspaceId ?? null).toBe(null);
      await expect.poll(async () => (await mailpitRows()).some(row => row.Subject === title), { timeout: 30_000 }).toBe(true);
      const outgoing = (await mailpitRows()).find(row => row.Subject === title)!;
      expect(outgoing.From.Address).toBe(account('personal-b').emailAddress);
      expect(outgoing.To.map(recipient => recipient.Address)).toEqual([credentials().users.customer.email]);
      const delivered = await fetch(`${credentials().mailpitHttp}/api/v1/message/${outgoing.ID}`);
      const content = await delivered.json() as MailpitDetail;
      expect(`${content.Text}\n${content.HTML}`).toContain(`Synthetic human reply ${title}`);
      await expect.poll(async () => (await message(admin.request, personal)).isAnswered, { timeout: 30_000 }).toBe(true);
      expect(fixture!.readonlyFixture?.available, 'An existing readonly fixture user must be prepared.').toBe(true);
      readonly = await authenticated(browser, true);
      readonlyMode = (await preferences(readonly.request)).emailExperienceMode;
      readonlyDone = (await detail(readonly.request, work.messageRef)).personalFocus.done;
      const adminDone = (await detail(admin.request, work.messageRef)).personalFocus.done;
      await setMode(readonly.request, 'focus');
      const reader = await readonly.newPage();
      await reader.setViewportSize({ width: 390, height: 844 });
      await reader.goto('/emails', { waitUntil: 'domcontentloaded' });
      await emailReady(reader);
      await allRows(reader);
      await openMessage(reader, work, 'der zugesagte Termin war vor zehn Tagen');
      await reader.getByTestId('email-classification-expand').click();
      await expect(reader.getByTestId('email-classification-correct')).toHaveCount(0);
      const readonlyHint = reader.getByText(/Korrekturen benötigen Schreibrechte|Corrections require write access/i);
      await expect(readonlyHint).toBeVisible();
      await assessmentKeepsBodyVisible(reader, work, 'der zugesagte Termin war vor zehn Tagen');
      const assessmentPanel = reader.getByTestId('email-assessment-scroll').last();
      await readonlyHint.scrollIntoViewIfNeeded();
      await expect(readonlyHint).toBeInViewport({ ratio: 1 });
      const hintScroll = await assessmentPanel.evaluate(element => element.scrollTop);
      expect(hintScroll).toBeGreaterThan(0);
      await assessmentKeepsBodyVisible(reader, work, 'der zugesagte Termin war vor zehn Tagen');
      const denied = await readonly.request.patch('/api/email/classification/override', { headers: mutationHeaders(), data: {
        messageRef: work.messageRef, expectedVersion: (await detail(readonly.request, work.messageRef)).classification!.version, overrides: { priority: 'urgent' },
      } });
      expect(denied.status()).toBe(403);
      const doneButton = reader.getByTestId('email-classification-done');
      await doneButton.scrollIntoViewIfNeeded();
      await expect(doneButton).toBeInViewport({ ratio: 1 });
      expect(await assessmentPanel.evaluate(element => element.scrollTop)).toBeLessThan(hintScroll);
      await doneButton.click();
      await expect.poll(async () => (await detail(readonly!.request, work.messageRef)).personalFocus.done).toBe(!readonlyDone);
      expect((await detail(admin.request, work.messageRef)).personalFocus.done).toBe(adminDone);
      expect(await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await reader.screenshot({ path: testInfo.outputPath('email-readonly-mobile-light.png'), animations: 'disabled' });
      await theme(reader, 'dark');
      await reader.screenshot({ path: testInfo.outputPath('email-readonly-mobile-dark.png'), animations: 'disabled' });
      await reader.getByTestId('email-classification-done').click();
      await expect.poll(async () => (await detail(readonly!.request, work.messageRef)).personalFocus.done).toBe(readonlyDone);
    } finally {
      try { await cleanup([
        async () => {
          if (!readonly || readonlyDone === undefined) return;
          const state = await detail(readonly.request, work.messageRef);
          if (state.personalFocus.done !== readonlyDone) await patch(readonly.request, '/api/email/classification/focus', {
            messageRef: work.messageRef, expectedVersion: state.personalFocus.version, done: readonlyDone,
          });
        },
        async () => { if (readonly) await setMode(readonly.request, readonlyMode ?? null); },
        () => cleanupTransport(title),
        () => restoreFlags(admin.request, personal, original),
        () => restoreFlags(admin.request, work, originalWork),
        () => setMode(admin.request, previous.emailExperienceMode ?? null),
      ]); } finally { if (readonly) await closeContext(readonly); await closeContext(admin); }
    }
  });
});
