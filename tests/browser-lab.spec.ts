import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import net from 'node:net';

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
  createdAgentRevision?: number;
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

async function browserRoundtripCommand(page: Page, session: SessionSummary, input?: Record<string, unknown>) {
  const socketPath = process.env.CANVAS_BROWSER_ROUNDTRIP_SOCKET;
  if (!socketPath) throw new Error('Start the dev server with the browser roundtrip preload first.');
  const cookies = await page.context().cookies(process.env.BASE_URL || 'http://localhost:3000');
  return new Promise<Record<string, unknown> | null>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(60_000, () => socket.destroy(new Error('Browser roundtrip command timed out.')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({
      command: input ? 'tool' : 'runtime_status', input,
      sessionId: session.sessionId, agentId: session.agentId,
      cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
    }) + '\n'));
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('end', () => {
      try {
        const response = JSON.parse(buffer);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}

async function login(page: Page, destination: string | null = '/'): Promise<void> {
  if (cachedAuthCookies) {
    await page.context().addCookies(cachedAuthCookies);
    if (destination) await page.goto(destination);
    return;
  }
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  expect(response.ok(), 'The bootstrap login must succeed.').toBeTruthy();
  cachedAuthCookies = await page.context().cookies();
  if (destination) await page.goto(destination);
}

async function issueBrowserFixtureAccess(page: Page): Promise<string> {
  const response = await page.request.post('/api/browser/view/fixture-access');
  const payload = await response.json() as { data?: { access?: string } };
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data?.access).toBeTruthy();
  return payload.data!.access!;
}

async function findBrowserLabSession(page: Page): Promise<SessionSummary> {
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
  const agentResponse = await page.request.post('/api/agents', {
    data: { name: `Browser Lab E2E ${Date.now()}`, scopeType: 'user', enabledTools: ['browser'] },
  });
  const agentPayload = await agentResponse.json() as {
    data?: { agent?: AgentSummary & { revision: number } };
    error?: string;
  };
  expect(agentResponse.ok(), agentPayload.error).toBeTruthy();
  const agent = agentPayload.data!.agent!;
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
    createdAgentRevision: agent.revision,
    engine: createPayload.session?.engine || 'pi',
    sessionId: createPayload.session!.sessionId,
    workspace: createPayload.session?.workspace ?? null,
  };
}

async function deleteBrowserLabTestSession(page: Page, session: SessionSummary): Promise<void> {
  if (!session.createdByTest) return;
  if (session.createdAgentRevision !== undefined) {
    const closed = await page.request.post('/api/agents/browser', {
      data: { action: 'delete_profile', agentId: session.agentId, sessionId: session.sessionId },
      timeout: 15_000,
    });
    expect(closed.ok()).toBeTruthy();
  }
  const deletedSession = await page.request.delete(
    `/api/sessions?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`,
  );
  expect(deletedSession.ok()).toBeTruthy();
  if (session.createdAgentRevision !== undefined) {
    const preview = await page.request.post('/api/agents/delete-preview', { data: { agentId: session.agentId } });
    const payload = await preview.json() as { data: { confirmationToken: string } };
    expect(preview.ok()).toBeTruthy();
    const deleted = await page.request.delete('/api/agents', {
      data: { agentId: session.agentId, expectedRevision: session.createdAgentRevision, confirmationToken: payload.data.confirmationToken },
    });
    expect(deleted.ok()).toBeTruthy();
  }
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
      // Chromium can replace the initial about:blank entry. Create real history.
      await address.fill(`${fixtureUrl}#history`);
      await page.getByRole('button', { name: labels.navigate }).click();
      await expect(page.getByTitle(labels.back)).toBeEnabled();
      await page.getByTitle(labels.back).click();
      await expect(address).toHaveValue(fixtureUrl, { timeout: 30_000 });
      await page.getByRole('button', { name: /^(Vor|Forward)$/ }).click();
      await expect(address).toHaveValue(`${fixtureUrl}#history`, { timeout: 30_000 });
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
    } catch (error) {
      console.error('Browser cooperative flow failed:', error);
      throw error;
    } finally {
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('reconnects automatically and keeps stale frames locked until a fresh frame arrives', async ({ page }) => {
    await login(page, null);
    const session = await findBrowserLabSession(page);
    const sockets: WebSocketRoute[] = [];
    const upstreams: WebSocketRoute[] = [];
    const heldFrames: Array<string | Buffer> = [];
    const connectionEvents: unknown[] = [];
    let holdFrames = true;
    await page.routeWebSocket('**/ws/browser', (ws) => {
      sockets.push(ws);
      const number = sockets.length;
      const upstream = ws.connectToServer();
      upstreams.push(upstream);
      // Keep the old server transport alive until the delayed cleanup below.
      ws.onClose(() => {});
      upstream.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'state') connectionEvents.push({ number, type: 'state', mode: message.state.mode, owner: message.state.controlOwnerViewId, view: message.state.viewId });
        if (message.type === 'error') connectionEvents.push({ number, type: 'error', code: message.code });
        if (number === 2 && holdFrames && message.type === 'frame') heldFrames.push(raw);
        else ws.send(raw);
      });
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        connectionEvents.push({ number, client: message.type });
        upstream.send(raw);
      });
    });
    try {
      await page.goto(`/browser/lab?agentId=${session.agentId}&sessionId=${session.sessionId}`);
      await page.getByRole('button', { name: labels.connect }).click();
      const frame = page.locator('img[tabindex]');
      await expect(frame).toHaveAttribute('data-live', 'true', { timeout: 60_000 });
      await sockets[0].close({ code: 1012, reason: 'Test transport restart' });
      await expect.poll(() => sockets.length).toBe(2);
      await expect.poll(() => heldFrames.length).toBeGreaterThan(0);
      await expect(frame).toHaveAttribute('data-live', 'false');
      await expect(page.getByLabel(labels.address)).toBeDisabled();
      await expect(page.getByText(/^(Letztes Browserbild|Last browser frame)/)).toBeVisible();
      holdFrames = false;
      for (const message of heldFrames) sockets[1].send(message);
      await expect(frame).toHaveAttribute('data-live', 'true');
      // Simulate the server discovering the old transport loss after reconnect.
      // Native browser WebSocket.close only accepts 1000 or application codes.
      await upstreams[0].close({ code: 1000, reason: 'Old transport released' });
      try {
        await expect(page.getByLabel(labels.address)).toBeEnabled();
      } catch (error) {
        console.error('Reconnect events:', JSON.stringify(connectionEvents.slice(-40)));
        throw error;
      }
      expect(sockets).toHaveLength(2);
    } finally {
      await page.goto('about:blank');
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('bounds automatic retry attempts and permits canceling a retry', async ({ page }) => {
    await login(page, null);
    const session = await findBrowserLabSession(page);
    let requests = 0;
    await page.route('**/api/browser/view', async (route) => {
      requests++;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
        success: false, code: 'CONNECTION_FAILED', retryable: true, fatal: true,
      }) });
    });
    try {
      await page.goto(`/browser/lab?agentId=${session.agentId}&sessionId=${session.sessionId}`);
      await page.getByRole('button', { name: labels.connect }).click();
      await expect.poll(() => requests, { timeout: 15_000 }).toBe(4);
      await expect(page.getByRole('button', { name: labels.retry })).toBeVisible();
      await page.waitForTimeout(1200);
      expect(requests).toBe(4);
      await page.getByRole('button', { name: labels.retry }).click();
      await expect.poll(() => requests).toBe(5);
      await page.getByTitle(labels.disconnect).click();
      await page.waitForTimeout(2200);
      expect(requests).toBe(5);
    } finally {
      await page.goto('about:blank');
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('forwards hover and resolves a real browser prompt with user text', async ({ page }) => {
    await login(page, null);
    const session = await findBrowserLabSession(page);
    const access = await issueBrowserFixtureAccess(page);
    let viewport = { width: 1280, height: 800 };
    const mouseActions: string[] = [];
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/ws/browser')) return;
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === 'state') viewport = message.state.viewport;
      });
      socket.on('framesent', ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === 'input_mouse') mouseActions.push(message.action);
      });
    });
    try {
      await page.goto(`/browser/lab?agentId=${session.agentId}&sessionId=${session.sessionId}`);
      await page.getByRole('button', { name: labels.connect }).click();
      const frame = page.locator('img[tabindex]');
      await expect(frame).toHaveAttribute('data-live', 'true', { timeout: 60_000 });
      const address = page.getByLabel(labels.address);
      await address.fill(`http://localhost:3000/api/browser/view/fixture-page?access=${encodeURIComponent(access)}`);
      await address.press('Enter');
      await expect(frame).toHaveAttribute('alt', 'Browser transfer fixture', { timeout: 30_000 });
      const bounds = await frame.boundingBox();
      expect(bounds).toBeTruthy();
      const point = (x: number, y: number) => ({ x: bounds!.x + x * bounds!.width / viewport.width, y: bounds!.y + y * bounds!.height / viewport.height });
      const hover = point(230, 36);
      await page.mouse.move(hover.x, hover.y);
      await expect(frame).toHaveAttribute('alt', 'Hover received');
      await page.mouse.down();
      await expect.poll(() => mouseActions.at(-1)).toBe('down');
      await frame.dispatchEvent('pointercancel', {
        pointerId: 1, pointerType: 'mouse', clientX: hover.x, clientY: hover.y, button: 0, buttons: 0,
      });
      await expect.poll(() => mouseActions.at(-1)).toBe('up');
      await page.mouse.up();
      const prompt = point(80, 36);
      await page.mouse.click(prompt.x, prompt.y);
      const dialog = page.getByTestId('browser-dialog');
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      const input = dialog.getByRole('textbox');
      await expect(input).toHaveValue('default value');
      await input.fill('Notebook roundtrip');
      await input.press('Enter');
      await expect(dialog).toBeHidden();
      await expect(frame).toHaveAttribute('alt', 'Prompt: Notebook roundtrip');
    } finally {
      await page.goto('about:blank');
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('stops all viewers when their managed browser session is closed', async ({ page }) => {
    test.slow();
    await login(page, null);
    const session = await findBrowserLabSession(page);
    const spectator = await page.context().newPage();
    try {
      const url = `/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`;
      for (const viewer of [page, spectator]) {
        await viewer.goto(url);
        await expect(viewer.getByRole('button', { name: labels.connect })).toBeEnabled({ timeout: 60_000 });
        await viewer.getByRole('button', { name: labels.connect }).click();
        await expect(viewer.locator('img[tabindex]')).toBeVisible({ timeout: 60_000 });
      }
      const stopped = await page.request.post('/api/agents/browser', {
        data: { action: 'close_session', agentId: session.agentId, sessionId: session.sessionId },
      });
      expect(stopped.ok()).toBeTruthy();
      for (const viewer of [page, spectator]) {
        await expect(viewer.getByText(/^(Die Browser-Sitzung wurde beendet\.|The browser session was closed\.)$/)).toBeVisible();
        await expect(viewer.getByLabel(labels.address)).toBeDisabled();
      }
      // Wait beyond several capture ticks: a queued screenshot used to restart it.
      await page.waitForTimeout(1200);
      const status = await page.request.get(`/api/agents/browser?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);
      expect((await status.json()).data.profile.sessionRunning).toBe(false);
    } finally {
      await spectator.close();
      await page.goto('about:blank');
      await deleteBrowserLabTestSession(page, session);
    }
  });

  test('connects Notebook while agent browser startup awaits a JavaScript prompt', async ({ page }) => {
    test.skip(!process.env.CANVAS_BROWSER_ROUNDTRIP_SOCKET, 'Requires the explicit dev-only browser tool preload.');
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, null);
    const session = await findBrowserLabSession(page);
    let starting: ReturnType<typeof browserRoundtripCommand> | undefined;
    let ticketRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/browser/view' && request.method() === 'POST') ticketRequests++;
    });
    try {
      await page.goto(`/notebook?chat=open&session=${encodeURIComponent(session.sessionId)}`);
      await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', session.sessionId, { timeout: 30_000 });
      const access = await issueBrowserFixtureAccess(page);
      starting = browserRoundtripCommand(page, session, {
        action: 'start', timeout_ms: 60_000,
        url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/browser/view/fixture-page?access=${encodeURIComponent(access)}&promptOnLoad=1`,
      });
      void starting.catch(() => undefined);
      const dialog = page.getByTestId('browser-dialog');
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByRole('textbox')).toBeEnabled({ timeout: 20_000 });
      await expect(page.locator('img[tabindex]')).toHaveCount(0);
      // Cross both the 15s connection deadline and the 30s control lease.
      // A user thinking about a prompt must keep the same working connection.
      await page.waitForTimeout(31_000);
      expect(ticketRequests).toBe(1);
      await expect(dialog.getByRole('textbox')).toBeEnabled();
      await dialog.getByRole('textbox').fill('Startup resolved');
      await dialog.getByRole('textbox').press('Enter');
      const result = await starting;
      expect(result?.details).not.toHaveProperty('error');
      await expect(page.locator('img[tabindex]')).toHaveAttribute('alt', 'Prompt: Startup resolved');
      await browserRoundtripCommand(page, session, { action: 'close' });
      await expect(page.getByTestId('notebook-surface-browser')).toHaveCount(0);
    } finally {
      await page.goto('about:blank');
      await deleteBrowserLabTestSession(page, session);
      await starting?.catch(() => undefined);
    }
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`completes the real agent browser roundtrip in Notebook at ${viewport.width}px`, async ({ page }) => {
      test.skip(!process.env.CANVAS_BROWSER_ROUNDTRIP_SOCKET, 'Requires the explicit dev-only browser tool preload.');
      test.slow();
      await page.setViewportSize(viewport);
      await login(page, null);
      const session = await findBrowserLabSession(page);
      const otherSession = await findBrowserLabSession(page);
      const errors: Error[] = [];
      page.on('pageerror', (error) => errors.push(error));
      let browserViewport = { width: 1280, height: 800 };
      let browserStates = 0;
      page.on('websocket', (socket) => {
        if (!socket.url().includes('/ws/browser')) return;
        socket.on('framereceived', ({ payload }) => {
          const message = JSON.parse(String(payload));
          if (message.type === 'state') { browserViewport = message.state.viewport; browserStates++; }
        });
      });
      const notebookUrl = `/notebook?chat=open&session=${encodeURIComponent(session.sessionId)}`;
      try {
        await page.goto(notebookUrl);
        await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', session.sessionId, { timeout: 30_000 });
        await expect.poll(async () => Boolean(await browserRoundtripCommand(page, session)), { timeout: 60_000 }).toBe(true);
        await expect(page.getByTestId('notebook-surface-browser')).toHaveCount(0);
        const access = await issueBrowserFixtureAccess(page);
        const started = await browserRoundtripCommand(page, session, {
          action: 'start', url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/browser/view/fixture-page?access=${encodeURIComponent(access)}`,
        });
        expect(started?.details).not.toHaveProperty('error');
        // No /ws/chat or runtime-status mocks: the real agent runtime must publish this.
        await expect(page.getByTestId('notebook-surface-browser')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
        const frame = page.locator('img[tabindex]');
        await expect(frame).toHaveAttribute('data-live', 'true', { timeout: 30_000 });
        await expect(frame).toHaveAttribute('alt', 'Browser transfer fixture');
        await expect(page.getByLabel(labels.address)).toBeEnabled();
        if (viewport.width < 768) {
          await page.getByTestId('browser-agent-activity-sheet').getByRole('button', {
            name: /^(Agent-Aktivität ausblenden|Hide agent activity)$/,
          }).click();
          await expect(page.getByTestId('browser-agent-activity-sheet')).toHaveCount(0);
        }
        const before = await browserRoundtripCommand(page, session);
        const beforeRevision = (before?.browser as { interactionRevision?: number } | undefined)?.interactionRevision ?? 0;
        const bounds = await frame.boundingBox();
        expect(bounds).toBeTruthy();
        await page.mouse.click(bounds!.x + 80 * bounds!.width / browserViewport.width, bounds!.y + 36 * bounds!.height / browserViewport.height);
        const dialog = page.getByTestId('browser-dialog');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('textbox').fill(`Roundtrip ${viewport.width}`);
        await page.screenshot({ path: `test-results/notebook-browser-prompt-${viewport.width}.png` });
        await dialog.getByRole('textbox').press('Enter');
        await expect(dialog).toBeHidden();
        await expect(frame).toHaveAttribute('alt', `Prompt: Roundtrip ${viewport.width}`);
        const observed = await browserRoundtripCommand(page, session, { action: 'evaluate', script: 'document.title' });
        expect(observed?.details).toHaveProperty('result', `Prompt: Roundtrip ${viewport.width}`);
        await expect.poll(async () => ((await browserRoundtripCommand(page, session))?.browser as { interactionRevision?: number })?.interactionRevision ?? 0).toBeGreaterThan(beforeRevision);
        expect(browserStates).toBeGreaterThan(0);

        await page.goto(`/notebook?chat=open&session=${encodeURIComponent(otherSession.sessionId)}`);
        await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', otherSession.sessionId);
        await expect(page.getByTestId('notebook-surface-browser')).toHaveCount(0);
        await expect(page.locator('img[tabindex]')).toHaveCount(0);
        await page.goto(notebookUrl);
        await expect(page.getByTestId('notebook-surface-browser')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
        await expect(frame).toHaveAttribute('data-live', 'true');
        await expect(frame).toHaveAttribute('alt', `Prompt: Roundtrip ${viewport.width}`);
        const closed = await browserRoundtripCommand(page, session, { action: 'close' });
        expect(closed?.details).not.toHaveProperty('error');
        await expect(page.getByTestId('notebook-surface-browser')).toHaveCount(0);
        await expect(page.getByTestId('chat-live-browser-link')).toHaveCount(0);
        await expect.poll(async () => Boolean((await browserRoundtripCommand(page, session))?.browser)).toBe(false);
        const status = await browserRoundtripCommand(page, session, { action: 'status' });
        expect(status?.details).toHaveProperty('running', false);
        expect(errors).toEqual([]);
      } finally {
        await page.goto('about:blank');
        await deleteBrowserLabTestSession(page, session);
        await deleteBrowserLabTestSession(page, otherSession);
      }
    });
  }

  test('opens the running browser beside its chat inside the notebook', async ({ page }) => {
    test.slow();
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.setViewportSize({ width: 1440, height: 900 });
    await exposeBrowserRuntimeToNotebook(page, 'browser-lab-session');
    await login(page, null);
    const session = await findBrowserLabSession(page);
    try {
      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);
      await expect(page.getByRole('button', { name: labels.connect })).toBeEnabled({ timeout: 60_000 });
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
      await page.getByRole('button', { name: /^(Browser-Arbeitsfläche schließen|Close browser work area)$/ }).click();
      await expect(page.getByTestId('notebook-surface-browser')).toHaveCount(0);
      await page.getByTestId('chat-live-browser-link').click();
      await expect(page.getByTestId('notebook-surface-browser')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('img[tabindex]')).toBeVisible({ timeout: 30_000 });
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

  test('cancels a pending notebook browser ticket when its surface is closed', async ({ page }) => {
    test.slow();
    await login(page, null);
    const session = await findBrowserLabSession(page);
    let releaseTicket!: () => void;
    const ticketGate = new Promise<void>((resolve) => { releaseTicket = resolve; });
    let finishTicket!: () => void;
    const ticketFinished = new Promise<void>((resolve) => { finishTicket = resolve; });
    let requests = 0;
    const frameCounts: number[] = [];
    page.on('websocket', (socket) => {
      if (!socket.url().endsWith('/ws/browser')) return;
      const index = frameCounts.push(0) - 1;
      socket.on('framereceived', ({ payload }) => {
        if (JSON.parse(String(payload)).type === 'frame') frameCounts[index] += 1;
      });
    });
    await exposeBrowserRuntimeToNotebook(page, session.sessionId);
    await page.route('**/api/browser/view', async (route) => {
      requests += 1;
      if (requests !== 1) return route.continue();
      await ticketGate;
      try {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { ticket: 'obsolete', websocketUrl: '/ws/browser' } }),
        });
      } finally {
        finishTicket();
      }
    });
    try {
      await page.goto(`/notebook?chat=open&session=${encodeURIComponent(session.sessionId)}`);
      await expect.poll(() => requests, { timeout: 30_000 }).toBe(1);
      await page.getByRole('button', { name: /^(Browser-Arbeitsfläche schließen|Close browser work area)$/ }).click();
      releaseTicket();
      await ticketFinished;
      await expect(page.getByTestId('notebook-surface-browser')).toHaveCount(0);
      expect(frameCounts).toHaveLength(0);
      await page.getByTestId('chat-live-browser-link').click();
      await expect(page.locator('img[tabindex]')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => frameCounts[0], { timeout: 15_000 }).toBeGreaterThan(1);
      expect(frameCounts).toHaveLength(1);
    } finally {
      releaseTicket();
      await page.goto('about:blank');
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
      // The prompt and hover fixtures precede the file input in tab order.
      await frame.press('Tab');
      await frame.press('Tab');
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
