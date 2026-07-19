import { expect, test, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

const labels = {
  address: /^(Adresse|Address)$/,
  agentControls: /^(Agent steuert|Agent controls)$/,
  connect: /^(Live-Ansicht starten|Start live view)$/,
  disconnect: /^(Trennen|Disconnect)$/,
  disconnected: /^(Nicht verbunden|Disconnected)$/,
  giveAgent: /^(An Agenten geben|Give to agent)$/,
  live: /^(Live verbunden|Live connected)$/,
  navigate: /^(Öffnen|Open)$/,
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

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(TEST_EMAIL);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
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
        visibleButtons: [...document.querySelectorAll('button')].filter((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.left < window.innerWidth;
        }).map((button) => {
          const bounds = button.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, text: button.textContent?.trim() || '' };
        }),
      }));
      expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.innerWidth + 1);
      expect(mobileMetrics.visibleButtons.every((button) => button.left >= -1 && button.right <= mobileMetrics.innerWidth + 1)).toBeTruthy();

      await page.getByTitle(labels.disconnect).click();
      expect(pageErrors).toEqual([]);
    } finally {
      await deleteBrowserLabTestSession(page, session);
    }
  });
});
