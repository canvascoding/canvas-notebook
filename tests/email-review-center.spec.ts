import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';

type Draft = {
  id: string; accountId: string; workspaceId: string | null; mailboxId: string | null;
  senderAddress: string; status: string; version: number; subject: string; body: string;
  to: string[]; cc: string[]; bcc: string[]; attachments: unknown[]; isHtml: boolean;
  origin: string; updatedAt: string; createdAt: string; errorCode: string | null;
  errorMessage: string | null; failedAt: string | null; policySettingsUrl: string;
};

function draft(id: string, subject: string, overrides: Partial<Draft> = {}): Draft {
  return {
    id, subject, accountId: 'qa-account', workspaceId: null, mailboxId: null,
    senderAddress: 'sender@example.test', status: 'awaiting_review', version: 1,
    body: '<p>Hello <strong>formatted recipient</strong>.</p><p>Second paragraph.</p>',
    to: ['recipient@example.test'], cc: ['copy@example.test'], bcc: ['blind@example.test'],
    attachments: [], isHtml: true, origin: 'agent', updatedAt: '2026-09-22T09:00:00.000Z',
    createdAt: '2026-09-22T09:00:00.000Z', errorCode: null, errorMessage: null, failedAt: null,
    policySettingsUrl: '/settings?tab=system-email', ...overrides,
  };
}

async function installOutboxFixture(context: BrowserContext, initial: Draft[]) {
  context.setDefaultTimeout(15_000);
  const drafts = new Map(initial.map((item) => [item.id, { ...item }]));
  const writes: Array<{ id: string; action: string; body: Record<string, unknown>; path: string }> = [];
  const unexpected: string[] = [];
  // Every email write is intercepted: no fixture can send a real message.
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = url.pathname.match(/^\/api\/(?:workspaces\/[^/]+\/email|email)\/outbox(?:\/([^/]+))?(?:\/(send|reject))?$/u);
    if (!match) {
      if (url.pathname.includes('/email/') && !['GET', 'HEAD'].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 403, json: { success: false, error: 'Live email mutations disabled by browser test.' } });
      }
      return route.continue();
    }
    const [, id, action] = match;
    const workspaceId = url.pathname.match(/^\/api\/workspaces\/([^/]+)\//u)?.[1];
    if (request.method() === 'GET') {
      return route.fulfill({ json: { success: true, data: id ? drafts.get(id) : [...drafts.values()].filter((item) => workspaceId ? item.workspaceId === decodeURIComponent(workspaceId) : !item.workspaceId) } });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    const current = drafts.get(id);
    if (!current) return route.fulfill({ status: 404, json: { success: false, error: 'Draft not found.' } });
    writes.push({ id, action: action || 'save', body, path: url.pathname });
    if (body.expectedVersion !== current.version) return route.fulfill({ status: 409, json: { success: false, error: 'Draft changed. Reload before continuing.' } });
    if (action === 'send' && current.to.includes('blocked@outside.test')) {
      Object.assign(current, { status: 'send_failed', version: current.version + 2, errorCode: 'SEND_POLICY_BLOCKED', errorMessage: 'blocked@outside.test is excluded by the sending account policy. Correct recipients or Settings > Email.', failedAt: new Date().toISOString() });
      return route.fulfill({ status: 422, json: { success: false, error: current.errorMessage, code: current.errorCode, data: current } });
    }
    if (action === 'send' || action === 'reject') {
      Object.assign(current, { status: action === 'send' ? 'sent' : 'discarded', version: current.version + 1, errorCode: null, errorMessage: null, failedAt: null });
    } else {
      Object.assign(current, body, { version: current.version + 1 });
    }
    return route.fulfill({ json: { success: true, data: current } });
  });
  return { drafts, writes, unexpected };
}

async function openDraft(page: Page, id: string, workspaceId?: string) {
  await page.goto(`/?outboxDraft=${id}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('email-review-host')).toBeVisible({ timeout: 60_000 });
}

// Run with E2E_EXTERNAL_SERVER=1 BASE_URL=http://localhost:3001; credentials are
// provided privately through the existing managed test environment.
test.describe('Global email review', () => {
  test.setTimeout(120_000);
  test('preserves formatted content and BCC while saving, then rejects and advances', async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    const fixture = await installOutboxFixture(context, [draft('review-first', 'First proposal'), draft('review-next', 'Next proposal')]);
    const page = await context.newPage();
    try {
      await openDraft(page, 'review-first');
      const dialog = page.getByTestId('email-review-host');
      await expect(dialog.getByText('sender@example.test', { exact: true }).last()).toBeVisible();
      await expect(dialog.locator('.ProseMirror strong')).toHaveText('formatted recipient');
      await expect(dialog.getByTestId('email-review-bcc')).toHaveValue('blind@example.test');
      await dialog.getByTestId('email-review-subject').fill('Updated proposal');
      await dialog.getByTestId('email-review-draft-review-next').click();
      const unsaved = page.getByTestId('email-review-unsaved-dialog');
      await expect(unsaved).toBeVisible();
      await unsaved.getByRole('button', { name: /abbrechen|cancel|weiter bearbeiten|keep editing/i }).click();
      await expect(dialog.getByTestId('email-review-subject')).toHaveValue('Updated proposal');
      await dialog.getByTestId('email-review-save').click();
      await expect.poll(() => fixture.drafts.get('review-first')?.subject).toBe('Updated proposal');
      expect(fixture.drafts.get('review-first')?.bcc).toEqual(['blind@example.test']);
      expect(fixture.drafts.get('review-first')?.body).toContain('<strong>formatted recipient</strong>');
      await dialog.getByTestId('email-review-reject').click();
      await expect.poll(() => fixture.drafts.get('review-first')?.status).toBe('discarded');
      await expect(dialog.getByTestId('email-review-subject')).toHaveValue('Next proposal');
      await page.screenshot({ path: testInfo.outputPath('email-review-desktop.png') });
      expect(fixture.unexpected).toEqual([]);
    } finally { await context.close(); }
  });

  test('retains a policy failure and sends the corrected draft with the fresh version', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const fixture = await installOutboxFixture(context, [draft('policy', 'Policy proposal', { to: ['blocked@outside.test'] })]);
    const page = await context.newPage();
    try {
      await openDraft(page, 'policy');
      const dialog = page.getByTestId('email-review-host');
      await dialog.getByTestId('email-review-send').click();
      await expect.poll(() => fixture.drafts.get('policy')?.status).toBe('send_failed');
      await expect(dialog.getByTestId('email-review-policy-error')).toBeVisible();
      await expect(dialog.locator('a[href*="settings"]')).toBeVisible();
      await dialog.getByTestId('email-review-to').fill('fixed@example.test');
      await dialog.getByTestId('email-review-send').click();
      await expect.poll(() => fixture.drafts.get('policy')?.status).toBe('sent');
      expect(fixture.writes.filter((write) => write.action === 'send')).toHaveLength(2);
      expect(fixture.unexpected).toEqual([]);
    } finally { await context.close(); }
  });

  test('workspace deep link uses the selected mailbox and scoped send endpoint', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const response = await context.request.get('/api/workspaces');
    expect(response.ok()).toBeTruthy();
    const payload = await response.json() as { workspaces: Array<{ id: string; permissions?: { canWrite?: boolean } }> };
    const workspace = payload.workspaces.find((item) => item.permissions?.canWrite);
    expect(workspace).toBeTruthy();
    const fixture = await installOutboxFixture(context, [draft('workspace-proposal', 'Workspace proposal', { workspaceId: workspace!.id, mailboxId: 'qa-mailbox', senderAddress: 'team@example.test' })]);
    const page = await context.newPage();
    try {
      await openDraft(page, 'workspace-proposal', workspace!.id);
      const dialog = page.getByTestId('email-review-host');
      await expect(dialog.getByText('team@example.test', { exact: true }).last()).toBeVisible();
      await dialog.getByTestId('email-review-send').click();
      await expect.poll(() => fixture.drafts.get('workspace-proposal')?.status).toBe('sent');
      expect(fixture.writes.find((write) => write.action === 'send')?.path).toBe(`/api/workspaces/${workspace!.id}/email/outbox/workspace-proposal/send`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await context.close(); }
  });

  test('uncertain delivery is read-only on mobile', async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const fixture = await installOutboxFixture(context, [draft('uncertain', 'Uncertain proposal', { status: 'send_uncertain', errorCode: 'SEND_UNCERTAIN', errorMessage: 'Delivery could not be confirmed. Check Sent mail before taking further action.', failedAt: new Date().toISOString() })]);
    const page = await context.newPage();
    try {
      await openDraft(page, 'uncertain');
      const dialog = page.getByTestId('email-review-host');
      await expect(dialog.getByText(/Delivery could not be confirmed/)).toBeVisible();
      await expect(dialog.getByTestId('email-review-subject')).toBeDisabled();
      await expect(dialog.getByTestId('email-review-send')).toBeDisabled();
      await expect(dialog.getByTestId('email-review-reject')).toBeDisabled();
      const bounds = await dialog.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath('email-review-mobile-uncertain.png') });
      expect(fixture.writes).toEqual([]);
    } finally { await context.close(); }
  });
});
