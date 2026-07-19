import { expect, test, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

const labels = {
  address: /^(Adresse|Address)$/,
  agentControls: /^(Agent steuert|Agent controls)$/,
  connect: /^(Live-Ansicht starten|Start live view)$/,
  disconnect: /^(Trennen|Disconnect)$/,
  disconnected: /^(Nicht verbunden|Disconnected)$/,
  dismissError: /^(Meldung schließen|Dismiss message)$/,
  failureTitle: /^(Die Live-Ansicht braucht Aufmerksamkeit|The live view needs attention)$/,
  giveAgent: /^(An Agenten geben|Give to agent)$/,
  live: /^(Live verbunden|Live connected)$/,
  navigate: /^(Öffnen|Open)$/,
  navigationBlocked: /(Diese Adresse wurde durch die Browser-Sicherheitsrichtlinie blockiert\.|This address was blocked by the browser security policy\.)/,
  pageCrashed: /(Die verwaltete Browserseite wurde unerwartet beendet\.|The managed browser page stopped unexpectedly\.)/,
  resourceUnavailable: /(Auf diesem System stehen nicht genug Ressourcen für die Live-Ansicht bereit\.|This system does not have enough resources for the live view\.)/,
  retry: /^(Erneut versuchen|Try again)$/,
  session: /^(Chat-Session|Chat session)$/,
  takeControl: /^(Übernehmen|Take control)$/,
  userControls: /^(Nutzer steuert|User controls)$/,
  viewing: /^(Ansehen|Viewing)$/,
  viewOnly: /^(Nur ansehen|View only)$/,
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

test.describe('Browser Lab', () => {
  test.setTimeout(180_000);

  test('requires an authenticated user', async ({ page }) => {
    await page.goto('/browser/lab');
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/, { timeout: 15_000 });
  });

  test('shows the Browser Lab shell to the bootstrap admin', async ({ page }) => {
    await login(page);
    await page.goto('/browser/lab');
    await expect(page.getByRole('heading', { name: 'Browser Lab', level: 2 })).toBeVisible();
    await expect(page.getByText(/^(Entwicklungswerkzeug|Development tool)$/)).toBeVisible();
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

  test('connects to the managed browser and completes the control handoff flow', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page);
    const session = await findBrowserLabSession(page);
    try {
      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);

      await expect(page.getByRole('heading', { name: 'Browser Lab', level: 2 })).toBeVisible();
      const address = page.getByLabel(labels.address);
      const connectButton = page.getByRole('button', { name: labels.connect });
      await expect(connectButton).toBeEnabled({ timeout: 15_000 });
      await expect(address).toBeDisabled();
      await expect(page.getByRole('button', { name: labels.takeControl })).toBeDisabled();

      await connectButton.click();
      await expect(page.getByText(labels.live)).toBeVisible({ timeout: 60_000 });

      const frame = page.locator('img[tabindex]');
      await expect(frame).toBeVisible({ timeout: 30_000 });
      await expect(frame).toHaveAttribute('src', /^data:image\//);
      await expect(page.getByRole('button', { name: labels.takeControl })).toBeEnabled();

      await page.getByRole('button', { name: labels.takeControl }).click();
      await expect(page.getByText(labels.userControls)).toBeVisible();
      await expect(address).toBeEnabled();

      await address.fill('http://169.254.169.254/latest/meta-data');
      await page.getByRole('button', { name: labels.navigate }).click();
      const navigationAlert = page.getByRole('alert').filter({ hasText: labels.navigationBlocked });
      await expect(navigationAlert).toBeVisible();
      await expect(page.getByText(labels.live)).toBeVisible();
      await expect(address).toBeEnabled();
      await page.screenshot({ path: 'test-results/browser-lab-navigation-blocked.png', fullPage: false });
      await page.getByRole('button', { name: labels.dismissError }).click();
      await expect(navigationAlert).toHaveCount(0);

      const frameBeforeNavigation = await frame.getAttribute('src');
      await address.fill('http://localhost:3000/login');
      await page.getByRole('button', { name: labels.navigate }).click();
      await expect(address).toHaveValue(/http:\/\/localhost:3000\/.*login/, { timeout: 30_000 });
      await expect.poll(() => frame.getAttribute('src'), { timeout: 30_000 }).not.toBe(frameBeforeNavigation);

      await page.getByRole('button', { name: labels.viewOnly }).click();
      await expect(page.getByText(labels.viewing)).toBeVisible();
      await expect(address).toBeDisabled();

      await page.getByRole('button', { name: labels.giveAgent }).click();
      await expect(page.getByText(labels.agentControls)).toBeVisible();

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
      await expect(address).toHaveValue(/http:\/\/localhost:3000\/.*login/);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('heading', { name: 'Browser Lab', level: 2 })).toBeVisible();
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
    const fixtureAccessResponse = await page.request.post('/api/browser/view/fixture-access');
    const fixtureAccessPayload = await fixtureAccessResponse.json() as {
      data?: { access?: string };
    };
    expect(fixtureAccessResponse.ok(), JSON.stringify(fixtureAccessPayload)).toBeTruthy();
    const fixtureAccess = fixtureAccessPayload.data?.access;
    expect(fixtureAccess).toBeTruthy();

    try {
      await page.goto(`/browser/lab?agentId=${encodeURIComponent(session.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`);
      await page.getByRole('button', { name: labels.connect }).click();
      await expect(page.getByText(labels.live)).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: labels.takeControl }).click();
      await expect(page.getByText(labels.userControls)).toBeVisible();

      const address = page.getByLabel(labels.address);
      const frame = page.locator('img[tabindex]');
      await address.fill(
        `http://localhost:3000/api/browser/view/fixture-page?access=${encodeURIComponent(fixtureAccess!)}`,
      );
      await page.getByRole('button', { name: labels.navigate }).click();
      await expect(address).toHaveValue(/\/api\/browser\/view\/fixture-page\?access=/, { timeout: 30_000 });
      await expect(page.getByText('Browser transfer fixture', { exact: true })).toBeVisible({ timeout: 30_000 });

      await frame.focus();
      await frame.press('Tab');
      await frame.press('Space');
      await expect(page.getByText(/^(Workspace-Datei auswählen|Choose a workspace file)$/)).toBeVisible({ timeout: 15_000 });
      await page.getByText(/^(Workspace-Dateien durchsuchen|Search workspace files)$/).locator('..').getByRole('textbox').fill(fixtureName);
      const fileSelect = page.getByLabel(/^(Datei auswählen|Choose file)$/);
      await expect(fileSelect.locator(`option[value="${fixtureName}"]`)).toHaveCount(1, { timeout: 15_000 });
      await fileSelect.selectOption(fixtureName);
      await page.getByRole('button', { name: /^(Ausgewählte Datei verwenden|Use selected file)$/ }).click();
      await expect(page.getByText(/^(Workspace-Datei auswählen|Choose a workspace file)$/)).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText(`Uploaded: ${fixtureName}`, { exact: true })).toBeVisible({ timeout: 30_000 });
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
