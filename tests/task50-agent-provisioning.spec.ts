import { expect, test, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const TEST_NAME_PREFIX = 'Task 50 Playwright';

type AgentSummary = {
  agentId: string;
  name: string;
  revision: number;
  type: string;
};

async function login(page: Page) {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /email/i }).fill(TEST_EMAIL);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

async function listAgents(page: Page): Promise<AgentSummary[]> {
  const response = await page.request.get('/api/agents');
  if (!response.ok()) return [];
  const payload = await response.json() as { data?: { agents?: AgentSummary[] } };
  return payload.data?.agents ?? [];
}

async function deleteAgentThroughApi(page: Page, agent: AgentSummary) {
  if (agent.type === 'main') return;
  const previewResponse = await page.request.post('/api/agents/delete-preview', {
    data: { agentId: agent.agentId },
  });
  if (!previewResponse.ok()) return;
  const preview = await previewResponse.json() as {
    data?: { agent?: { revision?: number }; confirmationToken?: string };
  };
  const confirmationToken = preview.data?.confirmationToken;
  const expectedRevision = preview.data?.agent?.revision;
  if (!confirmationToken || typeof expectedRevision !== 'number') return;
  await page.request.delete('/api/agents', {
    data: { agentId: agent.agentId, expectedRevision, confirmationToken },
  });
}

async function cleanupTaskAgents(page: Page) {
  for (const agent of await listAgents(page)) {
    if (agent.name.startsWith(TEST_NAME_PREFIX)) {
      await deleteAgentThroughApi(page, agent);
    }
  }
}

function agentCard(page: Page, agentName: string) {
  return page.getByText(agentName, { exact: true })
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-md ") and contains(concat(" ", normalize-space(@class), " "), " p-3 ")][1]');
}

async function openCreateAgentDialog(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(async () => {
    if (!await dialog.isVisible()) {
      await page.getByRole('button', { name: 'Create agent' }).click();
    }
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return dialog;
}

test.describe('Task 50 agent provisioning and management', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
    await cleanupTaskAgents(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupTaskAgents(page);
  });

  test('creates personal and organization agents, grants access, exposes safe management tools, and previews deletion', async ({ browser, page }) => {
    const unique = Date.now();
    const personalName = `${TEST_NAME_PREFIX} Personal ${unique}`;
    const organizationName = `${TEST_NAME_PREFIX} Organization ${unique}`;

    await page.goto('/en/settings?tab=agent-settings');
    await expect(page.getByText('Agent Selection', { exact: true })).toBeVisible({ timeout: 30_000 });

    const createDialog = await openCreateAgentDialog(page);
    await expect(createDialog.getByTestId('agent-scope-picker')).toBeVisible();
    await expect(createDialog.getByRole('button', { name: /Organization/ })).toBeEnabled();
    await expect.poll(() => createDialog.evaluate((element) => (
      element.getAnimations().every((animation) => animation.playState === 'finished')
    ))).toBe(true);
    await page.screenshot({ path: 'test-results/task50-create-desktop.png', fullPage: false });

    const desktopBox = await createDialog.boundingBox();
    expect(desktopBox).not.toBeNull();
    expect(desktopBox!.x).toBeGreaterThanOrEqual(0);
    expect(desktopBox!.y).toBeGreaterThanOrEqual(0);
    expect(desktopBox!.x + desktopBox!.width).toBeLessThanOrEqual(1280);
    expect(desktopBox!.y + desktopBox!.height).toBeLessThanOrEqual(720);

    await createDialog.getByRole('button', { name: 'Close' }).click();

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
    });
    const mobilePage = await mobileContext.newPage();
    await login(mobilePage);
    await mobilePage.goto('/en/settings?tab=agent-settings');
    await expect(mobilePage.getByText('Agent Selection', { exact: true })).toBeVisible({ timeout: 30_000 });
    const mobileDialog = await openCreateAgentDialog(mobilePage);
    await expect(mobileDialog.getByTestId('agent-scope-picker')).toBeVisible();
    const mobileBox = await mobileDialog.boundingBox();
    expect(mobileBox).not.toBeNull();
    await mobilePage.screenshot({ path: 'test-results/task50-create-mobile.png', fullPage: false });
    expect(mobileBox!.x).toBeGreaterThanOrEqual(0);
    expect(mobileBox!.y).toBeGreaterThanOrEqual(0);
    expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390);
    expect(mobileBox!.y + mobileBox!.height).toBeLessThanOrEqual(844);
    await expect.poll(() => mobileDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await mobileContext.close();

    await openCreateAgentDialog(page);
    await createDialog.getByLabel('Name').fill(personalName);
    await createDialog.getByRole('button', { name: /Only me/ }).click({ force: true });
    await createDialog.getByRole('button', { name: 'Create agent', exact: true }).click({ force: true });
    await expect(createDialog.getByTestId('personal-agent-created')).toBeVisible({ timeout: 30_000 });
    await createDialog.getByRole('button', { name: 'Done' }).click();

    const personalCard = agentCard(page, personalName);
    await expect(personalCard).toBeVisible();
    await expect(personalCard.getByText('Only me', { exact: true })).toBeVisible();
    await expect(personalCard.getByText(/^r\d+$/)).toBeVisible();

    await openCreateAgentDialog(page);
    await createDialog.getByLabel('Name').fill(organizationName);
    const organizationScope = createDialog.getByRole('button', { name: /Organization/ });
    await organizationScope.click({ force: true });
    await expect(organizationScope).toHaveAttribute('aria-pressed', 'true');
    await createDialog.getByRole('button', { name: 'Create agent', exact: true }).click({ force: true });

    await expect(page.getByText(organizationName, { exact: true })).toBeVisible({ timeout: 30_000 });
    const dialogGrants = createDialog.getByTestId('agent-grants-editor');
    const grants = await dialogGrants.isVisible()
      ? dialogGrants
      : page.locator('main').getByTestId('agent-grants-editor');
    await expect(grants).toBeVisible();

    await grants.getByLabel('Grant target type').selectOption('workspace');
    await grants.getByLabel('Grant target ID').fill('workspace-that-does-not-exist');
    await grants.getByRole('button', { name: 'Add' }).click();
    await expect(grants.getByText(/not found|does not exist|outside.*organization|unavailable/i)).toBeVisible();

    await grants.getByLabel('Grant target type').selectOption('role');
    await grants.getByLabel('Role').selectOption('member');
    await grants.getByLabel('Grant access level').selectOption('user');
    await grants.getByRole('button', { name: 'Add' }).click();
    await expect(grants.getByText('member', { exact: true })).toBeVisible();
    await expect(grants.getByText('user', { exact: true })).toBeVisible();
    await grants.getByText('member', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/task50-organization-grants.png', fullPage: false });
    if (await createDialog.isVisible()) {
      await createDialog.getByRole('button', { name: 'Done' }).click();
    }

    const organizationCard = agentCard(page, organizationName);
    await expect(organizationCard).toBeVisible();
    await expect(organizationCard.getByText('Organization', { exact: true })).toBeVisible();
    await expect(page.getByTestId('agent-grants-editor').getByText('member', { exact: true })).toBeVisible();

    const mainAgent = (await listAgents(page)).find((agent) => agent.type === 'main');
    expect(mainAgent).toBeDefined();
    await page.getByText(mainAgent!.name, { exact: true }).click();

    const toolsCard = page.locator('#onboarding-settings-tools');
    await expect(toolsCard).toBeVisible();
    const toolSearch = toolsCard.getByPlaceholder('Search tools...');
    if (!await toolSearch.isVisible()) {
      await toolsCard.getByRole('button', { name: 'Expand' }).click();
    }
    await toolSearch.fill('agent');
    for (const toolName of ['list_agents', 'inspect_agent', 'create_agent']) {
      const toolId = toolsCard.getByText(toolName, { exact: true });
      await expect(toolId).toBeVisible();
      const toolRow = toolId.locator('xpath=../../..');
      await expect(toolRow.getByRole('switch')).not.toBeChecked();
      await expect(toolRow.getByText('Agents', { exact: true })).toBeVisible();
    }
    await expect(toolsCard.getByText('create_agent', { exact: true }).locator('xpath=../../..').getByText('On demand', { exact: true })).toBeVisible();

    let confirmationMessage = '';
    page.once('dialog', async (dialog) => {
      confirmationMessage = dialog.message();
      await dialog.accept();
    });
    await organizationCard.getByRole('button', { name: 'Delete agent' }).click();
    await expect(page.getByText(organizationName, { exact: true })).toHaveCount(0);
    expect(confirmationMessage).toContain('access assignments');
    expect(confirmationMessage).toContain('managed files');

    const remainingPersonalCard = agentCard(page, personalName);
    page.once('dialog', (dialog) => dialog.accept());
    await remainingPersonalCard.getByRole('button', { name: 'Delete agent' }).click();
    await expect(page.getByText(personalName, { exact: true })).toHaveCount(0);
  });
});
