import { randomBytes } from 'node:crypto';
import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { ClientWorkspaceResponse, ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import type { WorkspaceMemberRecord } from '../app/lib/workspaces/contracts';
import type { OrganizationPolicyTargetCatalog } from '../app/lib/organization/policy-targets';

type Agent = {
  agentId: string; name: string; revision: number; type: string; scopeType: 'user' | 'organization' | 'system';
  organizationId: string | null; ownerUserId: string | null; createdByUserId: string | null;
  relevantConnections: string[] | null; relevantSkills: string[] | null;
};
type Access = { canUse: boolean; canEdit: boolean; canManage: boolean };
type Inspection = { agent: Agent; access: Access; bindings: Array<{ name: string; resourceId: string; resourceType: string; revision: number }>; grants?: unknown[] };
type Receipt = { context: BrowserContext; creatorId: string; agent: Agent; snapshot?: Inspection };
const nonce = randomBytes(5).toString('hex');
const owned = new Map<string, Receipt>();
let admin: BrowserContext;
let member: BrowserContext;
let adminId = '';
let memberId = '';
let memberWorkspaceId = '';
let organizationId = '';
let useOnly: Agent;
let raced: Agent;
let teamAgent: Agent;
let personal: Agent;
let projectTarget: { projectId: string; name: string } | undefined;
let ownedTeam: { workspace: ClientWorkspaceSummary; members: WorkspaceMemberRecord[] } | undefined;

test.use({ trace: 'off', video: 'off' });

async function payload<T>(response: Pick<APIResponse, 'ok' | 'status' | 'json'>, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}

async function inspect(receipt: Receipt): Promise<Inspection> {
  return (await payload<{ data: Inspection }>(await receipt.context.request.get(`/api/agents?agentId=${encodeURIComponent(receipt.agent.agentId)}&includeAccess=true`), 'Owned agent inspection')).data;
}

function configuration(value: Inspection) {
  return { agent: value.agent, bindings: value.bindings, grants: value.grants };
}

async function retain(agent: Agent, context: BrowserContext, creatorId: string): Promise<Agent> {
  expect(agent.createdByUserId).toBe(creatorId);
  expect(agent.type).not.toBe('main');
  const receipt = { context, creatorId, agent };
  owned.set(agent.agentId, receipt);
  receipt.agent = (await inspect(receipt)).agent;
  owned.set(agent.agentId, { ...receipt, snapshot: await inspect(receipt) });
  return receipt.agent;
}

async function createAgent(context: BrowserContext, creatorId: string, label: string, scopeType: 'user' | 'organization', grants: unknown[] = []): Promise<Agent> {
  const name = `Workflow Foundation QA ${nonce} ${label}`;
  const data = await payload<{ data: Inspection }>(await context.request.post('/api/agents', {
    data: { name, scopeType, enabledTools: ['__none__'], relevantSkills: [], relevantConnections: [], grants },
  }), 'Own agent creation');
  const agent = data.data.agent;
  owned.set(agent.agentId, { context, creatorId, agent });
  expect(agent.name).toBe(name); expect(agent.scopeType).toBe(scopeType); expect(agent.createdByUserId).toBe(creatorId);
  expect(agent.ownerUserId).toBe(scopeType === 'user' ? creatorId : null);
  return retain(agent, context, creatorId);
}

async function remember(agent: Agent) {
  const receipt = owned.get(agent.agentId); expect(receipt).toBeDefined();
  expect(agent.createdByUserId).toBe(receipt!.creatorId);
  expect(agent.scopeType).toBe(receipt!.agent.scopeType); expect(agent.ownerUserId).toBe(receipt!.agent.ownerUserId);
  receipt!.agent = agent;
  receipt!.snapshot = await inspect(receipt!);
  expect(receipt!.snapshot.agent.revision).toBe(agent.revision);
}

async function openSelector(page: Page) {
  await page.goto(`/en/notebook?chat=open&workspaceId=${encodeURIComponent(memberWorkspaceId)}`, { waitUntil: 'domcontentloaded' });
  const trigger = page.getByTestId('chat-agent-id');
  await expect(trigger).toBeVisible({ timeout: 30_000 }); await expect(trigger).toBeEnabled();
  await trigger.click();
  const selector = page.getByTestId('chat-agent-selector-popover');
  await expect(selector).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('chat-agent-selector-skeleton')).toHaveCount(0, { timeout: 30_000 });
  await expect(selector.getByRole('button').filter({ hasText: useOnly.name })).toBeVisible();
  return selector;
}

async function cleanup() {
  const failures: string[] = [];
  for (const [id, receipt] of [...owned]) {
    try {
      const current = await inspect(receipt);
      expect(current.agent).toMatchObject({ agentId: id, name: receipt.agent.name, createdByUserId: receipt.creatorId,
        scopeType: receipt.agent.scopeType, ownerUserId: receipt.agent.ownerUserId, organizationId: receipt.agent.organizationId, revision: receipt.agent.revision });
      expect(current.agent.type).not.toBe('main');
      if (receipt.snapshot) expect(configuration(current)).toEqual(configuration(receipt.snapshot));
      const sessions = await payload<{ sessions: Array<{ sessionId: string }> }>(await receipt.context.request.get(`/api/sessions?agentId=${encodeURIComponent(id)}`), 'Own agent session guard');
      expect(sessions.sessions, 'A foreign session must preserve this fixture agent.').toHaveLength(0);
      const preview = (await payload<{ data: { agent: Agent; confirmationToken: string } }>(await receipt.context.request.post('/api/agents/delete-preview', { data: { agentId: id } }), 'Own delete preview')).data;
      expect(preview.agent).toMatchObject({ agentId: id, name: receipt.agent.name, createdByUserId: receipt.creatorId,
        scopeType: receipt.agent.scopeType, ownerUserId: receipt.agent.ownerUserId, revision: receipt.agent.revision });
      await payload(await receipt.context.request.delete('/api/agents', { data: { agentId: id, expectedRevision: receipt.agent.revision, confirmationToken: preview.confirmationToken } }), 'Own agent deletion');
      owned.delete(id);
    } catch { failures.push(`agent ${id}`); }
  }
  if (ownedTeam) {
    try {
      if (owned.size) throw new Error('Preserve own team while any owned agent cleanup is unresolved.');
      const listing = await payload<ClientWorkspaceResponse>(await admin.request.get('/api/workspaces'), 'Own team cleanup listing');
      const current = listing.workspaces?.find(workspace => workspace.id === ownedTeam!.workspace.id);
      expect(current, 'Exact team snapshot guard, not a version CAS.').toEqual(ownedTeam.workspace);
      const memberships = (await payload<{ members: WorkspaceMemberRecord[] }>(await admin.request.get(`/api/workspaces/${encodeURIComponent(ownedTeam.workspace.id)}/members`), 'Own team membership guard')).members;
      expect(memberships).toEqual(ownedTeam.members);
      expect(memberships.find(entry => entry.userId === adminId)).toMatchObject({ role: 'admin', status: 'active', canManage: true });
      await payload(await admin.request.delete(`/api/workspaces/${encodeURIComponent(ownedTeam.workspace.id)}`), 'Own team soft disable');
      const after = await payload<ClientWorkspaceResponse>(await admin.request.get('/api/workspaces'), 'Own team cleanup verification');
      expect(after.workspaces?.some(workspace => workspace.id === ownedTeam!.workspace.id && workspace.status === 'active')).toBe(false);
      ownedTeam = undefined;
    } catch { failures.push('owned team'); }
  }
  await member?.close(); await admin?.close();
  if (failures.length) throw new Error(`Foundation cleanup preserved changed resources: ${failures.join(', ')}.`);
}

test.describe('Agent workflow foundation through the actual managed UI/API', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.beforeAll(async ({ browser }) => {
    expect(process.env.E2E_EXTERNAL_SERVER).toBe('1');
    const base = new URL(process.env.BASE_URL ?? '');
    expect(['localhost', '127.0.0.1']).toContain(base.hostname); expect(base.port).toBe('3001');
    const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    expect(Boolean(email && password), 'Existing member credentials are required; the suite never provisions users.').toBe(true);
    admin = await createAuthenticatedContext(browser, { baseURL: base.toString(), viewport: { width: 1280, height: 850 } });
    await runManagedTestPreflight(admin, { baseURL: base.toString() });
    const owner = await payload<{ user: { id: string; role: string } }>(await requestManagedTestSession(admin.request), 'Admin session');
    expect(owner.user.role).toBe('admin'); adminId = owner.user.id;
    member = await createAuthenticatedContext(browser, { baseURL: base.toString(), viewport: { width: 1280, height: 850 } }, { email, password });
    await runManagedTestPreflight(member, { baseURL: base.toString() });
    const secondary = await payload<{ user: { id: string; role: string } }>(await requestManagedTestSession(member.request), 'Member session');
    expect(secondary.user.role).toBe('user'); expect(secondary.user.id).not.toBe(adminId); memberId = secondary.user.id;
    const memberWorkspaces = await payload<ClientWorkspaceResponse>(await member.request.get('/api/workspaces'), 'Member workspaces');
    expect(memberWorkspaces.defaultWorkspace?.type).toBe('personal'); memberWorkspaceId = memberWorkspaces.defaultWorkspace!.id;
    useOnly = await createAgent(admin, adminId, 'Use only', 'organization', [{ targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false }]);
    organizationId = useOnly.organizationId!; expect(organizationId).toBeTruthy();
    const targetCatalog = (await payload<{ data: { targets: OrganizationPolicyTargetCatalog } }>(await admin.request.get(`/api/agents/grants?agentId=${encodeURIComponent(useOnly.agentId)}`), 'Existing grant target catalog')).data.targets;
    expect(targetCatalog.users.find(user => user.userId === memberId)?.role).toMatch(/^(member|external)$/u);
    const accessibleProjects = new Set(memberWorkspaces.workspaces?.map(workspace => workspace.projectId).filter(Boolean));
    projectTarget = targetCatalog.projects.find(project => !accessibleProjects.has(project.projectId)
      && (!process.env.TEST_INACCESSIBLE_PROJECT_ID || project.projectId === process.env.TEST_INACCESSIBLE_PROJECT_ID));
    if (process.env.TEST_INACCESSIBLE_PROJECT_ID) expect(projectTarget, 'Requested project must be an actual active same-org manager catalog target.').toBeDefined();
    const createdTeam = (await payload<{ workspace: ClientWorkspaceSummary }>(await admin.request.post('/api/workspaces', {
      data: { type: 'team', name: `Workflow Foundation QA ${nonce}`, description: `Owned foundation fixture ${nonce}` },
    }), 'Own team creation')).workspace;
    ownedTeam = { workspace: createdTeam, members: [] };
    expect(createdTeam).toMatchObject({ type: 'team', status: 'active', isDefault: false, organizationId });
    ownedTeam.members = (await payload<{ members: WorkspaceMemberRecord[] }>(await admin.request.get(`/api/workspaces/${encodeURIComponent(createdTeam.id)}/members`), 'Own team creator proof')).members;
    expect(ownedTeam.members).toHaveLength(1); expect(ownedTeam.members[0]).toMatchObject({ userId: adminId, role: 'admin', status: 'active', canManage: true });
    expect((await payload<ClientWorkspaceResponse>(await member.request.get('/api/workspaces'), 'Inaccessible own team check')).workspaces?.some(workspace => workspace.id === createdTeam.id)).toBe(false);
    teamAgent = await createAgent(admin, adminId, 'Team binding', 'organization', [{ targetType: 'workspace', targetId: createdTeam.id, canUse: true, canEdit: true, canManage: true }]);
    raced = await createAgent(admin, adminId, 'Concurrent save', 'organization');
    personal = await createAgent(member, memberId, 'Personal owner', 'user');
  });
  test.afterAll(cleanup);

  test('shows a use-only organization agent without edit controls and rejects real configuration HTTP writes', async ({}, info) => {
    const listed = (await payload<{ data: { agents: Array<Agent & { access: Access }> } }>(await member.request.get('/api/agents'), 'Member agent list')).data.agents.find(agent => agent.agentId === useOnly.agentId);
    expect(listed?.access).toEqual({ canUse: true, canEdit: false, canManage: false });
    const page = await member.newPage();
    for (const [width, theme] of [[1280, 'light'], [390, 'dark']] as const) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto('/en/notebook', { waitUntil: 'domcontentloaded' });
      await page.evaluate(value => localStorage.setItem('theme', value), theme);
      const selector = await openSelector(page);
      await expect(selector.getByRole('button', { name: `Edit ${useOnly.name}`, exact: true })).toHaveCount(0);
      await expect(selector).toBeInViewport({ ratio: 1 });
      expect(await selector.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`use-only-${width}-${theme}.png`), fullPage: false, animations: 'disabled' });
    }
    const receipt = owned.get(useOnly.agentId)!;
    const before = configuration(await inspect(receipt));
    const deniedCapabilities = await member.request.patch('/api/agents', { data: { agentId: useOnly.agentId, expectedRevision: useOnly.revision,
      relevantSkills: [], relevantConnections: [`denied-${nonce}`], capabilities: [] } });
    expect(deniedCapabilities.status()).toBe(403); expect((await deniedCapabilities.json()).code).toBe('AGENT_ACCESS_DENIED');
    for (const method of ['put', 'delete'] as const) {
      const response = await member.request[method]('/api/agents/grants', { data: { agentId: useOnly.agentId, expectedRevision: useOnly.revision,
        targetType: 'user', targetId: memberId, canUse: true, canEdit: true, canManage: true } });
      expect(response.status()).toBe(403); expect((await response.json()).code).toBe('AGENT_ACCESS_DENIED');
    }
    expect(configuration(await inspect(receipt))).toEqual(before);
    await page.close();
  });

  test('commits one of two equal-revision capability saves with an identical profile and binding winner', async () => {
    const labels = [`workflow-${nonce}-one`, `workflow-${nonce}-two`];
    const responses = await Promise.all(labels.map(name => admin.request.patch('/api/agents', { data: { agentId: raced.agentId, expectedRevision: raced.revision,
      relevantSkills: [], relevantConnections: [name], capabilities: [] } })));
    expect(responses.map(response => response.status()).sort()).toEqual([200, 409]);
    const winnerIndex = responses.findIndex(response => response.status() === 200);
    const winner = (await payload<{ data: { agent: Agent } }>(responses[winnerIndex], 'Capability CAS winner')).data.agent;
    expect(winner.revision).toBe(raced.revision + 1); expect(winner.relevantConnections).toEqual([labels[winnerIndex]]);
    expect((await responses[1 - winnerIndex].json()).code).toBe('AGENT_REVISION_CONFLICT');
    await remember(winner); raced = winner;
    const current = await inspect(owned.get(raced.agentId)!);
    expect(current.agent.relevantConnections).toEqual(winner.relevantConnections);
    expect(current.bindings.map(binding => binding.name)).toEqual(winner.relevantConnections);
    expect(current.bindings.map(binding => binding.resourceId)).toEqual([`connection:${labels[winnerIndex]}`]);
  });

  test('rejects a forged inaccessible team context and uses actual membership rights after explicit assignment', async () => {
    const receipt = owned.get(teamAgent.agentId)!;
    const before = configuration(await inspect(receipt));
    const query = new URLSearchParams({ organizationId, workspaceId: ownedTeam!.workspace.id });
    const denied = await member.request.patch(`/api/agents?${query}`, { data: { agentId: teamAgent.agentId, expectedRevision: teamAgent.revision,
      relevantSkills: [], relevantConnections: [`forged-team-${nonce}`], capabilities: [] } });
    expect(denied.status()).toBe(403); expect((await denied.json()).code).toBe('AGENT_ACTOR_CONTEXT_DENIED');
    const deniedGrant = await member.request.put(`/api/agents/grants?${query}`, { data: { agentId: teamAgent.agentId, expectedRevision: teamAgent.revision,
      targetType: 'user', targetId: memberId, canUse: true, canManage: true } });
    expect(deniedGrant.status()).toBe(403); expect((await deniedGrant.json()).code).toBe('AGENT_ACTOR_CONTEXT_DENIED');
    expect(configuration(await inspect(receipt))).toEqual(before);
    await payload(await admin.request.post(`/api/workspaces/${encodeURIComponent(ownedTeam!.workspace.id)}/members`, { data: { userId: memberId, role: 'member', canRead: true, canWrite: false, canManage: false } }), 'Explicit membership in own team');
    ownedTeam!.members = (await payload<{ members: WorkspaceMemberRecord[] }>(await admin.request.get(`/api/workspaces/${encodeURIComponent(ownedTeam!.workspace.id)}/members`), 'Own team membership receipt')).members;
    expect(ownedTeam!.members).toHaveLength(2); expect(ownedTeam!.members.find(entry => entry.userId === memberId)).toMatchObject({ status: 'active', canRead: true, canWrite: false, canManage: false });
    const allowed = (await payload<{ data: Inspection }>(await member.request.get(`/api/agents?${query}&agentId=${encodeURIComponent(teamAgent.agentId)}`), 'Actual member scope inspection')).data;
    expect(allowed.access).toEqual({ canUse: true, canEdit: true, canManage: true });
    const changed = (await payload<{ data: { agent: Agent } }>(await member.request.patch(`/api/agents?${query}`, { data: { agentId: teamAgent.agentId,
      expectedRevision: teamAgent.revision, relevantSkills: [], relevantConnections: [`legitimate-team-${nonce}`], capabilities: [] } }), 'Legitimate scoped capability update')).data.agent;
    await remember(changed); teamAgent = changed;
  });

  test('rejects a supplied actual inaccessible same-org project ID', async () => {
    test.skip(!projectTarget, 'No actual active inaccessible project in the manager catalog; no project creation or feature mutation is permitted. Native real-project coverage is separate.');
    const receipt = owned.get(useOnly.agentId)!;
    const before = configuration(await inspect(receipt));
    const query = new URLSearchParams({ organizationId, projectId: projectTarget!.projectId });
    const response = await member.request.patch(`/api/agents?${query}`, { data: { agentId: useOnly.agentId, expectedRevision: useOnly.revision,
      relevantSkills: [], relevantConnections: [`forged-project-${nonce}`], capabilities: [] } });
    expect(response.status()).toBe(403); expect((await response.json()).code).toBe('AGENT_ACTOR_CONTEXT_DENIED');
    expect(configuration(await inspect(receipt))).toEqual(before);
  });

  test('retains personal owner management through the real edit dialog', async ({}, info) => {
    const current = (await payload<{ data: Inspection }>(await member.request.get(`/api/agents?agentId=${encodeURIComponent(personal.agentId)}`), 'Personal owner rights')).data;
    expect(current.access).toEqual({ canUse: true, canEdit: true, canManage: true });
    const page = await member.newPage();
    const selector = await openSelector(page);
    const option = selector.getByRole('button').filter({ hasText: personal.name }); await expect(option).toBeVisible(); await option.hover();
    await selector.getByRole('button', { name: `Edit ${personal.name}`, exact: true }).click();
    const dialog = page.getByTestId('edit-agent-dialog'); await expect(dialog).toBeVisible();
    const name = dialog.getByRole('textbox', { name: 'Name', exact: true }); await expect(name).toHaveValue(personal.name);
    const updatedName = `Workflow Foundation QA ${nonce} Personal edited`; await name.fill(updatedName);
    const save = dialog.getByRole('button', { name: 'Save changes', exact: true }); await expect(save).toBeEnabled({ timeout: 30_000 });
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'PATCH'
      && response.request().postDataJSON()?.agentId === personal.agentId);
    await save.click();
    const changed = (await payload<{ data: { agent: Agent } }>(await saved, 'Actual personal edit save')).data.agent;
    expect(changed.name).toBe(updatedName); expect(changed.ownerUserId).toBe(memberId); expect(changed.revision).toBeGreaterThan(personal.revision);
    await remember(changed); personal = changed;
    await expect(dialog).toBeHidden();
    await page.getByTestId('chat-agent-id').click();
    const reopened = page.getByTestId('chat-agent-selector-popover');
    await expect(reopened.getByRole('button').filter({ hasText: updatedName })).toBeVisible();
    await expect(reopened.getByRole('button', { name: `Edit ${updatedName}`, exact: true })).toBeAttached();
    await page.screenshot({ path: info.outputPath('personal-owner-edit-1280-light.png'), fullPage: false, animations: 'disabled' });
    await page.close();
  });
});
