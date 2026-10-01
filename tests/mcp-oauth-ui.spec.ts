import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { startMcpOAuthProvider } from './fixtures/mcp-oauth-provider.mjs';

const EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const enabled = process.env.E2E_MCP_OAUTH === '1' && process.env.E2E_EXTERNAL_SERVER === '1' && Boolean(EMAIL && PASSWORD);

type Provider = Awaited<ReturnType<typeof startMcpOAuthProvider>>;
type OAuthStart = { authorizationUrl: string; state: string; expiresAt?: string };

async function login(page: Page) {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /email/i }).fill(EMAIL!);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD!);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes('/login'), { waitUntil: 'domcontentloaded' }),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function statusAction(page: Page, server: string, action: string, desktop?: boolean) {
  return page.request.post('/api/integrations/mcp-status', {
    headers: { Origin: BASE_URL },
    data: { action, server, ...(desktop === undefined ? {} : { desktop }) },
  });
}

async function beginDesktop(page: Page, server: string): Promise<OAuthStart> {
  const response = await statusAction(page, server, 'authorize', true);
  expect(response.status(), 'Desktop sign-in must start with a valid authenticated owner.').toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  expect(payload.data.state).toMatch(/^desktop_[A-Za-z0-9_-]{32}$/u);
  return payload.data as OAuthStart;
}

async function desktopStatus(page: Page, state: string) {
  const response = await page.request.get(`/api/mcp/oauth/desktop?state=${encodeURIComponent(state)}`);
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  return payload.data;
}

async function desktopAction(page: Page, state: string, action: 'finalize' | 'cancel') {
  const response = await page.request.post('/api/mcp/oauth/desktop', {
    headers: { Origin: BASE_URL }, data: { state, action },
  });
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  return payload.data;
}

async function isAuthorized(page: Page, server: string): Promise<boolean> {
  const response = await page.request.get('/api/integrations/mcp-status');
  expect(response.status()).toBe(200);
  const payload = await response.json();
  return payload.data.oauth.find((entry: { serverName: string }) => entry.serverName === server)?.authorized === true;
}

function connectionRow(page: Page, displayName: string) {
  return page.locator('[data-mcp-connection-id]').filter({ has: page.getByText(displayName, { exact: true }) });
}

async function openMcpSettings(page: Page, displayName: string) {
  await page.goto('/en/settings?tab=mcp&section=mcpConfig', { waitUntil: 'domcontentloaded' });
  const row = connectionRow(page, displayName);
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: `More actions for ${displayName}`, exact: true })).toBeEnabled();
  return row;
}

async function expectSimpleMcpSettings(page: Page) {
  const card = page.locator('#onboarding-settings-mcp-config');
  await expect(card).not.toContainText(/mcp\.json|File:|Format:|Permissions:|OAuth redirect URI|Cached tools|Connection diagnostics/u);
  await expect(page.getByTestId('mcp-developer-options')).toHaveCount(0);
  await expect(page.getByTestId('mcp-raw-editor')).toHaveCount(0);
  await expect(card.locator('.cm-editor')).toHaveCount(0);
}

test.describe('External MCP OAuth through the browser and desktop callback', () => {
  test.skip(!enabled, 'Enable E2E_MCP_OAUTH=1 against the single managed external server with bootstrap credentials.');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let provider: Provider;
  let serverName: string;
  let originalRawContent: string | undefined;
  let originalDeveloperMode: boolean | undefined;
  let externalContext: BrowserContext | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    const preferences = await page.request.get('/api/user-preferences');
    expect(preferences.status()).toBe(200);
    originalDeveloperMode = (await preferences.json()).data.developerMode === true;
    const simpleMode = await page.request.patch('/api/user-preferences', {
      headers: { Origin: BASE_URL }, data: { developerMode: false },
    });
    expect(simpleMode.status()).toBe(200);
    provider = await startMcpOAuthProvider({ allowedRedirectOrigins: [BASE_URL] });
    serverName = `oauth-ui-${randomUUID()}`;
    const before = await page.request.get('/api/integrations/mcp-config');
    expect(before.status()).toBe(200);
    const state = (await before.json()).data;
    originalRawContent = state.rawContent;
    const config = JSON.parse(state.rawContent);
    config.mcpServers[serverName] = { url: provider.url, auth: 'oauth', transport: 'http', enabled: true };
    const saved = await page.request.put('/api/integrations/mcp-config', {
      headers: { Origin: BASE_URL }, data: { rawContent: JSON.stringify(config, null, 2) },
    });
    expect(saved.status(), 'The fixture must preserve all existing personal MCP configuration.').toBe(200);
  });

  test.afterEach(async ({ page }) => {
    try {
      if (originalRawContent !== undefined) {
        // Clear only this fixture connection, then put back the exact config
        // snapshot. Existing connections and secret references are untouched.
        await statusAction(page, serverName, 'clear_auth');
        const restored = await page.request.put('/api/integrations/mcp-config', {
          headers: { Origin: BASE_URL }, data: { rawContent: originalRawContent },
        });
        expect(restored.status(), 'The pre-test MCP configuration must be restored.').toBe(200);
      }
    } finally {
      originalRawContent = undefined;
      try {
        if (originalDeveloperMode !== undefined) {
          const restored = await page.request.patch('/api/user-preferences', {
            headers: { Origin: BASE_URL }, data: { developerMode: originalDeveloperMode },
          });
          expect(restored.status(), 'The pre-test developer preference must be restored.').toBe(200);
        }
      } finally {
        originalDeveloperMode = undefined;
        await externalContext?.close();
        externalContext = undefined;
        await provider?.close();
      }
    }
  });

  test('authorizes from the settings UI and checks the real protected MCP tool', async ({ page }) => {
    const row = await openMcpSettings(page, serverName);
    await expectSimpleMcpSettings(page);
    const connect = row.getByRole('button', { name: 'Connect account', exact: true });
    await expect(connect).toBeEnabled();
    const [consentPage] = await Promise.all([page.waitForEvent('popup'), connect.click()]);
    await expect(consentPage.getByRole('heading', { name: 'Connect Canvas Notebook' })).toBeVisible();
    await consentPage.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => provider.stats.tokenExchanges, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => isAuthorized(page, serverName), { timeout: 30_000 }).toBe(true);
    await expect(connect).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled();
    await row.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect.poll(() => provider.stats.toolsLists, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(provider.stats.mcpInitializations).toBeGreaterThan(0);
    expect(provider.stats.failedTokenExchanges).toBe(0);
    await row.getByRole('button', { name: `More actions for ${serverName}`, exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Reconnect account', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Edit server', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expectSimpleMcpSettings(page);
    if (!consentPage.isClosed()) await consentPage.close();
  });

  test('edits a connection in simple mode while preserving unknown fields, identity and secret references', async ({ page }) => {
    const response = await page.request.get('/api/integrations/mcp-config');
    expect(response.status()).toBe(200);
    const config = JSON.parse((await response.json()).data.rawContent);
    const referenceKey = `MCP_E2E_REFERENCE_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    config.mcpServers[serverName] = {
      ...config.mcpServers[serverName],
      timeoutMs: 18000,
      fixtureExtension: { nested: { enabled: true }, labels: ['retained', 'unknown'] },
      headers: { 'X-Optional-Secret': `\${${referenceKey}}` },
      headersFromEnv: { 'X-Optional-Header': referenceKey },
      bearerTokenEnv: referenceKey,
      oauth: { issuer: provider.issuer, scopes: ['tools:read'], fixtureExtension: 'retain-oauth-field' },
    };
    const seeded = await page.request.put('/api/integrations/mcp-config', {
      headers: { Origin: BASE_URL }, data: { rawContent: JSON.stringify(config, null, 2) },
    });
    expect(seeded.status()).toBe(200);
    const before = JSON.parse((await seeded.json()).data.rawContent).mcpServers[serverName];
    const originalName = serverName;
    const row = await openMcpSettings(page, originalName);
    await expectSimpleMcpSettings(page);
    await row.getByRole('button', { name: `More actions for ${originalName}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit server', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit server', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Server address', { exact: true })).toHaveValue(provider.url);
    await expect(dialog.getByRole('tab', { name: 'Sign in with OAuth', exact: true })).toHaveAttribute('data-state', 'active');
    await expect(dialog.getByRole('button', { name: 'Developer options', exact: true })).toHaveCount(0);
    await expect(dialog.locator('#mcp-command, #mcp-bearer-env, #mcp-oauth-issuer')).toHaveCount(0);
    serverName = `${originalName}-edited`;
    await dialog.getByLabel('Name', { exact: true }).fill(serverName);
    const saved = page.waitForResponse((entry) => entry.url().endsWith('/api/integrations/mcp-config') && entry.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    const afterResponse = await page.request.get('/api/integrations/mcp-config');
    expect(afterResponse.status()).toBe(200);
    const after = JSON.parse((await afterResponse.json()).data.rawContent);
    expect(after.mcpServers[originalName]).toBeUndefined();
    // A normal name edit changes the config entry key. Every untouched option,
    // including the hydrated identity and central secret references, survives.
    expect(after.mcpServers[serverName]).toEqual(before);
    await expectSimpleMcpSettings(page);
  });

  test('persists developer mode and mounts raw configuration only after both explicit disclosures', async ({ page }) => {
    await openMcpSettings(page, serverName);
    await expectSimpleMcpSettings(page);
    await page.goto('/en/settings?tab=general');
    const developerSwitch = page.getByTestId('developer-mode-switch');
    await expect(developerSwitch).not.toBeChecked();
    await expect(developerSwitch).toBeEnabled();
    const enabledPreference = page.waitForResponse((entry) => entry.url().endsWith('/api/user-preferences') && entry.request().method() === 'PATCH');
    await developerSwitch.click();
    expect((await enabledPreference).status()).toBe(200);
    await expect(developerSwitch).toBeChecked();
    await page.reload();
    await expect(developerSwitch).toBeChecked();

    await openMcpSettings(page, serverName);
    const developerOptions = page.getByTestId('mcp-developer-options');
    await expect(developerOptions).toBeVisible();
    await expect(developerOptions).toHaveJSProperty('open', false);
    await expect(page.getByTestId('mcp-raw-editor')).toHaveCount(0);
    await expect(page.locator('#onboarding-settings-mcp-config .cm-editor')).toHaveCount(0);
    await developerOptions.locator('summary').first().click();
    await expect(developerOptions).toHaveJSProperty('open', true);
    await expect(developerOptions).toContainText('mcp.json');
    await expect(developerOptions).toContainText('JSON');
    await expect(developerOptions).toContainText('0600');
    const rawEditor = page.getByTestId('mcp-raw-editor');
    await expect(rawEditor).toBeVisible();
    await expect(rawEditor).toHaveJSProperty('open', false);
    await expect(rawEditor.locator('.cm-editor')).toHaveCount(0);
    await rawEditor.locator('summary').click();
    await expect(rawEditor.locator('.cm-editor')).toBeVisible({ timeout: 30_000 });
    await expect(rawEditor).toHaveJSProperty('open', true);
    await rawEditor.locator('summary').click();
    await expect(rawEditor.locator('.cm-editor')).toHaveCount(0);

    // Reloading keeps the preference but resets both disclosures to closed.
    await page.reload();
    await expect(connectionRow(page, serverName)).toBeVisible();
    await expect(developerOptions).toHaveJSProperty('open', false);
    await expect(page.getByTestId('mcp-raw-editor')).toHaveCount(0);
    await page.goto('/en/settings?tab=general');
    await expect(developerSwitch).toBeChecked();
    const disabledPreference = page.waitForResponse((entry) => entry.url().endsWith('/api/user-preferences') && entry.request().method() === 'PATCH');
    await developerSwitch.click();
    expect((await disabledPreference).status()).toBe(200);
    await expect(developerSwitch).not.toBeChecked();
    await page.reload();
    await expect(developerSwitch).not.toBeChecked();
    await openMcpSettings(page, serverName);
    await expectSimpleMcpSettings(page);
  });

  test('keeps primary actions and the normal edit dialog usable in a narrow window', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const row = await openMcpSettings(page, serverName);
    await expectSimpleMcpSettings(page);
    await expect(row.getByRole('button', { name: 'Connect account', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await row.getByRole('button', { name: `More actions for ${serverName}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit server', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Server address', { exact: true })).toHaveValue(provider.url);
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mcp-simple-edit-narrow.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('receives a desktop callback without Canvas cookies and saves credentials only after authenticated finalization', async ({ page, browser }) => {
    const started = await beginDesktop(page, serverName);
    expect((await desktopStatus(page, started.state)).status).toBe('waiting');
    externalContext = await browser.newContext();
    expect(await externalContext.cookies(BASE_URL)).toHaveLength(0);
    const externalPage = await externalContext.newPage();
    await externalPage.goto(started.authorizationUrl);
    await externalPage.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(externalPage.getByRole('heading', { name: 'Return to Canvas Notebook' })).toBeVisible();
    expect((await desktopStatus(page, started.state)).status).toBe('callback_received');
    expect(provider.stats.tokenExchanges).toBe(0);
    expect(await isAuthorized(page, serverName)).toBe(false);

    const unauthenticatedStatus = await externalContext.request.get(`${BASE_URL}/api/mcp/oauth/desktop?state=${encodeURIComponent(started.state)}`);
    expect(unauthenticatedStatus.status()).toBe(401);
    const unauthenticatedFinalize = await externalContext.request.post(`${BASE_URL}/api/mcp/oauth/desktop`, {
      headers: { Origin: BASE_URL }, data: { state: started.state, action: 'finalize' },
    });
    expect(unauthenticatedFinalize.status()).toBe(401);
    expect(provider.stats.tokenExchanges).toBe(0);

    expect((await desktopAction(page, started.state, 'finalize')).status).toBe('completed');
    expect(await isAuthorized(page, serverName)).toBe(true);
    expect(provider.stats.tokenExchanges).toBe(1);
    // Authenticated retries are idempotent; the public callback is single-use.
    expect((await desktopAction(page, started.state, 'finalize')).status).toBe('completed');
    expect(provider.stats.tokenExchanges).toBe(1);
    const replay = await externalPage.goto(externalPage.url());
    expect(replay?.status()).toBe(409);
    expect(provider.stats.tokenExchanges).toBe(1);
    const tested = await statusAction(page, serverName, 'test');
    expect(tested.status()).toBe(200);
    expect((await tested.json()).data.toolCount).toBe(1);
  });

  test('reports denied desktop consent as cancelled without exchanging or saving a token', async ({ page, browser }) => {
    const started = await beginDesktop(page, serverName);
    externalContext = await browser.newContext();
    const externalPage = await externalContext.newPage();
    await externalPage.goto(started.authorizationUrl);
    await externalPage.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(externalPage.getByRole('heading', { name: 'Sign-in cancelled' })).toBeVisible();
    expect((await desktopStatus(page, started.state)).status).toBe('cancelled');
    expect((await desktopAction(page, started.state, 'finalize')).status).toBe('cancelled');
    expect(provider.stats.denials).toBe(1);
    expect(provider.stats.tokenExchanges).toBe(0);
    expect(await isAuthorized(page, serverName)).toBe(false);
  });

  test('rejects a late provider callback after the owner cancels desktop sign-in', async ({ page, browser }) => {
    const started = await beginDesktop(page, serverName);
    externalContext = await browser.newContext();
    const externalPage = await externalContext.newPage();
    await externalPage.goto(started.authorizationUrl);
    await expect(externalPage.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    expect((await desktopAction(page, started.state, 'cancel')).status).toBe('cancelled');
    const callback = externalPage.waitForResponse((response) => response.url().startsWith(`${BASE_URL}/api/mcp/oauth/callback`));
    await externalPage.getByRole('button', { name: 'Approve', exact: true }).click();
    expect((await callback).status()).toBe(409);
    await expect(externalPage.getByRole('heading', { name: 'MCP OAuth failed' })).toBeVisible();
    expect((await desktopStatus(page, started.state)).status).toBe('cancelled');
    expect((await desktopAction(page, started.state, 'finalize')).status).toBe('cancelled');
    expect(provider.stats.tokenExchanges).toBe(0);
    expect(await isAuthorized(page, serverName)).toBe(false);
  });
});
