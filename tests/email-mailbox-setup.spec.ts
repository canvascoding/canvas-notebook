import { expect, test, type BrowserContext } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';

function mailbox(id: string, shared = false, writable = true) {
  return {
    id, provider: 'smtp_imap', authType: 'smtp_imap', emailAddress: `${id}@example.test`, displayName: id,
    isPrimary: !shared, status: 'active', imapHost: 'imap.example.test', connectionState: 'ready',
    policy: { readFrom: ['*'], sendTo: ['allowed@example.test'] }, accountScope: shared ? 'workspace' : 'personal',
    mailboxId: shared ? `mailbox-${id}` : null, workspaceId: shared ? 'mail-team' : null, workspaceName: shared ? 'Customer Support' : null,
    capabilities: { canRead: true, canWrite: writable, canManage: false, canDelete: writable, canRunAgent: writable },
  };
}
type Mailbox = ReturnType<typeof mailbox>;
async function installFixture(context: BrowserContext, initialAccounts: Mailbox[]) {
  const state = { accounts: initialAccounts, failLoad: false, setup: { canManageBusiness: false, manageableWorkspaces: [] as Array<{ id: string; name: string }> }, requests: [] as Array<{ path: string; workspace: unknown; body: Record<string, unknown> }>, writes: [] as string[] };
  await context.route('**/api/user-hints**', route => route.fulfill({ json: { page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [] } }));
  await context.route('https://api.github.com/repos/canvascoding/canvas-notebook/releases/latest', route => route.fulfill({ json: { tag_name: '0.0.0', body: '', html_url: 'https://github.com/canvascoding/canvas-notebook/releases' } }));
  await context.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    if (path.startsWith('/api/user-hints')) return route.fulfill({ json: { page: 'emails', version: 1, completed: true, currentHintKey: null, hints: [] } });
    if (!path.includes('/email/') && path !== '/api/email/mailboxes') return route.continue();
    const body = req.method() === 'POST' || req.method() === 'PATCH' ? (req.postDataJSON() || {}) as Record<string, unknown> : {};
    state.requests.push({ path, workspace: body.mailboxWorkspaceId ?? url.searchParams.get('mailboxWorkspaceId'), body });
    if (path === '/api/email/mailboxes') return route.fulfill({ status: state.failLoad ? 503 : 200, json: state.failLoad ? { success: false, error: 'Fixture mailbox connection unavailable' } : { success: true, data: { accounts: state.accounts, setup: state.setup } } });
    if (path === '/api/email/accounts') return route.fulfill({ json: { success: true, data: { mode: 'local', accounts: state.accounts.filter(a => a.accountScope === 'personal') } } });
    if (path.endsWith('/outbox')) return route.fulfill({ json: { success: true, data: [] } });
    if (path === '/api/email/oauth/status') return route.fulfill({ json: { success: true, data: { mode: 'local', providers: { google: { configured: false }, microsoft: { configured: false } } } } });
    if (path === '/api/email/folders') return route.fulfill({ json: { success: true, data: { folders: [{ id: 'INBOX', path: 'INBOX', name: 'Inbox', role: 'inbox', messageCount: 1, unseenCount: 0 }] } } });
    if (path === '/api/email/messages/list') return route.fulfill({ json: { success: true, data: { messages: [{ id: 'message', folder: 'INBOX', from: 'customer@example.test', subject: `Mail for ${body.accountId}`, snippet: 'Mailbox content', date: '2026-09-22', isRead: true }], total: 1, hasMore: false } } });
    if (/\/messages\/message$/.test(path)) return route.fulfill({ json: { success: true, data: { message: { id: 'message', folder: 'INBOX', from: 'customer@example.test', to: ['support@example.test'], subject: 'Customer request', body: 'Shared mailbox body', bodyHtml: '<p>Shared mailbox body</p>', isRead: true, attachments: [{ id: 'file', filename: 'note.txt', contentType: 'text/plain', size: 7, downloadable: true }] } } } });
    if (path.endsWith('/attachments/file')) return route.fulfill({ body: 'fixture', headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="note.txt"' } });
    if (!['GET', 'HEAD'].includes(req.method())) state.writes.push(path);
    return route.fulfill({ status: 403, json: { success: false, error: 'Unconfigured email action blocked by fixture' } });
  });
  return state;
}

test.describe('Central email mailboxes', () => {
  test.setTimeout(120_000);
  test('opens a workspace-only mailbox and keeps source scope on search, reading and attachments', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 900 } });
    const fixture = await installFixture(context, [mailbox('support', true)]);
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('email-mailbox-scope')).toContainText('Customer Support');
      await expect(page.getByTestId('email-search-input')).toBeVisible();
      await expect.poll(() => fixture.requests.some(r => r.path === '/api/email/folders' && r.workspace === 'mail-team')).toBe(true);
      await page.getByTestId('email-search-input').fill('customer OR request');
      await page.getByTestId('email-search-input').press('Enter');
      await expect.poll(() => fixture.requests.some(r => r.path.endsWith('/messages/list') && r.workspace === 'mail-team' && r.body.query === 'customer OR request')).toBe(true);
      await page.getByText('Mail for support', { exact: true }).first().click();
      await expect(page.frameLocator('iframe').getByText('Shared mailbox body')).toBeVisible();
      expect(fixture.requests.find(r => r.path.endsWith('/messages/message'))?.workspace).toBe('mail-team');
      await page.getByRole('button', { name: 'Attachment download options' }).click();
      const download = page.locator('a[href*="/attachments/file"]');
      await expect(download.first()).toHaveAttribute('href', /mailboxWorkspaceId=mail-team/);
      expect(fixture.writes).toEqual([]);
    } finally { await context.close(); }
  });

  test('groups personal and shared identities and restores a valid selection', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    await installFixture(context, [mailbox('personal'), mailbox('support', true)]);
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      const picker = page.locator('#email-account-header-switcher');
      await expect(picker.locator('optgroup')).toHaveCount(2);
      await picker.selectOption('support:mail-team');
      await expect(page.getByTestId('email-mailbox-scope')).toContainText('Customer Support');
      await page.reload();
      await expect(picker).toHaveValue('support:mail-team');
    } finally { await context.close(); }
  });

  test('read-only membership can browse but cannot compose', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const fixture = await installFixture(context, [mailbox('readonly', true, false)]);
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Mail for readonly', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Compose|Verfassen|Neue E-Mail)$/i })).toBeDisabled();
      expect(fixture.writes).toEqual([]);
    } finally { await context.close(); }
  });

  test('shared composer identifies its sender and blocks retry after an uncertain gateway response', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    await installFixture(context, [mailbox('support', true)]);
    const sends: Record<string, unknown>[] = [];
    await context.route('**/api/email/send', async route => {
      sends.push(route.request().postDataJSON());
      return route.fulfill({ status: 502, contentType: 'text/html', body: 'Gateway unavailable' });
    });
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^(Compose|Verfassen|Neue E-Mail)$/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('support@example.test', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Insert image', exact: true })).toBeDisabled();
      await expect(dialog.getByTestId('email-shared-inline-image-help')).toBeVisible();
      await page.locator('#email-compose-to').fill('allowed@example.test');
      await page.locator('#email-compose-to').press('Enter');
      await page.locator('#email-compose-subject').fill('Preserve this message');
      await dialog.locator('[contenteditable="true"]').fill('Important body');
      const send = dialog.getByRole('button', { name: /^Send$/ });
      await send.click();
      await expect(send).toBeDisabled();
      await expect(dialog.locator('[contenteditable="true"]')).toContainText('Important body');
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ accountId: 'support', mailboxWorkspaceId: 'mail-team' });
    } finally { await context.close(); }
  });

  test('account load error remains actionable instead of looking like first setup', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const fixture = await installFixture(context, []); fixture.failLoad = true;
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Fixture mailbox connection unavailable', { exact: true })).toBeVisible();
      fixture.failLoad = false; fixture.accounts = [mailbox('support', true)];
      await page.getByRole('button', { name: /retry|erneut versuchen|wiederholen/i }).click();
      await expect(page.getByText('Mail for support', { exact: true }).first()).toBeVisible();
    } finally { await context.close(); }
  });

  test('empty setup is optional and explains personal and shared ownership before showing credentials', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 320, height: 740 } });
    await installFixture(context, []);
    const page = await context.newPage();
    try {
      await page.goto('/de/emails');
      await expect(page.getByTestId('email-setup-guide')).toBeVisible();
      await expect(page.getByTestId('email-setup-business')).toHaveCount(0);
      await expect(page.getByTestId('email-setup-later')).toHaveAttribute('href', '/de');
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.getByTestId('email-setup-personal').click();
      await expect(page.getByRole('button', { name: /SMTP\/IMAP/ })).toBeVisible();
    } finally { await context.close(); }
  });

  test('setup provides role-aware admin and workspace assignment links', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const fixture = await installFixture(context, []);
    fixture.setup = { canManageBusiness: true, manageableWorkspaces: [{ id: 'mail-team', name: 'Customer Support' }] };
    const page = await context.newPage();
    try {
      await page.goto('/emails');
      await expect(page.getByTestId('email-setup-business')).toHaveAttribute('href', /tab=system-email/);
      await expect(page.locator('a[href*="mailboxWorkspaceId=mail-team"]')).toHaveAttribute('href', /workspaceManagement=1/);
    } finally { await context.close(); }
  });

  for (const connectionState of ['reconnect_required', 'send_only', 'missing_credentials']) {
    test(`${connectionState} offers repair without querying unavailable inbox`, async ({ browser }) => {
      const context = await createAuthenticatedContext(browser);
      const account = mailbox('repair');
      account.connectionState = connectionState === 'missing_credentials' ? 'reconnect_required' : connectionState;
      account.capabilities.canRead = false;
      account.capabilities.canWrite = connectionState === 'send_only';
      account.status = connectionState === 'reconnect_required' ? 'expired' : 'active';
      account.imapHost = '';
      const fixture = await installFixture(context, [account]);
      const page = await context.newPage();
      try {
        await page.goto('/emails');
        await expect(page.getByTestId(connectionState === 'send_only' ? 'email-mailbox-send-only' : 'email-mailbox-repair')).toBeVisible();
        await page.getByTestId('email-setup-personal-repair').click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('button', { name: connectionState === 'send_only' ? 'Add IMAP' : 'Reconnect', exact: true })).toBeVisible();
        expect(fixture.requests.filter(r => r.path === '/api/email/folders' || r.path.endsWith('/messages/list'))).toEqual([]);
        expect(fixture.writes).toEqual([]);
      } finally { await context.close(); }
    });
  }
});

for (const width of [320, 390, 1024]) {
  test(`German mailbox identity and controls fit ${width}px`, async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width, height: 740 } });
    await installFixture(context, [mailbox('personal'), mailbox('support', true)]);
    const page = await context.newPage();
    try {
      await page.goto('/de/emails', { waitUntil: 'domcontentloaded' });
      await page.locator('#email-account-header-switcher').selectOption('support:mail-team');
      await expect(page.getByTestId('email-mailbox-scope')).toContainText('Customer Support');
      await expect(page.getByTestId('email-search-input')).toBeVisible();
      const geometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport + 1);
      const scope = await page.getByTestId('email-mailbox-scope').boundingBox();
      expect(scope).not.toBeNull();
      expect(scope!.x + scope!.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: testInfo.outputPath(`mailbox-${width}.png`), fullPage: true });
    } finally { await context.close(); }
  });
}

test('live local catalogue exposes the scoped contract without provider operations', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  try {
    const response = await context.request.get('/api/email/mailboxes');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data.accounts)).toBe(true);
    expect(typeof result.data.setup.canManageBusiness).toBe('boolean');
    for (const account of result.data.accounts) {
      expect(['personal', 'workspace']).toContain(account.accountScope);
      expect(['ready', 'send_only', 'reconnect_required']).toContain(account.connectionState);
      expect(account.secretRef).toBeUndefined();
      expect(account.password).toBeUndefined();
    }
  } finally { await context.close(); }
});

test('business connection makes sharing explicit and keeps save controls in the mobile viewport', async ({ browser }, testInfo) => {
  const context = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 740 } });
  await installFixture(context, []);
  const saves: Record<string, unknown>[] = [];
  await context.route('**/api/admin/workspace-email-mailboxes', async route => {
    if (route.request().method() !== 'GET') {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true, data: { workspaceId: 'mail-team' } } });
    }
    return route.fulfill({ json: { success: true, data: { mailboxes: [], workspaces: [{ id: 'mail-team', name: 'Customer Support' }] } } });
  });
  const page = await context.newPage();
  try {
    await page.goto('/de/settings?tab=system-email');
    await page.getByRole('button', { name: 'Postfach hinzufügen', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#business-mailbox-workspace').selectOption('mail-team');
    await expect(dialog.getByText(/Mitglieder dieses Workspaces erhalten Zugriff/)).toBeVisible();
    const save = dialog.getByRole('button', { name: 'Testen & speichern', exact: true });
    const bounds = await save.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(740);
    await page.screenshot({ path: testInfo.outputPath('business-setup-390.png'), fullPage: true });
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(saves[0]).toMatchObject({ workspaceId: 'mail-team', verifyConnection: true });
    await expect(page.getByRole('link', { name: 'E-Mail öffnen', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('workspace setup deep link opens the permitted assignment dialog', async ({ browser }) => {
  const context = await createAuthenticatedContext(browser);
  await installFixture(context, []);
  await context.route('**/api/workspaces', route => route.fulfill({ json: { success: true, activeWorkspaceId: 'mail-team', teamFeaturesEnabled: true, workspaces: [{ id: 'mail-team', name: 'Customer Support', type: 'team', status: 'active', permissions: { canRead: true, canWrite: true, canManageWorkspace: true } }] } }));
  await context.route('**/api/workspaces/mail-team/email/mailbox', route => route.fulfill({ json: { success: true, data: { mailboxes: [] } } }));
  const page = await context.newPage();
  try {
    await page.goto('/settings?tab=workspace&workspaceManagement=1&mailboxWorkspaceId=mail-team');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Customer Support');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally { await context.close(); }
});

for (const empty of [true, false]) {
  test(`email hint tour points to visible ${empty ? 'setup' : 'mailbox'} controls`, async ({ browser }) => {
    test.skip(process.env.ONBOARDING_HINTS !== 'true', 'Start the test server with ONBOARDING_HINTS=true to exercise the optional tour.');
    const context = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 740 } });
    await installFixture(context, empty ? [] : [mailbox('support', true)]);
    const hints = ['emails.mailbox', 'emails.setup', 'emails.review'];
    let index = 0;
    await context.route('**/api/user-hints**', async route => {
      if (route.request().method() === 'PATCH') {
        const dismissedHintKey = hints[index++];
        return route.fulfill({ json: { dismissedHintKey, nextHintKey: hints[index] || null, completed: index >= hints.length } });
      }
      return route.fulfill({ json: { page: 'emails', version: 1, completed: false, currentHintKey: hints[index], hints: hints.map(hintKey => ({ hintKey, dismissed: false, dismissedAt: null })) } });
    });
    const page = await context.newPage();
    try {
      await page.goto('/emails');
      for (const selector of empty ? ['#onboarding-email-setup', '#onboarding-email-setup-choices', '#onboarding-email-review'] : ['#onboarding-email-mailbox', '#onboarding-email-settings', '#onboarding-email-review']) {
        await expect(page.locator(selector)).toBeVisible();
        const previousIndex = index;
        const title = ['Personal or shared', 'Set up and repair connections', 'Review proposals before sending'][previousIndex];
        await page.getByRole('dialog', { name: title, exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        await expect.poll(() => index).toBe(previousIndex + 1);
      }
      expect(index).toBe(3);
    } finally { await context.close(); }
  });
}
