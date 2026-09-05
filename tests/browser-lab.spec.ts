import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

const labels = {
  address: /^(Adresse|Address)$/,
  back: /^(Zurück|Back)$/,
  backToChat: /^(Zurück zum Chat|Back to chat)$/,
  closeChat: /^(Chat schließen|Close chat)$/,
  closeTab: /^(Aktuellen Tab schließen|Close current tab)$/,
  connect: /^(Live-Ansicht starten|Start live view)$/,
  copySelection: /^(Aus Browser kopieren|Copy from browser)$/,
  disconnect: /^(Trennen|Disconnect)$/,
  disconnected: /^(Nicht verbunden|Disconnected)$/,
  dismissError: /^(Meldung schließen|Dismiss message)$/,
  failureTitle: /^(Die Live-Ansicht braucht Aufmerksamkeit|The live view needs attention)$/,
  interactionToggle: /^(Interagieren|Interact|Interaktion beenden|Stop interacting)$/,
  live: /^(Live verbunden|Live connected)$/,
  liveBrowser: /^(Live-Browser|Live Browser)$/,
  newTab: /^(Neuer Tab|New tab)$/,
  openChat: /^(Chat öffnen|Open chat)$/,
  openLiveBrowser: /^(Live-Browser öffnen|Open live browser)$/,
  navigate: /^(Öffnen|Open)$/,
  navigationBlocked: /(Diese Adresse wurde durch die Browser-Sicherheitsrichtlinie blockiert\.|This address was blocked by the browser security policy\.)/,
  pageCrashed: /(Die verwaltete Browserseite wurde unerwartet beendet\.|The managed browser page stopped unexpectedly\.)/,
  pasteClipboard: /^(In Browser einfügen|Paste into browser)$/,
  reload: /^(Neu laden|Reload)$/,
  resourceUnavailable: /(Auf diesem System stehen nicht genug Ressourcen für die Live-Ansicht bereit\.|This system does not have enough resources for the live view\.)/,
  retry: /^(Erneut versuchen|Try again)$/,
  session: /^(Chat-Session|Chat session)$/,
  stop: /^(Laden stoppen|Stop loading)$/,
  userControls: /^(Gemeinsam aktiv|Working together)$/,
};

type AgentSummary = {
  agentId: string;
};

type SessionSummary = {
  agentId: string;
  createdByTest?: boolean;
  engine?: string | null;
  sessionId: string;
  title?: string | null;
  workspace?: { workspaceId: string } | null;
};

type RuntimeCatalogProvider = {
  enabled: boolean;
  installationId: string;
  models: Array<{
    enabled: boolean;
    id: string;
    isProviderDefault: boolean;
    thinkingLevels: string[];
  }>;
  providerId: string;
  status: string;
};

let cachedAuthCookies: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> | null = null;

async function login(page: Page): Promise<void> {
  if (cachedAuthCookies) {
    await page.context().addCookies(cachedAuthCookies);
    await page.goto('/');
    return;
  }
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(TEST_EMAIL);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
  cachedAuthCookies = await page.context().cookies();
}

async function issueBrowserFixtureAccess(page: Page): Promise<string> {
  const response = await page.request.post('/api/browser/view/fixture-access');
  const payload = await response.json() as { data?: { access?: string } };
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data?.access).toBeTruthy();
  return payload.data!.access!;
}

async function findBrowserLabSession(page: Page): Promise<SessionSummary> {
  const [agentsResponse, sessionsResponse] = await Promise.all([
    page.request.get('/api/agents'),
    page.request.get('/api/sessions?agentId=all'),
  ]);

  expect(agentsResponse.ok(), await agentsResponse.text()).toBeTruthy();
  expect(sessionsResponse.ok(), await sessionsResponse.text()).toBeTruthy();

  const agentsPayload = await agentsResponse.json() as {
    data?: { agents?: AgentSummary[] };
  };
  const sessionsPayload = await sessionsResponse.json() as {
    sessions?: SessionSummary[];
  };
  const agentIds = new Set((agentsPayload.data?.agents ?? []).map((agent) => agent.agentId));
  const session = (sessionsPayload.sessions ?? []).find((candidate) => (
    candidate.engine !== 'legacy' && agentIds.has(candidate.agentId)
  ));

  if (session) {
    return {
      ...session,
      createdByTest: session.title?.startsWith('Browser Lab E2E ') ?? false,
    };
  }

  const agent = agentsPayload.data?.agents?.[0];
  expect(agent, 'Browser Lab E2E requires at least one accessible agent.').toBeTruthy();
  const catalogResponse = await page.request.get('/api/admin/agent-runtime/catalog');
  const catalogPayload = await catalogResponse.json().catch(() => ({})) as {
    code?: string;
    data?: {
      catalog?: {
        providers?: RuntimeCatalogProvider[];
        revision?: number;
      };
    };
    error?: string;
  };
  expect(
    catalogResponse.ok(),
    JSON.stringify({ code: catalogPayload.code, error: catalogPayload.error }),
  ).toBeTruthy();
  const provider = catalogPayload.data?.catalog?.providers?.find((candidate) => (
    candidate.enabled && candidate.status === 'ready' && candidate.models.some((model) => model.enabled)
  ));
  const model = provider?.models.find((candidate) => candidate.enabled && candidate.isProviderDefault)
    ?? provider?.models.find((candidate) => candidate.enabled);
  expect(provider && model, 'Browser Lab E2E requires one ready provider installation with an enabled model.').toBeTruthy();
  const catalogRevision = catalogPayload.data?.catalog?.revision;
  expect(Number.isSafeInteger(catalogRevision), 'The AI runtime catalog revision is missing.').toBeTruthy();
  const thinkingLevel = model!.thinkingLevels.includes('off') ? 'off' : model!.thinkingLevels[0];
  const createResponse = await page.request.post('/api/sessions', {
    data: {
      agentId: agent!.agentId,
      expectedCatalogRevision: catalogRevision,
      expectedPolicyRevision: 0,
      runtimeSelection: {
        providerInstallationId: provider!.installationId,
        providerId: provider!.providerId,
        modelId: model!.id,
        thinkingLevel,
      },
      title: `Browser Lab E2E ${Date.now()}`,
    },
  });
  const createPayload = await createResponse.json().catch(() => ({})) as {
    code?: string;
    error?: string;
    session?: SessionSummary;
  };
  expect(
    createResponse.ok(),
    JSON.stringify({ code: createPayload.code, error: createPayload.error }),
  ).toBeTruthy();
  expect(createPayload.session?.sessionId, 'The Browser Lab E2E session was not created.').toBeTruthy();
  return {
    agentId: createPayload.session?.agentId || agent!.agentId,
    createdByTest: true,
    engine: createPayload.session?.engine || 'pi',
    sessionId: createPayload.session!.sessionId,
    workspace: createPayload.session?.workspace ?? null,
  };
}

async function deleteBrowserLabTestSession(page: Page, session: SessionSummary): Promise<void> {
  if (!session.createdByTest) return;
  await page.request.delete(
    `/api/sessions?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`,
  );
}

async function exposeBrowserRuntimeToNotebook(page: Page, sessionId: string): Promise<void> {
  await page.routeWebSocket('**/ws/chat', (ws: WebSocketRoute) => {
    ws.send(JSON.stringify({ type: 'auth_success', userId: 'browser-lab-test-user' }));
    ws.onMessage((rawMessage) => {
      const message = JSON.parse(
        typeof rawMessage === 'string' ? rawMessage : rawMessage.toString(),
      ) as { requestId?: string; sessionId?: string; type?: string };
      const activeSessionId = message.sessionId || sessionId;
      if (message.type === 'subscribe_session') {
        ws.send(JSON.stringify({
          type: 'subscribe_result',
          requestId: message.requestId,
          success: true,
          sessionId: activeSessionId,
        }));
        return;
      }
      if (message.type !== 'get_status') return;
      ws.send(JSON.stringify({
        type: 'status_result',
        requestId: message.requestId,
        success: true,
        status: {
          sessionId: activeSessionId,
          phase: 'idle',
          activeTool: null,
          pendingToolCalls: 0,
          followUpQueue: [],
          steeringQueue: [],
          canAbort: false,
          contextWindow: 128000,
          estimatedHistoryTokens: 0,
          availableHistoryTokens: 128000,
          contextUsagePercent: 0,
          includedSummary: false,
          omittedMessageCount: 0,
          summaryUpdatedAt: null,
          lastCompactionAt: null,
          lastCompactionKind: null,
          lastCompactionOmittedCount: 0,
          browser: {
            revision: 1,
            running: true,
            controlMode: 'agent',
            interactionPolicy: 'cooperative',
            interactionRevision: 0,
            lastUserInteractionAt: null,
            activeTabId: 'browser-lab-tab',
            activeTitle: 'Browser Lab',
            activeUrl: 'about:blank',
            tabCount: 1,
            tabs: [{
              id: 'browser-lab-tab',
              title: 'Browser Lab',
              url: 'about:blank',
              active: true,
            }],
            hasPendingDialog: false,
          },
        },
      }));
    });
  });
}

test.describe('Browser Lab', () => {
  test.setTimeout(180_000);

  test('requires an authenticated user', async ({ page }) => {
    await page.goto('/browser/live?agentId=canvas-agent&sessionId=unavailable');
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/, { timeout: 15_000 });

    await page.goto('/browser/lab');
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/, { timeout: 15_000 });

    const [ticket, files, fixtureAccess, fixturePage, fixtureDownload] = await Promise.all([
      page.request.post('/api/browser/view', { data: {} }),
      page.request.get('/api/browser/view/files'),
      page.request.post('/api/browser/view/fixture-access'),
      page.request.get('/api/browser/view/fixture-page'),
      page.request.get('/api/browser/view/fixture-download'),
    ]);
    expect(ticket.status()).toBe(401);
    expect(files.status()).toBe(401);
    expect(fixtureAccess.status()).toBe(401);
    expect(fixturePage.status()).toBe(404);
    expect(fixtureDownload.status()).toBe(404);
  });

  test('shows the Browser Lab shell to the bootstrap admin', async ({ page }) => {
    await login(page);
    await page.goto('/browser/lab');
    await expect(page.getByRole('heading', { name: 'Browser Lab', level: 2 })).toBeVisible();
    await expect(page.getByText(/^(Entwicklungswerkzeug|Development tool)$/)).toBeVisible();
  });

  test('opens Browser Lab from More Tools on the admin home page', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto('/');

    const moreToolsButton = page.getByRole('button', { name: /More Tools|Weitere Tools/i });
    await expect(moreToolsButton).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browser Lab' })).toHaveCount(0);
    await moreToolsButton.click();

    const browserLabLink = page.getByRole('link', { name: 'Browser Lab' });
    await expect(browserLabLink).toBeVisible();
    await expect(browserLabLink).toHaveAttribute('href', /\/browser\/lab$/);
    await page.screenshot({
      path: 'test-results/home-browser-lab-card.png',
      fullPage: false,
    });
    await browserLabLink.click();

    await expect(page).toHaveURL(/\/browser\/lab$/);
    await expect(page.getByRole('heading', { name: 'Browser Lab', level: 2 })).toBeVisible();
  });

  test('shows a recoverable connection failure and retries the live view', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page);
    const session = await findBrowserLabSession(page);
    try {
      await page.route('**/api/browser/view', async (route) => {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            code: 'RESOURCE_UNAVAILABLE',
            error: 'Internal resource detail that must not be displayed.',
            retryable: true,
            fatal: true,
          }),
        });
      }, { times: 1 });
      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);

      const connectButton = page.getByRole('button', { name: labels.connect });
      await expect(connectButton).toBeEnabled({ timeout: 15_000 });
      await connectButton.click();
      await expect(page.getByText(labels.failureTitle)).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: labels.resourceUnavailable })).toBeVisible();
      await expect(page.getByText('Internal resource detail that must not be displayed.')).toHaveCount(0);
      await page.screenshot({ path: 'test-results/browser-lab-recoverable-error.png', fullPage: false });

      const failureTitle = page.getByText(labels.failureTitle);
      const liveStatus = page.getByText(labels.live);
      await page.getByRole('button', { name: labels.retry }).click();
      await expect(failureTitle).toBeHidden();
      await expect(liveStatus.or(failureTitle)).toBeVisible({ timeout: 60_000 });
      if (await failureTitle.isVisible()) {
        await expect(page.getByRole('alert').filter({ hasText: labels.pageCrashed })).toBeVisible();
        await page.getByRole('button', { name: labels.retry }).click();
      }
      await expect(liveStatus).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('img[tabindex]')).toBeVisible({ timeout: 30_000 });
      await page.getByTitle(labels.disconnect).click();
    } finally {
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('handles fatal browser errors without an invalid WebSocket close code', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await login(page);
    const session = await findBrowserLabSession(page);
    try {
      await page.route('**/api/browser/view', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              ticket: 'fatal-error-regression-ticket',
              viewId: 'fatal-error-regression-view',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              websocketUrl: '/ws/browser',
            },
          }),
        });
      }, { times: 1 });
      await page.routeWebSocket('**/ws/browser', (ws: WebSocketRoute) => {
        ws.send(JSON.stringify({ type: 'auth_success' }));
        ws.onMessage((rawMessage) => {
          const message = JSON.parse(String(rawMessage)) as { type?: string };
          if (message.type !== 'view_subscribe') return;
          ws.send(JSON.stringify({
            type: 'error',
            code: 'RESOURCE_UNAVAILABLE',
            error: 'Internal resource detail that must not be displayed.',
            retryable: false,
            fatal: true,
          }));
        });
      });

      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);
      const connectButton = page.getByRole('button', { name: labels.connect });
      await expect(connectButton).toBeEnabled({ timeout: 15_000 });
      await connectButton.click();
      await expect(page.getByText(labels.failureTitle)).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: labels.resourceUnavailable })).toBeVisible();
      await expect(page.getByText('Internal resource detail that must not be displayed.')).toHaveCount(0);
      await page.waitForTimeout(100);

      expect(pageErrors.map((error) => error.message)).not.toContainEqual(
        expect.stringContaining("Failed to execute 'close' on 'WebSocket'"),
      );
    } finally {
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('connects to the managed browser with cooperative control enabled', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page);
    const fixtureAccess = await issueBrowserFixtureAccess(page);
    const fixtureUrl = `http://localhost:3000/api/browser/view/fixture-page?access=${encodeURIComponent(fixtureAccess)}`;
    const session = await findBrowserLabSession(page);
    try {
      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);

      await expect(page.getByRole('heading', { name: 'Browser Lab', level: 2 })).toBeVisible();
      const address = page.getByLabel(labels.address);
      const connectButton = page.getByRole('button', { name: labels.connect });
      await expect(connectButton).toBeEnabled({ timeout: 15_000 });
      await expect(page.getByTestId('chat-dock-desktop')).toHaveAttribute('data-chat-visible', 'true');
      await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', session.sessionId, { timeout: 30_000 });
      await expect(address).toBeDisabled();
      await expect(page.getByRole('button', { name: labels.interactionToggle })).toHaveCount(0);

      const cooperativeTicketRequest = page.waitForRequest((request) => (
        request.url().endsWith('/api/browser/view') && request.method() === 'POST'
      ));
      await connectButton.click();
      const ticketRequest = await cooperativeTicketRequest;
      expect(ticketRequest.postDataJSON()).toMatchObject({ interactionPolicy: 'cooperative' });
      await expect(page.getByText(labels.live)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('browser-lab-session-disclosure')).toBeVisible();
      await expect(page.getByTestId('browser-lab-session-setup')).toHaveCount(0);

      const frame = page.locator('img[tabindex]');
      await expect(frame).toBeVisible({ timeout: 30_000 });
      await expect(frame).toHaveAttribute('src', /^data:image\//);
      await expect(page.getByText(labels.userControls)).toBeVisible();
      await expect(address).toBeEnabled();
      await expect(page.getByRole('button', { name: labels.interactionToggle })).toHaveCount(0);
      await page.getByTestId('chat-dock-toggle').click();
      await expect(page.getByTestId('chat-dock-desktop')).toHaveAttribute('data-chat-visible', 'false');
      await page.getByRole('button', { name: labels.openChat }).click();
      await expect(page.getByTestId('chat-dock-desktop')).toHaveAttribute('data-chat-visible', 'true');

      await expect(page.getByRole('button', { name: labels.newTab })).toBeEnabled();
      await expect(page.getByRole('button', { name: labels.closeTab })).toBeEnabled();
      await expect(page.getByRole('button', { name: labels.reload })).toBeEnabled();
      await expect(page.getByRole('button', { name: labels.stop })).toBeEnabled();
      await expect(page.getByRole('button', { name: labels.copySelection })).toBeEnabled();
      await expect(page.getByRole('button', { name: labels.pasteClipboard })).toBeEnabled();

      await address.fill('youtube.com');
      await page.waitForTimeout(3_500);
      await expect(address).toHaveValue('youtube.com');

      await address.fill('http://169.254.169.254/latest/meta-data');
      await page.getByRole('button', { name: labels.navigate }).click();
      const navigationAlert = page.getByRole('alert').filter({ hasText: labels.navigationBlocked });
      await expect(navigationAlert).toBeVisible();
      await expect(page.getByText(labels.live)).toBeVisible();
      await expect(address).toBeEnabled();
      await page.screenshot({ path: 'test-results/browser-lab-navigation-blocked.png', fullPage: false });
      await page.getByRole('button', { name: labels.dismissError }).click();
      await expect(navigationAlert).toHaveCount(0);

      await address.fill('http://localhost:3000/api/health');
      await page.getByRole('button', { name: labels.navigate }).click();
      await expect(navigationAlert).toBeVisible();
      await page.getByRole('button', { name: labels.dismissError }).click();
      await expect(navigationAlert).toHaveCount(0);

      await address.fill('about:blank');
      await page.getByRole('button', { name: labels.navigate }).click();
      await expect(address).toHaveValue('about:blank', { timeout: 30_000 });

      await address.fill(fixtureUrl);
      await page.getByRole('button', { name: labels.navigate }).click();
      await expect(address).toHaveValue(/\/api\/browser\/view\/fixture-page\?access=/, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: labels.back })).toBeEnabled();
      await page.getByRole('button', { name: labels.back }).click();
      await expect(address).toHaveValue('about:blank', { timeout: 30_000 });
      await page.getByRole('button', { name: /^(Vor|Forward)$/ }).click();
      await expect(address).toHaveValue(/\/api\/browser\/view\/fixture-page\?access=/, { timeout: 30_000 });
      await page.getByRole('button', { name: labels.reload }).click();
      await expect(address).toHaveValue(/\/api\/browser\/view\/fixture-page\?access=/, { timeout: 30_000 });

      await expect(page.getByRole('button', { name: labels.interactionToggle })).toHaveCount(0);
      await expect(address).toBeEnabled();

      await page.screenshot({ path: 'test-results/browser-lab-desktop.png', fullPage: false });
      const desktopMetrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(desktopMetrics.scrollWidth).toBeLessThanOrEqual(desktopMetrics.innerWidth + 1);

      await page.getByTitle(labels.disconnect).click();
      await expect(page.getByText(labels.disconnected)).toBeVisible();
      await expect(frame).toHaveCount(0);

      await page.getByRole('button', { name: labels.connect }).click();
      await expect(page.getByText(labels.live)).toBeVisible({ timeout: 60_000 });
      await expect(address).toHaveValue(/\/api\/browser\/view\/fixture-page\?access=/);
      await page.getByTestId('chat-dock-toggle').click();
      await expect(page.getByTestId('chat-dock-desktop')).toHaveAttribute('data-chat-visible', 'false');

      await page.setViewportSize({ width: 390, height: 844 });
      const mobileChatSheet = page.getByTestId('chat-dock-mobile-sheet');
      const closeMobileChat = page.getByRole('button', { name: labels.closeChat });
      await expect(mobileChatSheet).toBeVisible();
      await closeMobileChat.click();
      await expect(mobileChatSheet).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Browser Lab', level: 2 })).toBeVisible();
      await expect(page.getByTestId('browser-lab-session-disclosure')).toBeVisible();
      await expect(page.getByRole('button', { name: labels.interactionToggle })).toHaveCount(0);
      await expect(address).toBeEnabled();
      const mobileTabSelect = page.getByTestId('browser-mobile-tab-select');
      await expect(mobileTabSelect).toBeEnabled();
      await page.getByRole('button', { name: labels.newTab }).click();
      await expect.poll(() => mobileTabSelect.locator('option').count()).toBeGreaterThan(1);
      const firstMobileTab = await mobileTabSelect.locator('option').first().getAttribute('value');
      expect(firstMobileTab).toBeTruthy();
      await mobileTabSelect.selectOption(firstMobileTab!);
      await expect(mobileTabSelect).toHaveValue(firstMobileTab!);
      await address.fill(fixtureUrl);
      await expect(address).toHaveValue(fixtureUrl);
      await address.press('Enter');
      await expect(address).toHaveValue(/\/api\/browser\/view\/fixture-page\?access=/, { timeout: 30_000 });
      await page.screenshot({ path: 'test-results/browser-lab-mobile.png', fullPage: false });
      const mobileMetrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        browserFrameHeight: document.querySelector<HTMLImageElement>('img[tabindex]')?.getBoundingClientRect().height ?? 0,
        visibleButtons: [...document.querySelectorAll('button')].filter((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.left < window.innerWidth;
        }).map((button) => {
          const bounds = button.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, text: button.textContent?.trim() || '' };
        }),
      }));
      expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.innerWidth + 1);
      expect(mobileMetrics.browserFrameHeight).toBeGreaterThanOrEqual(180);
      expect(mobileMetrics.visibleButtons.every((button) => button.left >= -1 && button.right <= mobileMetrics.innerWidth + 1)).toBeTruthy();

      await page.getByTitle(labels.disconnect).click();
      expect(pageErrors).toEqual([]);
    } finally {
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('opens the running browser beside its chat inside the notebook', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.setViewportSize({ width: 1440, height: 900 });
    await exposeBrowserRuntimeToNotebook(page, 'browser-lab-session');
    await login(page);
    const session = await findBrowserLabSession(page);
    try {
      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);
      await expect(page.getByRole('button', { name: labels.connect })).toBeEnabled({ timeout: 15_000 });
      await page.getByRole('button', { name: labels.connect }).click();
      await expect(page.getByText(labels.live)).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('img[tabindex]')).toBeVisible({ timeout: 30_000 });

      await page.goto(`/notebook?chat=open&session=${encodeURIComponent(session.sessionId)}`);
      await page.getByTestId('notebook-surface-chat').click();
      await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', session.sessionId, { timeout: 30_000 });

      const browserStatusResponse = await page.request.get(
        `/api/agents/browser?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`,
      );
      const browserStatus = await browserStatusResponse.json() as {
        success?: boolean;
        data?: { profile?: { sessionRunning?: boolean } };
        error?: string;
      };
      expect(browserStatusResponse.ok(), JSON.stringify(browserStatus)).toBeTruthy();
      expect(browserStatus.data?.profile?.sessionRunning, JSON.stringify(browserStatus)).toBeTruthy();

      await expect(page.getByTestId('notebook-surface-browser')).toHaveAttribute(
        'aria-selected',
        'false',
        { timeout: 30_000 },
      );
      await expect(page.getByTestId('notebook-desktop-chat')).toHaveAttribute('data-chat-placement', 'main');
      await page.getByTestId('notebook-surface-chat').click();
      await expect(page.getByTestId('notebook-desktop-chat')).toHaveAttribute('aria-hidden', 'false');
      const liveBrowserLink = page.getByTestId('chat-live-browser-link');
      await expect(liveBrowserLink).toBeVisible({ timeout: 30_000 });
      await expect(liveBrowserLink).toHaveAttribute(
        'aria-label',
        /^(Live-Browser öffnen|Open live browser)(?::|$)/,
      );
      const notebookUrl = page.url();
      await liveBrowserLink.click();

      await expect(page).toHaveURL(notebookUrl);
      await expect(page.getByTestId('notebook-surface-browser')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('notebook-desktop-browser')).toHaveAttribute('aria-hidden', 'false');
      await expect(page.getByTestId('notebook-desktop-chat')).toHaveAttribute('data-chat-placement', 'side');
      await expect(page.getByRole('combobox')).toHaveCount(0);
      await expect(page.getByText(/^(Diagnose|Diagnostics)$/)).toHaveCount(0);
      await expect(page.getByText(session.sessionId, { exact: true })).toHaveCount(0);
      await expect(page.locator('img[tabindex]')).toBeVisible({ timeout: 30_000 });
      const activityToggle = page.getByTestId('browser-agent-activity-toggle');
      await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');
      await activityToggle.click();
      await expect(page.getByTestId('notebook-desktop-chat')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator('img[tabindex]')).toBeVisible();
      await activityToggle.click();
      await expect(page.getByTestId('notebook-desktop-chat')).toHaveAttribute('aria-hidden', 'false');
      await page.screenshot({ path: 'test-results/notebook-browser-beside-chat.png', fullPage: false });

      const desktopMetrics = await page.evaluate(() => {
        const browser = document.querySelector<HTMLElement>('[data-testid="notebook-desktop-browser"]')
          ?.getBoundingClientRect();
        const chat = document.querySelector<HTMLElement>('[data-testid="notebook-desktop-chat"]')
          ?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          browser: browser ? { left: browser.left, right: browser.right, width: browser.width } : null,
          chat: chat ? { left: chat.left, right: chat.right, width: chat.width } : null,
        };
      });
      expect(desktopMetrics.scrollWidth).toBeLessThanOrEqual(desktopMetrics.innerWidth + 1);
      expect(desktopMetrics.browser?.width ?? 0).toBeGreaterThan(240);
      expect(desktopMetrics.chat?.width ?? 0).toBeGreaterThan(240);
      expect(desktopMetrics.chat!.left).toBeGreaterThanOrEqual(desktopMetrics.browser!.right - 1);
      expect(desktopMetrics.chat!.right).toBeLessThanOrEqual(desktopMetrics.innerWidth + 1);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('notebook-mobile-browser')).toHaveAttribute('aria-hidden', 'false');
      await expect(page.locator('img[tabindex]')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('browser-agent-activity-sheet')).toBeVisible();
      await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', session.sessionId);
      await page.screenshot({
        path: 'test-results/notebook-browser-mobile-activity.png',
        fullPage: false,
      });
      await page.getByTestId('browser-agent-activity-sheet').getByRole('button', {
        name: /^(Agent-Aktivität ausblenden|Hide agent activity)$/,
      }).click();
      await expect(page.getByTestId('browser-agent-activity-sheet')).toHaveCount(0);
      await expect(page.getByTestId('browser-agent-activity-toggle')).toHaveAttribute('aria-expanded', 'false');
      await page.screenshot({ path: 'test-results/notebook-browser-mobile.png', fullPage: false });
      const mobileMetrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.innerWidth + 1);
      expect(pageErrors).toEqual([]);
    } finally {
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('moves browser uploads and downloads through the session workspace', async ({ page }) => {
    const fixtureName = `browser-lab-upload-${Date.now()}.txt`;
    const fixtureContent = 'Canvas Browser Lab upload fixture.';
    let downloadedWorkspacePath = '';

    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page);
    const session = await findBrowserLabSession(page);
    const workspaceId = session.workspace?.workspaceId;
    expect(workspaceId, 'Browser Lab transfer E2E requires a session workspace.').toBeTruthy();
    const workspaceQuery = `workspaceId=${encodeURIComponent(workspaceId!)}`;

    const writeResponse = await page.request.post(`/api/files/write?${workspaceQuery}`, {
      data: { path: fixtureName, content: fixtureContent },
    });
    expect(writeResponse.ok(), await writeResponse.text()).toBeTruthy();
    const fixtureAccess = await issueBrowserFixtureAccess(page);

    try {
      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);
      await page.getByRole('button', { name: labels.connect }).click();
      await expect(page.getByText(labels.live)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(labels.userControls)).toBeVisible();
      await expect(page.getByRole('button', { name: labels.interactionToggle })).toHaveCount(0);

      const address = page.getByLabel(labels.address);
      await expect(address).toBeEnabled();
      const frame = page.locator('img[tabindex]');
      await address.fill(
        `http://localhost:3000/api/browser/view/fixture-page?access=${encodeURIComponent(fixtureAccess!)}`,
      );
      await page.getByRole('button', { name: labels.navigate }).click();
      await expect(address).toHaveValue(/\/api\/browser\/view\/fixture-page\?access=/, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Browser transfer fixture', exact: true })).toBeVisible({ timeout: 30_000 });

      await frame.focus();
      await frame.press('Tab');
      await frame.press('Space');
      await expect(page.getByText(/^(Workspace-Datei auswählen|Choose a workspace file)$/)).toBeVisible({ timeout: 15_000 });
      await page.getByText(/^(Workspace-Dateien durchsuchen|Search workspace files)$/).locator('..').getByRole('textbox').fill(fixtureName);
      const fileSelect = page.getByLabel(/^(Datei auswählen|Choose file)$/);
      await expect(fileSelect.locator(`option[value="${fixtureName}"]`)).toHaveCount(1, { timeout: 15_000 });
      await fileSelect.selectOption(fixtureName);
      await page.getByRole('button', { name: /^(Ausgewählte Datei verwenden|Use selected file)$/ }).click();
      await expect(page.getByText(/^(Workspace-Datei auswählen|Choose a workspace file)$/)).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: `Uploaded: ${fixtureName}`, exact: true })).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: 'test-results/browser-lab-file-transfer-ready.png', fullPage: false });

      const fixtureBounds = await frame.boundingBox();
      expect(fixtureBounds, 'The transfer fixture has no interactive bounds.').toBeTruthy();
      await frame.click({
        position: {
          x: fixtureBounds!.width * 0.6,
          y: fixtureBounds!.height * 0.58,
        },
      });
      const canvasDownloadLink = page.getByRole('link', { name: /^(Über Canvas herunterladen|Download through Canvas)/ });
      await expect(canvasDownloadLink).toBeVisible({ timeout: 30_000 });
      const downloadHref = await canvasDownloadLink.getAttribute('href');
      expect(downloadHref).toBeTruthy();
      downloadedWorkspacePath = new URL(downloadHref!, 'http://localhost:3456').searchParams.get('path') || '';
      expect(downloadedWorkspacePath).toMatch(/^Browser Downloads\/browser-lab-download(?: \(\d+\))?\.txt$/u);

      const downloadPromise = page.waitForEvent('download');
      await canvasDownloadLink.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(downloadedWorkspacePath.split('/').at(-1));

      const readResponse = await page.request.get(
        `/api/files/read?${workspaceQuery}&path=${encodeURIComponent(downloadedWorkspacePath)}`,
      );
      const readPayload = await readResponse.json() as { data?: { content?: string } };
      expect(readResponse.ok(), JSON.stringify(readPayload)).toBeTruthy();
      expect(readPayload.data?.content).toBe('Canvas Browser Lab controlled download fixture.\n');

      await page.screenshot({ path: 'test-results/browser-lab-file-transfers.png', fullPage: false });
      await page.getByTitle(labels.disconnect).click();
    } finally {
      const ownedPaths = [fixtureName, downloadedWorkspacePath].filter(Boolean);
      if (ownedPaths.length > 0) {
        await page.request.delete(`/api/files/delete?${workspaceQuery}`, { data: { path: ownedPaths } });
      }
      await deleteBrowserLabTestSession(page, session);
    }
  });
});
