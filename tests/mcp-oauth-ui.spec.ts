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

test.describe('External MCP OAuth through the browser and desktop callback', () => {
  test.skip(!enabled, 'Enable E2E_MCP_OAUTH=1 against the single managed external server with bootstrap credentials.');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let provider: Provider;
  let serverName: string;
  let originalRawContent: string | undefined;
  let externalContext: BrowserContext | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
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
      await externalContext?.close();
      externalContext = undefined;
      await provider?.close();
    }
  });

  test('authorizes from the settings UI and checks the real protected MCP tool', async ({ page }) => {
    await page.goto('/en/settings?tab=mcp&section=mcpConfig', { waitUntil: 'domcontentloaded' });
    const row = page.locator('[data-mcp-connection-id]').filter({ has: page.getByText(serverName, { exact: true }) });
    await expect(row).toBeVisible();
    const connect = row.getByRole('button', { name: /^(Authorize|Connect|Sign in)$/i });
    await expect(connect).toBeEnabled();
    const [consentPage] = await Promise.all([page.waitForEvent('popup'), connect.click()]);
    await expect(consentPage.getByRole('heading', { name: 'Connect Canvas Notebook' })).toBeVisible();
    await consentPage.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => provider.stats.tokenExchanges, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => isAuthorized(page, serverName), { timeout: 30_000 }).toBe(true);
    await expect(row.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled();
    await row.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect.poll(() => provider.stats.toolsLists, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(provider.stats.mcpInitializations).toBeGreaterThan(0);
    expect(provider.stats.failedTokenExchanges).toBe(0);
    if (!consentPage.isClosed()) await consentPage.close();
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
