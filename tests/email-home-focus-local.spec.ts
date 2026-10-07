import { expect, test, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { EmailClassificationFeed } from '../app/lib/email/classification/feed-types';
import type { EmailClassificationSettings } from '../app/lib/email/classification/settings-types';

// Opt-in real managed-stack acceptance. No email, classification, settings,
// preference or Home widget responses are mocked.
type Fixture = {
  baseUrl: string;
  privatePaths: { auth: string };
  owned: { accounts: Array<{ accountId: string; workspaceId: string | null; emailAddress: string }> };
};
const fixtureFile = process.env.CANVAS_EMAIL_CLASSIFICATION_FIXTURE_FILE;
const fixture: Fixture | undefined = fixtureFile ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : undefined;
const messages = JSON.parse(readFileSync('messages/de.json', 'utf8'));
type Diagnostic = { pathname: string; status: number; enabled?: boolean; revisionType?: string; revisionValid?: boolean; reason?: string | null };
const diagnostics = new WeakMap<BrowserContext, Diagnostic[]>();

async function data<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), `GET ${path.split('?')[0]}`).toBe(200);
  return (await response.json() as { data: T }).data;
}
async function patch(request: APIRequestContext, path: string, body: unknown) {
  const response = await request.patch(path, { headers: { Origin: fixture!.baseUrl, 'Sec-Fetch-Site': 'same-origin' }, data: body });
  expect(response.status(), `PATCH ${path}`).toBe(200);
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
async function context(browser: Browser): Promise<BrowserContext> {
  const result = await browser.newContext({ baseURL: fixture!.baseUrl, storageState: fixture!.privatePaths.auth,
    viewport: { width: 1440, height: 960 } });
  const records: Diagnostic[] = [];
  diagnostics.set(result, records);
  result.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (!['/api/email/classification/availability', '/api/home/workspace-widgets', '/api/auth/get-session'].includes(pathname)) return;
    const record: Diagnostic = { pathname, status: response.status() };
    records.push(record);
    if (pathname === '/api/email/classification/availability') void response.json().then(payload => {
      record.enabled = payload.data?.enabled;
      record.revisionType = typeof payload.data?.revision;
      record.revisionValid = Number.isSafeInteger(payload.data?.revision);
      record.reason = payload.data?.reason;
    }).catch(() => undefined);
  });
  const response = await result.request.get('/api/auth/get-session');
  expect(response.status()).toBe(200);
  const session = await response.json();
  expect(session.user?.role).toBe('admin');
  await result.addInitScript(() => localStorage.setItem('theme', 'light'));
  // User-hint presentation is unrelated to the actual mail/Home/provider data.
  await result.route('**/api/user-hints**', route => route.fulfill({ json: {
    page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [],
  } }));
  return result;
}

test.describe('Actual Home email Focus and native OpenAI settings', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  test.skip(!fixtureFile, 'Requires freshly prepared private managed mail fixtures.');
  test.beforeAll(() => {
    expect(process.env.E2E_EXTERNAL_SERVER).toBe('1');
    expect(['127.0.0.1', 'localhost']).toContain(new URL(fixture!.baseUrl).hostname);
    expect(fixture!.owned.accounts.every(source => source.emailAddress.endsWith('@email-classification.test'))).toBe(true);
  });

  test('shows the persisted global top two with ratings and opens the exact work source without saving a new mode', async ({ browser }, info) => {
    const authenticated = await context(browser);
    const previous = await data<{ emailExperienceMode?: 'focus' | 'classic' }>(authenticated.request, '/api/user-preferences');
    const initiallyEnabled = (await settings(authenticated.request)).configuration.enabled;
    const failures: string[] = [];
    try {
      expect(initiallyEnabled, 'Complete the approved synthetic Jev fixture run first.').toBe(true);
      await patch(authenticated.request, '/api/user-preferences', { emailExperienceMode: 'classic' });
      const expected = await data<EmailClassificationFeed>(authenticated.request,
        '/api/email/classification/feed?scope=all&mode=focus&view=focus&limit=2');
      expect(expected.items).toHaveLength(2);
      const work = expected.items.find(row => row.origin.workspaceId && fixture!.owned.accounts.some(source => source.accountId === row.origin.accountId));
      expect(work, 'At least one real prepared work message must rank in the Home preview.').toBeDefined();
      const page = await authenticated.newPage();
      page.on('pageerror', error => failures.push(error.name));
      const requests: URL[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/email/classification/feed') requests.push(url);
      });
      await page.goto('/de', { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
      await expect(page.getByRole('navigation', { name: 'Startseitenansichten' }).getByRole('button', { name: 'Workspace', exact: true })).toHaveAttribute('aria-current', 'step');
      const card = page.getByTestId('workspace-widget-email');
      const rows = card.getByTestId('home-email-focus-row');
      await expect(rows).toHaveCount(2);
      const summary = card.getByTestId('home-email-focus-summary');
      await expect(summary).toHaveAttribute('data-focus-count', String(expected.counts.groups.important + expected.counts.groups.reply));
      await expect(summary).toHaveAttribute('data-important-count', String(expected.counts.groups.important));
      await expect(summary).toHaveAttribute('data-reply-count', String(expected.counts.groups.reply));
      await expect(summary).toHaveAttribute('data-total-count', String(expected.counts.total));
      await expect(card.getByTestId('home-email-focus-review')).toContainText(String(expected.counts.groups.review));
      await expect(card.getByTestId('home-email-focus-pending')).toContainText(String(expected.counts.groups.pending));
      expect(requests.some(url => url.searchParams.get('limit') === '2' && url.searchParams.get('scope') === 'all')).toBe(true);
      for (let index = 0; index < expected.items.length; index += 1) {
        const item = expected.items[index];
        await expect(rows.nth(index)).toContainText(item.message.subject);
        if (item.classification?.category) await expect(rows.nth(index)).toContainText(messages.emailFocus.categories[item.classification.category]);
        if (item.classification?.priority === 'high' || item.classification?.priority === 'urgent') {
          await expect(rows.nth(index)).toContainText(messages.emailFocus.priorities[item.classification.priority]);
        }
        if (item.classification?.needsReply && item.classification.replyStatus !== 'answered') await expect(rows.nth(index)).toContainText(messages.emailFocus.reasons.needsReply);
        await expect(rows.nth(index)).toContainText(item.origin.emailAddress);
        expect(new URL((await rows.nth(index).getAttribute('href'))!, fixture!.baseUrl).searchParams.get('messageRef')).toBe(item.messageRef);
      }
      await expect(card).not.toContainText(/\d+\s*%/u);
      await page.screenshot({ path: info.outputPath('home-email-focus-desktop-light.png'), animations: 'disabled' });
      await page.evaluate(() => {
        localStorage.setItem('theme', 'dark');
        window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
      });
      await expect(page.locator('html')).toHaveClass(/dark/u);
      await page.screenshot({ path: info.outputPath('home-email-focus-desktop-dark.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await card.scrollIntoViewIfNeeded();
      await expect(rows.first()).toBeInViewport();
      const widths = await card.evaluate(element => ({ card: element.clientWidth,
        header: element.querySelector('header')!.clientWidth,
        summary: element.querySelector('[data-testid="home-email-focus-summary"]')!.clientWidth,
        preview: element.querySelector('[data-testid="workspace-widget-email-preview"]')!.clientWidth }));
      for (const width of [widths.header, widths.summary, widths.preview]) expect(width).toBeLessThanOrEqual(widths.card + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('home-email-focus-mobile-dark.png'), animations: 'disabled' });
      await page.evaluate(() => {
        localStorage.setItem('theme', 'light');
        window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'light' }));
      });
      await expect(page.locator('html')).toHaveClass(/light/u);
      await page.screenshot({ path: info.outputPath('home-email-focus-mobile-light.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 960 });
      const loaded = page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' && url.pathname === `/api/email/accounts/${encodeURIComponent(work!.origin.accountId)}/messages/${encodeURIComponent(work!.origin.canonicalId)}`;
      });
      await rows.filter({ hasText: work!.message.subject }).click();
      const detail = await loaded;
      expect(detail.status()).toBe(200);
      expect(new URL(detail.url()).searchParams.get('mailboxWorkspaceId')).toBe(work!.origin.workspaceId);
      await expect(page.getByTestId('email-focus-header').getByRole('button', { name: 'Fokus', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#email-focus-scope')).toHaveValue('all');
      const reader = page.locator('article').filter({ has: page.getByRole('heading', { name: work!.message.subject, exact: true }) }).last();
      await expect(reader).toBeVisible();
      await expect(reader.locator('pre')).toContainText('der zugesagte Termin war vor zehn Tagen');
      expect((await data<{ emailExperienceMode?: string }>(authenticated.request, '/api/user-preferences')).emailExperienceMode).toBe('classic');
      await page.screenshot({ path: info.outputPath('home-work-email-deep-link.png'), animations: 'disabled' });
      expect(failures, 'Actual Home and reader should have no page errors.').toEqual([]);
    } finally {
      try { await enabled(authenticated.request, initiallyEnabled); }
      finally {
        try { await patch(authenticated.request, '/api/user-preferences', { emailExperienceMode: previous.emailExperienceMode ?? null }); }
        finally { await authenticated.close(); }
      }
    }
  });

  test('uses confirmed-off legacy previews and offers native OpenAI configuration without persisting the draft', async ({ browser }, info) => {
    const authenticated = await context(browser);
    const original = await settings(authenticated.request);
    try {
      await enabled(authenticated.request, false);
      const page = await authenticated.newPage();
      let feedRequests = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/email/classification/feed') feedRequests += 1; });
      await page.goto('/de', { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Zum Workspace', exact: true }).click();
      await expect(page.getByRole('navigation', { name: 'Startseitenansichten' }).getByRole('button', { name: 'Workspace', exact: true })).toHaveAttribute('aria-current', 'step');
      const card = page.getByTestId('workspace-widget-email');
      await expect(card).toContainText(messages.home.workspaceWidgets.email.description);
      await expect(card.getByTestId('home-email-focus-row')).toHaveCount(0);
      expect(feedRequests).toBe(0);
      await page.goto('/de/settings?tab=system-email', { waitUntil: 'domcontentloaded' });
      const settingsCard = page.getByTestId('email-classification-settings');
      await expect(settingsCard).toBeVisible();
      await settingsCard.getByRole('button', { name: messages.emailClassificationSettings.configuration, exact: true }).click();
      const saved = await settings(authenticated.request);
      await page.locator('#email-classification-provider').selectOption('openai-decisions');
      await expect(page.locator('#email-classification-model')).toHaveValue('gpt-6-luna');
      await expect(page.locator('#email-classification-credential')).toHaveValue('OPENAI_API_KEY');
      await expect(page.locator('#email-classification-endpoint')).toHaveCount(0);
      await expect(page.locator('#email-classification-private-network')).toHaveCount(0);
      const secretStatus = await data<{ entries: Array<{ key: string; value: string }> }>(authenticated.request,
        '/api/integrations/env?scope=all&secretScope=system&key=OPENAI_API_KEY');
      const hasSystemKey = secretStatus.entries.some(entry => entry.key === 'OPENAI_API_KEY' && Boolean(entry.value.trim()));
      if (!hasSystemKey) {
        const tested = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/admin/email-classification/test');
        await settingsCard.getByRole('button', { name: messages.emailClassificationSettings.testAction, exact: true }).click();
        const response = await tested;
        expect(response.status()).toBe(409);
        expect((await response.json()).code).toBe('EMAIL_CLASSIFICATION_CREDENTIAL_MISSING');
        await expect(settingsCard).toContainText(messages.emailClassificationSettings.errors.credentialMissing);
        await expect(settingsCard.getByRole('link', { name: messages.emailClassificationSettings.secretsLink }).first()).toHaveAttribute('href', /settings\?tab=secrets/u);
      }
      expect((await settings(authenticated.request)).revision).toBe(saved.revision);
      expect((await settings(authenticated.request)).configuration).toEqual(saved.configuration);
      await page.screenshot({ path: info.outputPath('native-openai-decisions-settings.png'), animations: 'disabled' });
    } finally {
      try { await enabled(authenticated.request, original.configuration.enabled); }
      finally {
        console.log(JSON.stringify({ homeHttpDiagnostics: diagnostics.get(authenticated) ?? [] }));
        try { await info.attach('home-http-diagnostics', { body: Buffer.from(JSON.stringify(diagnostics.get(authenticated) ?? [], null, 2)), contentType: 'application/json' }); }
        finally { await authenticated.close(); }
      }
    }
  });
});
