import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import en from '../messages/en.json';
import de from '../messages/de.json';

const managedStatus = {
  configured: false, complete: false, passwordConfigured: false,
  host: null, port: null, secure: null, tlsMode: null, username: null,
  fromAddress: null, fromName: null, replyTo: null, configurationError: null,
  deliveryMode: 'managed', managedAvailable: true,
};
type Status = typeof managedStatus;

async function installStatus(context: BrowserContext, initial: Partial<Status> = {}, failLoad = false) {
  let status = { ...managedStatus, ...initial };
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  await context.route('**/api/admin/system-email', async route => {
    const request = route.request();
    if (request.method() === 'GET' && failLoad) {
      await route.fulfill({ status: 503, json: { success: false, error: 'Temporary settings failure' } }); return;
    }
    if (request.method() !== 'GET') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), body });
      if (request.method() === 'PATCH') status = { ...status, deliveryMode: String(body.mode) };
      else if (request.method() === 'PUT') status = { ...status, configured: true, complete: true, passwordConfigured: true, deliveryMode: 'local' };
      else throw new Error(`Unexpected settings request: ${request.method()}`);
    }
    await route.fulfill({ json: { success: true, data: status } });
  });
  await context.route('**/api/admin/system-email/test', route => route.abort('blockedbyclient'));
  return { writes, recover: () => { failLoad = false; } };
}

async function openSettings(page: Page, locale = 'en') {
  await page.goto(`/${locale}/settings?tab=system-email`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('system-email-settings');
  await expect(card).toBeVisible();
  return card;
}

for (const [locale, messages, viewport] of [
  ['en', en, { width: 1440, height: 1000 }],
  ['de', de, { width: 390, height: 844 }],
] as const) {
  test(`managed settings disclose details on demand (${locale}, ${viewport.width}px)`, async ({ browser }, info) => {
    const context = await createAuthenticatedContext(browser, { viewport, locale: locale === 'de' ? 'de-DE' : 'en-US' });
    const fixture = await installStatus(context); const page = await context.newPage();
    try {
      const card = await openSettings(page, locale); const t = messages.settings.systemEmail;
      const trigger = card.getByRole('button', { name: `${t.title}: ${messages.settings.sections.expand}`, exact: true });
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(card).toContainText(t.managedActive);
      await expect(card.getByLabel(t.deliveryMode)).toHaveCount(0);
      const personal = page.getByText(messages.settings.emailAccounts.title, { exact: true })
        .or(page.getByText(messages.settings.emailAccounts.setup.title, { exact: true }));
      const business = page.getByText(messages.settings.workspaceMailboxes.title, { exact: true });
      const system = card.getByText(t.title, { exact: true });
      await expect(personal).toBeVisible();
      await expect(business).toBeVisible();
      expect((await personal.boundingBox())!.y).toBeLessThan((await business.boundingBox())!.y);
      expect((await business.boundingBox())!.y).toBeLessThan((await system.boundingBox())!.y);
      await page.screenshot({ path: info.outputPath(`system-email-${locale}-collapsed.png`), fullPage: true, animations: 'disabled' });
      await trigger.focus(); await page.keyboard.press('Enter');
      await expect(card.getByLabel(t.deliveryMode)).toHaveValue('managed');
      await expect(card.getByLabel(t.host)).toHaveCount(0);
      await expect(card.getByText(t.managedDescription, { exact: true })).toHaveCount(1);
      expect(fixture.writes).toEqual([]);
      await page.screenshot({ path: info.outputPath(`system-email-${locale}-expanded.png`), fullPage: true, animations: 'disabled' });
      await page.evaluate(() => {
        localStorage.setItem('theme', 'dark');
        window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
      });
      await expect(page.locator('html')).toHaveClass(/dark/);
      await page.screenshot({ path: info.outputPath(`system-email-${locale}-dark.png`), fullPage: true, animations: 'disabled' });
      const bounds = (await card.boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      await card.getByLabel(t.deliveryMode).selectOption('disabled');
      await expect(card).toContainText(t.disabledActive);
      await expect(card.getByText(t.missingConfiguration)).toHaveCount(0);
      await expect(card.getByRole('button', { name: t.sendTest, exact: true })).toBeDisabled();
      await card.getByRole('button', { name: t.reload, exact: true }).click();
      await expect(card.getByLabel(t.deliveryMode)).toHaveValue('disabled');
      expect(fixture.writes).toEqual([{ method: 'PATCH', body: { mode: 'disabled' } }]);
    } finally { await context.close(); }
  });
}

test('standalone settings hide the managed choice and preserve SMTP edits when collapsed', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  const fixture = await installStatus(context, { deliveryMode: 'local', managedAvailable: false, passwordConfigured: true }); const page = await context.newPage();
  try {
    const card = await openSettings(page); const t = en.settings.systemEmail;
    await card.getByRole('button', { name: `${t.title}: Expand`, exact: true }).click();
    const mode = card.getByLabel(t.deliveryMode);
    await expect(mode.locator('option')).toHaveText([t.modeLocal, t.modeDisabled]);
    await card.getByLabel(t.host, { exact: true }).fill('smtp.edited.example.test');
    await card.getByLabel(t.username, { exact: true }).fill('sender');
    await card.getByLabel(t.fromAddress, { exact: true }).fill('sender@example.test');
    await card.getByRole('button', { name: `${t.title}: Collapse`, exact: true }).click();
    await expect(card.getByLabel(t.host, { exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: `${t.title}: Expand`, exact: true }).click();
    await expect(card.getByLabel(t.host, { exact: true })).toHaveValue('smtp.edited.example.test');
    await card.getByRole('button', { name: t.save, exact: true }).click();
    await expect(card).toContainText(t.saved);
    expect(fixture.writes).toHaveLength(1); expect(fixture.writes[0].method).toBe('PUT');
    expect(fixture.writes[0].body).toMatchObject({ host: 'smtp.edited.example.test', username: 'sender', password: '', fromAddress: 'sender@example.test' });
  } finally { await context.close(); }
});

test('a disconnected managed sender shows an unavailable state without switching delivery mode', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  const fixture = await installStatus(context, { managedAvailable: false }); const page = await context.newPage();
  try {
    const card = await openSettings(page); const t = en.settings.systemEmail;
    await expect(card).toContainText(t.statusNotConfigured);
    await expect(card).not.toContainText(t.managedActive);
    await card.getByRole('button', { name: `${t.title}: Expand`, exact: true }).click();
    await expect(card.getByLabel(t.deliveryMode)).toHaveValue('');
    await expect(card.getByLabel(t.deliveryMode).locator('option[value="managed"]')).toHaveCount(0);
    await expect(card).toContainText(t.managedUnavailable);
    await expect(card.getByRole('button', { name: t.sendTest, exact: true })).toBeDisabled();
    expect(fixture.writes).toEqual([]);
    await card.getByLabel(t.deliveryMode).selectOption('local');
    await expect(card.getByLabel(t.host, { exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([{ method: 'PATCH', body: { mode: 'local' } }]);
  } finally { await context.close(); }
});

test('loading errors remain actionable while the system card is collapsed', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  const fixture = await installStatus(context, {}, true); const page = await context.newPage();
  try {
    const card = await openSettings(page);
    await expect(card.getByRole('alert')).toContainText('Temporary settings failure');
    await expect(card.getByRole('button', { name: 'System email: Expand', exact: true })).toHaveAttribute('aria-expanded', 'false');
    fixture.recover(); await card.getByRole('button', { name: en.settings.systemEmail.reload, exact: true }).click();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card).toContainText(en.settings.systemEmail.managedActive);
    expect(fixture.writes).toEqual([]);
  } finally { await context.close(); }
});

test('the managed stack renders the actual saved system sender below Business inbox', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser); const page = await context.newPage();
  try {
    const response = await context.request.get('/api/admin/system-email'); expect(response.ok()).toBe(true);
    const { data: status } = await response.json();
    const card = await openSettings(page);
    await card.getByRole('button', { name: 'System email: Expand', exact: true }).click();
    await expect(card.getByLabel(en.settings.systemEmail.deliveryMode)).toHaveValue(status.deliveryMode === 'managed' && !status.managedAvailable ? '' : status.deliveryMode);
    await expect(card.getByLabel(en.settings.systemEmail.deliveryMode).locator('option[value="managed"]')).toHaveCount(status.managedAvailable ? 1 : 0);
  } finally { await context.close(); }
});
