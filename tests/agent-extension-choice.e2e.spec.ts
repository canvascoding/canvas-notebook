import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { AgentProfile } from '../app/lib/chat/types';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import en from '../messages/en.json';

// Real authenticated owner/member APIs and UI. No route interception, authority
// substitutes, model requests or provider business calls.
type Fixture = { version: 1; root: string; repo: string; nonce: string; actorId: string; baseURL: string; buildId: string };
type Inspection = { agent: AgentProfile; access: { canUse: boolean; canEdit: boolean; canManage: boolean };
  extensions: { configuration: AgentExtensionConfigurationInput | null; workflowRevision: number } };
let fixture: Fixture, owner: BrowserContext, member: BrowserContext, page: Page;
let ownerWorkspace = '', memberWorkspace = '', memberId = '', agentId = '', agentName = '', ownProfileId = '', ownProfileName = '';
let createdConfiguration: AgentExtensionConfigurationInput;
const runtimeErrors: string[] = [], mutationRequests: Array<{ path: string; method: string }> = [];
test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

async function json<T>(response: APIResponse, phase: string, status = 200): Promise<T> {
  expect(response.status(), `${phase}: HTTP status`).toBe(status);
  return response.json() as Promise<T>;
}
async function data<T>(response: APIResponse, phase: string, status = 200): Promise<T> {
  const body = await json<{ success: boolean; data: T }>(response, phase, status);
  expect(body.success, `${phase}: success`).toBe(true);
  return body.data;
}
function scoped(endpoint: string, workspaceId: string, query: Record<string, string> = {}) {
  return `${endpoint}?${new URLSearchParams({ workspaceId, ...query })}`;
}
async function workflow(context: BrowserContext, workspaceId: string) {
  return data<AgentWorkflowDescriptor>(await context.request.get(scoped('/api/agents/workflow', workspaceId, { agentId })), 'Actual actor workflow');
}
async function inspectOwner() {
  return data<Inspection>(await owner.request.get(scoped('/api/agents', ownerWorkspace, { agentId, purpose: 'configure', includeFiles: 'false' })), 'Actual owner configuration');
}
async function openChoice() {
  await page.goto(`/en?${new URLSearchParams({ workspaceId: memberWorkspace })}`, { waitUntil: 'domcontentloaded' });
  const homeEditor = page.getByRole('textbox', { name: en.home.start.aiPlaceholder, exact: true });
  await expect(homeEditor).toBeVisible();
  await homeEditor.focus();
  await page.getByTestId('home-agent-id').click();
  const available = page.getByTestId('chat-agent-selector-popover');
  await expect(available.getByRole('button', { name: new RegExp(agentName, 'u') }).first()).toBeVisible();
  const loaded = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/agents/workflow' && new URL(response.url()).searchParams.get('agentId') === agentId);
  await available.getByTestId(`chat-agent-workflow-${agentId}`).click();
  await expect(page.getByTestId('agent-workflow-dialog')).toBeVisible();
  expect((await loaded).status()).toBe(200);
  await expect(page.getByTestId('agent-workflow-choices').getByText(en.agentWorkflow.loading, { exact: true })).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.CANVAS_PLUGIN_EXTENSION_E2E).toBe('1');
  const fixturePath = process.env.PLUGIN_EXTENSION_E2E_FIXTURE;
  if (!fixturePath || !path.isAbsolute(fixturePath)) throw new Error('The isolated acceptance fixture is required.');
  const stat = await fs.lstat(fixturePath);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600).toBe(true);
  fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as Fixture;
  expect(fixture.version).toBe(1); expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u);
  expect(fixture.root).toBe(path.dirname(fixturePath)); expect(fixture.repo).toBe(await fs.realpath(process.cwd()));
  expect(fixture.baseURL).toBe('http://127.0.0.1:3001'); expect(fixture.buildId).toBe((await fs.readFile('.next/BUILD_ID', 'utf8')).trim());
  owner = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, extraHTTPHeaders: { Origin: fixture.baseURL } });
  await runManagedTestPreflight(owner, { baseURL: fixture.baseURL });
  const actualOwner = await json<{ user: { id: string; role: string } }>(await requestManagedTestSession(owner.request), 'Actual owner identity');
  expect(actualOwner.user.id).toBe(fixture.actorId); expect(actualOwner.user.role).toBe('admin');
  const ownerScopes = await json<{ organizationId: string; workspaces: Array<{ id: string; type: string; ownerUserId: string }> }>(await owner.request.get('/api/workspaces'), 'Actual owner workspaces');
  ownerWorkspace = ownerScopes.workspaces.find(value => value.type === 'personal' && value.ownerUserId === fixture.actorId)!.id;
  expect(ownerWorkspace).toBeTruthy();
  const password = process.env.TEST_SECONDARY_PASSWORD;
  if (!password) throw new Error('The existing private runner member credential is required.');
  const email = `agent-choice-${fixture.nonce}@example.test`;
  const proposal = await data<{ membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(
    await owner.request.post('/api/admin/organization/memberships', { data: { name: `Agent choice ${fixture.nonce.slice(0, 10)}`, email, role: 'member' } }),
    'Actual non-billable Agent member proposal', 202);
  expect(proposal.approval.required).toBe(false); expect(proposal.quote.nonBillable).toBe(true);
  const activated = await data<{ stage: string }>(await owner.request.post(`/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`,
    { data: { password } }), 'Actual Agent member activation'); expect(activated.stage).toBe('active');
  member = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, extraHTTPHeaders: { Origin: fixture.baseURL }, viewport: { width: 1280, height: 900 } }, { email, password });
  const actualMember = await json<{ user: { id: string; role: string } }>(await requestManagedTestSession(member.request), 'Actual ordinary member identity');
  memberId = actualMember.user.id; expect(memberId).not.toBe(fixture.actorId); expect(actualMember.user.role).not.toBe('admin');
  const memberScopes = await json<{ organizationId: string; workspaces: Array<{ id: string; type: string; ownerUserId: string }> }>(await member.request.get('/api/workspaces'), 'Actual member workspaces');
  expect(memberScopes.organizationId).toBe(ownerScopes.organizationId);
  memberWorkspace = memberScopes.workspaces.find(value => value.type === 'personal' && value.ownerUserId === memberId)!.id;
  expect(memberWorkspace).toBeTruthy();
  ownProfileName = `Agent choice profile ${fixture.nonce.slice(0, 10)}`;
  const createdProfile = await json<{ success: boolean; profile: { id: string; name: string } }>(await member.request.post(scoped('/api/composio/profiles', memberWorkspace),
    { data: { name: ownProfileName } }), 'Actual own member profile', 201);
  expect(createdProfile.success).toBe(true); expect(createdProfile.profile.name).toBe(ownProfileName); ownProfileId = createdProfile.profile.id;
  agentName = `Use only Agent ${fixture.nonce.slice(0, 10)}`;
  createdConfiguration = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [{ mode: 'selectable', configurationId: 'member-search',
    source: 'composio', toolkit: 'duckduckgo', requirement: 'required', allowedChoices: [],
    personalPolicy: { source: 'composio', toolkit: 'duckduckgo', toolCap: ['PUBLIC_FIND'] } }] };
  const created = await data<{ agent: AgentProfile }>(await owner.request.post(scoped('/api/agents', ownerWorkspace), { data: { name: agentName, scopeType: 'organization',
    extensions: createdConfiguration, grants: [{ targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false }] } }), 'Actual organization Agent with personal-choice rule');
  agentId = created.agent.agentId; expect(created.agent.scopeType).toBe('organization');
  const access = await data<Inspection>(await member.request.get(scoped('/api/agents', memberWorkspace, { agentId, purpose: 'use' })), 'Actual Use-only access');
  expect(access.access).toEqual({ canUse: true, canEdit: false, canManage: false });
  await member.addInitScript(({ workspaceId, origin }) => { if (location.origin === origin) localStorage.setItem('canvas.activeWorkspaceId', workspaceId); },
    { workspaceId: memberWorkspace, origin: fixture.baseURL });
  page = await member.newPage(); page.on('pageerror', error => runtimeErrors.push(error.name));
  page.on('request', request => { const address = new URL(request.url());
    if (address.origin === fixture.baseURL && ['PATCH', 'POST', 'PUT', 'DELETE'].includes(request.method()) && address.pathname.startsWith('/api/agents'))
      mutationRequests.push({ path: address.pathname, method: request.method() });
  });
});

test.afterEach(async ({}, info) => {
  if (page && info.status !== info.expectedStatus) await page.screenshot({ path: path.join(fixture.root, `agent-choice-failure-${info.line}.png`), fullPage: true });
  if (fixture) await fs.writeFile(path.join(fixture.root, 'agent-choice-browser-proof.json'), JSON.stringify({ version: 1, nonce: fixture.nonce,
    agentId, memberId, mutationRequests, runtimeErrors }), { mode: 0o600 });
});
test.afterAll(async () => {
  if (ownProfileId && member) {
    const removed = await json<{ success: boolean }>(await member.request.delete(scoped(`/api/composio/profiles/${encodeURIComponent(ownProfileId)}`, memberWorkspace)), 'Archive own nonce profile');
    expect(removed.success).toBe(true);
  }
  await member?.close(); await owner?.close();
});

test('a real ordinary member selects a personal connection with Use only, while configuration and another user preference stay unchanged', async () => {
  const original = await inspectOwner(), ownerChoice = await workflow(owner, ownerWorkspace), memberChoice = await workflow(member, memberWorkspace);
  expect(memberChoice.access).toEqual({ canUse: true, canEdit: false, canManage: false });
  expect(memberChoice.standalone?.[0].selectionOrigin).toBe('missing');
  expect((await member.request.get(scoped('/api/agents', memberWorkspace, { agentId, purpose: 'configure' }))).status()).toBe(403);
  expect((await member.request.patch(scoped('/api/agents', memberWorkspace), { data: { agentId, expectedRevision: original.agent.revision, name: 'Unauthorized edit' } })).status()).toBe(403);
  await openChoice();
  const dialog = page.getByTestId('agent-workflow-dialog'); await expect(dialog.getByTestId('agent-workflow-required-setup')).toBeVisible();
  await dialog.getByRole('button', { name: 'Set up my connection', exact: true }).click();
  await dialog.getByRole('button', { name: new RegExp(ownProfileName, 'u') }).click();
  await expect(dialog.getByTestId('agent-workflow-required-setup')).toBeVisible();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/workflow' && response.request().method() === 'PATCH');
  await dialog.getByRole('button', { name: 'Use without sign-in', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog.getByTestId('agent-workflow-required-setup')).toHaveCount(0);
  const current = await workflow(member, memberWorkspace), slot = current.standalone![0];
  expect(current.preferenceRevision).toBe(memberChoice.preferenceRevision + 1); expect(current.workflowRevision).toBe(memberChoice.workflowRevision);
  expect(slot.selectionOrigin).toBe('user'); expect(slot.selectedSelection).toMatchObject({ kind: 'composio', toolkit: 'duckduckgo', target: { kind: 'personal', profileId: ownProfileId, accountBinding: 'no_auth' } });
  const retained = await inspectOwner(); expect(retained.agent.revision).toBe(original.agent.revision); expect(retained.extensions.configuration).toEqual(original.extensions.configuration);
  const ownerAfter = await workflow(owner, ownerWorkspace); expect(ownerAfter.preferenceRevision).toBe(ownerChoice.preferenceRevision);
  expect(ownerAfter.standalone![0].selectionOrigin).toBe('missing'); expect(JSON.stringify(ownerAfter)).not.toContain(ownProfileId);
  await openChoice(); await expect(page.getByTestId('agent-workflow-required-setup')).toHaveCount(0);
  await expect(page.getByTestId('agent-workflow-dialog')).toContainText(en.agentWorkflow.currentPersonal);
  expect(runtimeErrors).toEqual([]); expect(mutationRequests.filter(value => value.path === '/api/agents/workflow' && value.method === 'PATCH')).toHaveLength(1);
});

test('a genuine central revision change makes the personal choice stale, rejects its old CAS and leaves the connection inactive', async () => {
  const before = await workflow(member, memberWorkspace), ownerBefore = await inspectOwner();
  const updated = structuredClone(createdConfiguration);
  if (updated.mode !== 'fixed' || updated.standalone[0].mode !== 'selectable' || !updated.standalone[0].personalPolicy) throw new Error('The exact selectable fixture is required.');
  updated.standalone[0].personalPolicy.toolCap = [];
  const replacement = await data<{ agent: AgentProfile }>(await owner.request.patch(scoped('/api/agents', ownerWorkspace), { data: { agentId,
    expectedRevision: ownerBefore.agent.revision, expectedWorkflowRevision: ownerBefore.extensions.workflowRevision, extensions: updated } }), 'Actual central policy replacement');
  expect(replacement.agent.workflowRevision).toBeGreaterThan(before.workflowRevision);
  const oldSelection = before.standalone![0].selectedSelection!;
  expect((await member.request.patch(scoped('/api/agents/workflow', memberWorkspace), { data: { agentId, capabilityKey: before.standalone![0].capabilityKey,
    expectedWorkflowRevision: before.workflowRevision, expectedPreferenceRevision: before.preferenceRevision,
    standaloneSelection: { selection: oldSelection, requirement: 'required', toolCap: ['PUBLIC_FIND'] } } })).status()).toBe(409);
  await openChoice(); await expect(page.getByTestId('agent-workflow-required-setup')).toBeVisible();
  await expect(page.getByText('Selection needs confirmation', { exact: true })).toBeVisible();
  const current = await workflow(member, memberWorkspace); expect(current.standalone![0].selectionOrigin).toBe('stale');
  expect(current.standalone![0].selectedConnection).toBeUndefined(); expect(runtimeErrors).toEqual([]);
});
