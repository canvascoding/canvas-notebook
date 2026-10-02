import { expect, test, type APIResponse, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const TEST_NAME_PREFIX = 'Task 50 Playwright';
const SECONDARY_EMAIL = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
const SECONDARY_PASSWORD = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
const ownedAgents = new Map<string, AgentSummary>();
let adminUserId = '';

type AgentSummary = {
  agentId: string;
  name: string;
  revision: number;
  type: string;
  scopeType?: 'user' | 'organization' | 'system';
  createdByUserId?: string | null;
  ownerUserId?: string | null;
  access?: {
    canUse: boolean;
    canEdit: boolean;
    canManage: boolean;
  };
};

type ProvisionedMember = {
  id: string;
  email: string;
  password: string;
};

async function verifiedSession(page: Page, timeout = 15_000) {
  const response = await page.request.get('/api/auth/get-session', { timeout });
  expect(response.ok(), `Session check returned HTTP ${response.status()}.`).toBe(true);
  const payload = await response.json() as { user?: { id?: string; email?: string; role?: string } };
  expect(typeof payload.user?.id).toBe('string');
  expect(payload.user?.id).toBeTruthy();
  return payload.user!;
}

async function loginWithCredentials(page: Page, email: string, password: string) {
  const deadline = Date.now() + 45_000;
  const remainingTimeout = () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Actual UI sign-in exceeded its 45-second deadline.');
    return Math.min(15_000, remainingMs);
  };
  await page.goto('/en/login', { waitUntil: 'domcontentloaded', timeout: remainingTimeout() });
  await page.getByRole('textbox', { name: /email/i }).fill(email, { timeout: remainingTimeout() });
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password, { timeout: remainingTimeout() });
  const submit = page.locator('button[type="submit"]');
  let retries = 0;
  while (true) {
    await expect(submit).toBeEnabled({ timeout: remainingTimeout() });
    const [signedIn] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/auth/sign-in/email', { timeout: remainingTimeout() }),
      submit.click({ timeout: remainingTimeout() }),
    ]);
    const result = await signedIn.json().catch(() => null) as { code?: unknown; error?: { code?: unknown } } | null;
    const rawCode = result?.code ?? result?.error?.code;
    const safeCode = typeof rawCode === 'string' && /^[A-Z0-9_]{1,80}$/u.test(rawCode) ? rawCode : 'no error code';
    if (signedIn.status() === 200) {
      expect(result !== null && typeof result === 'object' && !Array.isArray(result), 'Actual UI sign-in must return a JSON object.').toBe(true);
      break;
    }
    if (signedIn.status() !== 429 || retries >= 2) {
      throw new Error(`Actual UI sign-in returned HTTP ${signedIn.status()} (${safeCode}).`);
    }
    await expect(page).toHaveURL(/\/login(?:\?|$)/, { timeout: remainingTimeout() });
    await expect(submit).toBeEnabled({ timeout: remainingTimeout() });
    const retryAfter = signedIn.headers()['x-retry-after'] || signedIn.headers()['retry-after'];
    const seconds = Number(retryAfter);
    const requestedMs = retryAfter && Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 10_000;
    const waitMs = Math.max(1_000, Number.isFinite(requestedMs) ? requestedMs : 10_000);
    if (Date.now() + waitMs >= deadline) throw new Error('Actual UI sign-in 429 retry exceeds its 45-second deadline.');
    retries += 1;
    console.info(`[task50] Actual UI sign-in returned 429; waiting ${waitMs}ms before retry ${retries}/2.`);
    await page.waitForTimeout(waitMs);
  }
  const session = await verifiedSession(page, remainingTimeout());
  expect(session.email === email, 'UI login must authenticate the requested fixture identity.').toBe(true);
  await page.waitForURL((url) => !url.pathname.includes('/login'), { waitUntil: 'domcontentloaded', timeout: remainingTimeout() });
  return session;
}

async function login(page: Page) {
  return loginWithCredentials(page, TEST_EMAIL, TEST_PASSWORD);
}

async function provisionMember(page: Page, agent: AgentSummary): Promise<ProvisionedMember> {
  expect(Boolean(SECONDARY_EMAIL && SECONDARY_PASSWORD),
    'Task 50 requires an existing active non-admin TEST_SECONDARY_EMAIL/PASSWORD fixture.').toBeTruthy();
  expect(SECONDARY_EMAIL === TEST_EMAIL, 'Secondary fixture must differ from the admin.').toBe(false);
  expect(ownedAgents.has(agent.agentId)).toBe(true);
  const response = await page.request.get(`/api/agents/grants?agentId=${encodeURIComponent(agent.agentId)}`);
  expect(response.ok(), `Grant target catalog returned HTTP ${response.status()}.`).toBe(true);
  const payload = await response.json() as {
    success?: boolean;
    data?: { targets?: { users?: Array<{ userId: string; email?: string | null; role: string }> } };
  };
  expect(payload.success).toBe(true);
  const matches = payload.data?.targets?.users?.filter((user) => user.email === SECONDARY_EMAIL) ?? [];
  expect(matches.length, 'Secondary fixture must already be active and unbanned in the agent organization.').toBe(1);
  const member = matches[0];
  expect(['member', 'external'].includes(member.role), 'Secondary fixture must not own or administer the organization.').toBe(true);
  expect(member.userId).toBeTruthy();
  expect(member.userId).not.toBe(adminUserId);
  return { id: member.userId, email: SECONDARY_EMAIL!, password: SECONDARY_PASSWORD! };
}

async function completeMemberOnboarding(page: Page) {
  const workspaceResponse = await page.request.get('/api/workspaces');
  const workspacePayload = await workspaceResponse.json() as {
    success?: boolean;
    defaultWorkspace?: { id?: string; type?: string } | null;
  };
  expect(workspaceResponse.ok(), `Workspace fixture check returned HTTP ${workspaceResponse.status()}.`).toBe(true);
  expect(workspacePayload.success).toBe(true);
  expect(workspacePayload.defaultWorkspace?.id).toBeTruthy();
  expect(workspacePayload.defaultWorkspace?.type).toBe('personal');

  const statusResponse = await page.request.get('/api/onboarding/status');
  const statusPayload = await statusResponse.json() as {
    success?: boolean;
    enabled?: boolean;
    instanceComplete?: boolean;
    userOnboarding?: { step?: string; runtime?: string; profile?: string; tour?: string };
  };
  expect(statusResponse.ok(), `Onboarding fixture check returned HTTP ${statusResponse.status()}.`).toBe(true);
  expect(statusPayload.success).toBe(true);
  expect(typeof statusPayload.enabled).toBe('boolean');
  if (statusPayload.enabled === false) return;
  expect(statusPayload.instanceComplete).toBe(true);
  expect(statusPayload.userOnboarding?.step,
    'The existing secondary fixture must already have completed personal onboarding.').toBe('complete');
  for (const field of ['runtime', 'profile', 'tour'] as const) {
    expect(['completed', 'skipped'].includes(statusPayload.userOnboarding?.[field] ?? '')).toBe(true);
  }
}

async function listAgents(page: Page): Promise<AgentSummary[]> {
  const response = await page.request.get('/api/agents');
  expect(response.ok(), `Agent list returned HTTP ${response.status()}.`).toBe(true);
  const payload = await response.json() as { success?: boolean; data?: { agents?: AgentSummary[] } };
  expect(payload.success).toBe(true);
  expect(Array.isArray(payload.data?.agents)).toBe(true);
  return payload.data!.agents!;
}

async function registerCreatedAgent(
  response: Pick<APIResponse, 'ok' | 'status' | 'json'>,
  name: string,
  scopeType: 'user' | 'organization',
): Promise<AgentSummary> {
  expect(response.ok(), `Owned agent creation returned HTTP ${response.status()}.`).toBe(true);
  const payload = await response.json() as { success?: boolean; data?: { agent?: AgentSummary } };
  const agent = payload.data?.agent;
  expect(payload.success).toBe(true);
  expect(typeof agent?.agentId).toBe('string');
  expect(agent?.agentId).toBeTruthy();
  expect(agent?.name).toBe(name);
  expect(agent?.scopeType).toBe(scopeType);
  expect(agent?.createdByUserId).toBe(adminUserId);
  expect(agent?.type).not.toBe('main');
  // Only this request's verified creation receipt authorizes cleanup.
  ownedAgents.set(agent!.agentId, agent!);
  return agent!;
}

function waitForOwnedAgentCreation(page: Page, name: string, scopeType: 'user' | 'organization') {
  const creation = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/agents'
    && response.request().postDataJSON()?.name === name)
    .then((response) => registerCreatedAgent(response, name, scopeType));
  // Register the receipt even if the UI action fails after the POST succeeds.
  void creation.catch(() => undefined);
  return creation;
}

async function deleteAgentThroughApi(page: Page, agent: AgentSummary) {
  const owned = ownedAgents.get(agent.agentId);
  expect(owned, "Cleanup requires this test run's exact creation receipt.").toBeDefined();
  expect(agent.type).not.toBe('main');
  expect(agent.createdByUserId).toBe(owned!.createdByUserId);
  expect(agent.createdByUserId).toBe(adminUserId);
  expect(agent.name).toBe(owned!.name);
  const previewResponse = await page.request.post('/api/agents/delete-preview', {
    data: { agentId: agent.agentId },
  });
  expect(previewResponse.ok(), `Owned agent delete preview returned HTTP ${previewResponse.status()}.`).toBe(true);
  const preview = await previewResponse.json() as {
    success?: boolean;
    data?: { agent?: AgentSummary; confirmationToken?: string };
  };
  expect(preview.success).toBe(true);
  expect(preview.data?.agent?.agentId).toBe(agent.agentId);
  expect(preview.data?.agent?.createdByUserId).toBe(adminUserId);
  const expectedRevision = preview.data?.agent?.revision;
  expect(expectedRevision).toBe(agent.revision);
  expect(Number.isSafeInteger(expectedRevision) && expectedRevision! > 0).toBe(true);
  const confirmationToken = preview.data?.confirmationToken;
  expect(confirmationToken).toBeTruthy();
  const response = await page.request.delete('/api/agents', {
    data: { agentId: agent.agentId, expectedRevision, confirmationToken },
  });
  expect(response.ok(), `Owned agent deletion returned HTTP ${response.status()}.`).toBe(true);
  expect((await response.json() as { success?: boolean }).success).toBe(true);
  ownedAgents.delete(agent.agentId);
}

async function cleanupTaskAgents(page: Page) {
  if (ownedAgents.size === 0) return;
  const current = await listAgents(page);
  const errors: unknown[] = [];
  for (const agentId of [...ownedAgents.keys()]) {
    const agent = current.find((candidate) => candidate.agentId === agentId);
    if (!agent) {
      // The UI deletion test already removed this exact owned ID.
      ownedAgents.delete(agentId);
      continue;
    }
    try { await deleteAgentThroughApi(page, agent); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned Task 50 agent cleanup failed.');
}

async function cleanupOwnedSessions(page: Page, sessions: Map<string, string>, ownerUserId: string) {
  if (sessions.size === 0) return;
  expect((await verifiedSession(page)).id).toBe(ownerUserId);
  const errors: unknown[] = [];
  for (const [sessionId, agentId] of sessions) {
    expect(ownedAgents.has(agentId)).toBe(true);
    try {
      const query = new URLSearchParams({ sessionId, agentId });
      const response = await page.request.delete(`/api/sessions?${query}`);
      if (response.status() !== 404) {
        expect(response.ok(), `Owned session deletion returned HTTP ${response.status()}.`).toBe(true);
        const payload = await response.json() as { success?: boolean; deleted?: string };
        expect(payload.success).toBe(true);
        expect(payload.deleted).toBe(sessionId);
      }
      sessions.delete(sessionId);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned Task 50 session cleanup failed.');
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
    adminUserId = (await login(page)).id!;
    await cleanupTaskAgents(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupTaskAgents(page);
  });

  test('creates personal and organization agents, grants access, exposes safe management tools, and previews deletion', async ({ browser, page }, testInfo) => {
    const unique = Date.now();
    const personalName = `${TEST_NAME_PREFIX} Personal ${unique}`;
    const organizationName = `${TEST_NAME_PREFIX} Organization ${unique}`;
    const workspacesResponse = await page.request.get('/api/workspaces');
    const workspacesPayload = await workspacesResponse.json() as {
      workspaces?: Array<{ id: string; name: string; status: string }>;
    };
    expect(workspacesResponse.ok(), JSON.stringify(workspacesPayload)).toBeTruthy();
    const grantWorkspace = workspacesPayload.workspaces?.find((workspace) => workspace.status === 'active');
    expect(grantWorkspace).toBeDefined();

    await page.goto('/en/settings?tab=agent-settings');
    await expect(page.getByText('Agent Selection', { exact: true })).toBeVisible({ timeout: 30_000 });

    const createDialog = await openCreateAgentDialog(page);
    await expect(createDialog.getByTestId('agent-scope-picker')).toBeVisible();
    await expect(createDialog.getByRole('button', { name: /Organization/ })).toBeEnabled();
    await expect.poll(() => createDialog.evaluate((element) => (
      element.getAnimations().every((animation) => animation.playState === 'finished')
    ))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('task50-create-desktop.png'), fullPage: false });

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
    try {
      const mobilePage = await mobileContext.newPage();
      await login(mobilePage);
      await mobilePage.goto('/en/settings?tab=agent-settings');
      await expect(mobilePage.getByText('Agent Selection', { exact: true })).toBeVisible({ timeout: 30_000 });
      const mobileDialog = await openCreateAgentDialog(mobilePage);
      await expect(mobileDialog.getByTestId('agent-scope-picker')).toBeVisible();
      const mobileBox = await mobileDialog.boundingBox();
      expect(mobileBox).not.toBeNull();
      await mobilePage.screenshot({ path: testInfo.outputPath('task50-create-mobile.png'), fullPage: false });
      expect(mobileBox!.x).toBeGreaterThanOrEqual(0);
      expect(mobileBox!.y).toBeGreaterThanOrEqual(0);
      expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390);
      expect(mobileBox!.y + mobileBox!.height).toBeLessThanOrEqual(844);
      await expect.poll(() => mobileDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    } finally {
      await mobileContext.close();
    }

    await openCreateAgentDialog(page);
    await createDialog.getByLabel('Name').fill(personalName);
    await createDialog.getByRole('button', { name: /Only me/ }).click({ force: true });
    const personalCreation = waitForOwnedAgentCreation(page, personalName, 'user');
    await createDialog.getByRole('button', { name: 'Create agent', exact: true }).click({ force: true });
    await personalCreation;
    await expect(createDialog.getByTestId('personal-agent-created')).toBeVisible({ timeout: 30_000 });
    await createDialog.getByRole('button', { name: 'Done' }).click();

    const personalCard = agentCard(page, personalName);
    await expect(personalCard).toBeVisible();
    await expect(personalCard.getByText('Only me', { exact: true })).toBeVisible();
    await expect(personalCard.getByText(/^r\d+$/)).toHaveCount(0);

    await openCreateAgentDialog(page);
    await createDialog.getByLabel('Name').fill(organizationName);
    const organizationScope = createDialog.getByRole('button', { name: /Organization/ });
    await organizationScope.click({ force: true });
    await expect(organizationScope).toHaveAttribute('aria-pressed', 'true');
    const organizationCreation = waitForOwnedAgentCreation(page, organizationName, 'organization');
    await createDialog.getByRole('button', { name: 'Create agent', exact: true }).click({ force: true });
    await organizationCreation;

    await expect(page.getByText(organizationName, { exact: true })).toBeVisible({ timeout: 30_000 });
    // Finish the creation transition before using the selected agent's access editor.
    await expect(async () => {
      if (await createDialog.isVisible()) {
        await createDialog.getByRole('button', { name: 'Done' }).click({ timeout: 1_000 });
      }
      await expect(createDialog).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    const organizationCard = agentCard(page, organizationName);
    await expect(organizationCard.getByRole('button').filter({
      has: page.getByText(organizationName, { exact: true }),
    })).toHaveAttribute('aria-pressed', 'true');
    const grants = page.locator('main').getByTestId('agent-grants-editor');
    await expect(grants).toBeVisible();

    await grants.getByLabel('Grant target type').selectOption('workspace');
    const workspacePicker = grants.getByTestId('grant-target-workspace-picker');
    await workspacePicker.click();
    await page.getByPlaceholder('Search workspaces...').fill(grantWorkspace!.name);
    await page.getByTestId(`grant-target-workspace-picker-option-${grantWorkspace!.id}`).click();
    await expect(workspacePicker).toContainText(grantWorkspace!.name);
    await grants.getByRole('button', { name: 'Add' }).click();
    await expect(grants.getByText(grantWorkspace!.name, { exact: true })).toBeVisible();

    await grants.getByLabel('Grant target type').selectOption('role');
    const rolePicker = grants.getByTestId('grant-target-role-picker');
    await expect(rolePicker).toHaveAttribute('aria-label', 'Grant target role');
    await rolePicker.click();
    await expect(page.getByPlaceholder('Search roles...')).toHaveValue('');
    const memberOption = page.getByTestId('grant-target-role-picker-option-member');
    await expect(memberOption).toBeVisible();
    await memberOption.click();
    await expect(rolePicker).toContainText('Member');
    await grants.getByLabel('Grant access level').selectOption('user');
    await grants.getByRole('button', { name: 'Add' }).click();
    await expect(grants.getByText('Member', { exact: true })).toBeVisible();
    await expect(grants.getByText('Use', { exact: true })).toHaveCount(2);
    await grants.getByText('Member', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('task50-organization-grants.png'), fullPage: false });
    await expect(organizationCard).toBeVisible();
    await expect(organizationCard.getByText('Organization', { exact: true })).toBeVisible();
    await expect(page.getByTestId('agent-grants-editor').getByText('Member', { exact: true })).toBeVisible();

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
      await expect(toolRow.getByRole('switch')).toBeChecked();
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

  test('lets an assigned member use an organization agent without management access and removes it after revocation', async ({ browser, page }, testInfo) => {
    const unique = Date.now();
    const organizationName = `${TEST_NAME_PREFIX} Assigned ${unique}`;

    const createAgentResponse = await page.request.post('/api/agents', {
      data: {
        name: organizationName,
        scopeType: 'organization',
        iconId: 'bot',
      },
    });
    const organizationAgent = await registerCreatedAgent(createAgentResponse, organizationName, 'organization');
    const member = await provisionMember(page, organizationAgent);

    await page.goto('/en/settings?tab=agent-settings');
    await expect(page.getByText('Agent Selection', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByText(organizationName, { exact: true }).click();
    const grants = page.getByTestId('agent-grants-editor');
    await expect(grants).toBeVisible();
    await grants.getByLabel('Grant target type').selectOption('user');
    const userPicker = grants.getByTestId('grant-target-user-picker');
    await userPicker.click();
    await page.getByPlaceholder('Search users...').fill(member.email);
    await page.getByTestId(`grant-target-user-picker-option-${member.id}`).click();
    await expect(userPicker).not.toContainText('Select user');
    await grants.getByLabel('Grant access level').selectOption('user');
    await grants.getByRole('button', { name: 'Add' }).click();
    await expect(grants.getByText(member.id, { exact: true })).toBeVisible();
    await expect(grants.getByText(member.email, { exact: true })).toBeVisible();

    const memberContext = await browser.newContext();
    const ownedSessions = new Map<string, string>();
    let primaryError: unknown;
    const memberPage = await memberContext.newPage();
    try {
      const memberSession = await loginWithCredentials(memberPage, member.email, member.password);
      expect(memberSession.id).toBe(member.id);
      expect(memberSession.id).not.toBe(adminUserId);
      expect(memberSession.role).toBe('user');
      await completeMemberOnboarding(memberPage);

      const memberAgents = await listAgents(memberPage);
      const assignedAgent = memberAgents.find((agent) => agent.agentId === organizationAgent!.agentId);
      expect(assignedAgent).toMatchObject({
        scopeType: 'organization',
        access: { canUse: true, canEdit: false, canManage: false },
      });

      await memberPage.goto('/en/notebook?chat=open');
      const selector = memberPage.getByTestId('chat-agent-id');
      await expect(selector).toBeVisible({ timeout: 30_000 });
      await selector.click();
      const popover = memberPage.getByTestId('chat-agent-selector-popover');
      await expect(popover).toBeVisible();
      const assignedOption = popover.getByRole('button', { name: new RegExp(`${organizationName}\\s+${organizationAgent!.agentId}`, 'i') });
      await expect(assignedOption).toBeVisible();
      await expect(popover.getByRole('button', { name: `Edit ${organizationName}` })).toHaveCount(0);
      await expect.poll(() => popover.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await memberPage.screenshot({ path: testInfo.outputPath('task50-member-agent-access.png'), fullPage: false });
      await assignedOption.click();
      await expect(selector).toHaveAttribute('aria-label', new RegExp(organizationName));

      const browserStatusResponse = await memberPage.request.get(`/api/agents/browser?agentId=${encodeURIComponent(organizationAgent!.agentId)}`);
      expect(browserStatusResponse.ok(), `Browser status returned HTTP ${browserStatusResponse.status()}.`).toBe(true);

      const createSessionResponse = await memberPage.request.post('/api/sessions', {
        data: {
          agentId: organizationAgent!.agentId,
          title: `${TEST_NAME_PREFIX} member session`,
        },
      });
      const createSessionPayload = await createSessionResponse.json() as {
        code?: string;
        error?: string;
        session?: { sessionId?: string; agentId?: string; creator?: { email?: string | null } };
      };
      if (createSessionResponse.ok()) {
        const createdSession = createSessionPayload.session;
        if (typeof createdSession?.sessionId === 'string' && createdSession.sessionId
          && typeof createdSession.agentId === 'string' && ownedAgents.has(createdSession.agentId)) {
          ownedSessions.set(createdSession.sessionId, createdSession.agentId);
        }
        expect(typeof createdSession?.sessionId).toBe('string');
        expect(createdSession?.sessionId).toBeTruthy();
        expect(createSessionPayload.session?.agentId).toBe(organizationAgent!.agentId);
        expect(createSessionPayload.session?.creator?.email).toBe(member.email);
      } else {
        expect(createSessionPayload.code).toBe('RUNTIME_CATALOG_NOT_CONFIGURED');
        expect(createSessionPayload.code).not.toBe('AGENT_ACCESS_DENIED');
      }

      // Delete only sessions created by this request while the grant still exists.
      await cleanupOwnedSessions(memberPage, ownedSessions, member.id);

      const profileMutationResponse = await memberPage.request.patch('/api/agents', {
        data: {
          agentId: organizationAgent!.agentId,
          expectedRevision: assignedAgent!.revision,
          name: `${organizationName} changed`,
        },
      });
      expect(profileMutationResponse.status()).toBe(403);

      const grantMutationResponse = await memberPage.request.put('/api/agents/grants', {
        data: {
          agentId: organizationAgent!.agentId,
          expectedRevision: assignedAgent!.revision,
          targetType: 'role',
          targetId: 'member',
          canUse: true,
          canEdit: false,
          canManage: false,
        },
      });
      expect(grantMutationResponse.status()).toBe(403);

      const deletePreviewResponse = await memberPage.request.post('/api/agents/delete-preview', {
        data: { agentId: organizationAgent!.agentId },
      });
      expect(deletePreviewResponse.status()).toBe(403);

      await memberPage.goto('/en/settings?tab=agent-settings');
      await expect(memberPage.getByText('Agent Selection', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByText(organizationName, { exact: true })).toHaveCount(0);

      const currentAgent = (await listAgents(page)).find((agent) => agent.agentId === organizationAgent!.agentId);
      expect(currentAgent).toBeDefined();
      const revokeResponse = await page.request.delete('/api/agents/grants', {
        data: {
          agentId: organizationAgent!.agentId,
          expectedRevision: currentAgent!.revision,
          targetType: 'user',
          targetId: member.id,
        },
      });
      expect(revokeResponse.ok(), `Owned agent grant revocation returned HTTP ${revokeResponse.status()}.`).toBe(true);

      await expect.poll(async () => (await listAgents(memberPage)).some((agent) => agent.agentId === organizationAgent!.agentId)).toBe(false);
      const revokedBrowserStatusResponse = await memberPage.request.get(`/api/agents/browser?agentId=${encodeURIComponent(organizationAgent!.agentId)}`);
      expect(revokedBrowserStatusResponse.status()).toBe(403);
      await memberPage.goto('/en/notebook?chat=open');
      await expect(memberPage.getByTestId('chat-agent-id')).toBeVisible({ timeout: 30_000 });
      await memberPage.getByTestId('chat-agent-id').click();
      await expect(memberPage.getByTestId('chat-agent-selector-popover').getByText(organizationName, { exact: true })).toHaveCount(0);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try { await cleanupOwnedSessions(memberPage, ownedSessions, member.id); }
      catch (error) { cleanupErrors.push(error); }
      try { await memberContext.close(); }
      catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) {
        throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
          'Task 50 member context cleanup failed.');
      }
    }
  });
});
