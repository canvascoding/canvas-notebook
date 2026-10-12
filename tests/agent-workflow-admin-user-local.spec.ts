import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AgentWorkflowConfiguration, AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { AgentWorkflowManagement } from '../app/lib/agents/workflow-management-contracts';
import type { AgentWorkflowPersonalOptions } from '../app/lib/agents/workflow-personal-options';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedRevision, CapabilityPackageState } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { IntegrationConnectionDescriptor, IntegrationConnectionGrantInput } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceResponse, ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

type Fixture = { version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; databaseName: string; createAcknowledged: boolean; phase: string; serverPid: number; actorId: string; listenerVerified: boolean };
type Inspection = { agent: AgentProfile; bindings: unknown[]; grants?: unknown[]; access: { canUse: boolean; canEdit: boolean; canManage: boolean } };
type Publication = { state: CapabilityPackageState; published: CapabilityPackagePublishedRevision };
type ToolsState = { config: { agentId: string; enabledTools: string[] | null }; tools: Array<{ name: string }> };
type BrowserReceipt = { version: 1; nonce: string; actorId: string; actorIds: string[]; phase: string; outstanding: string | null;
  closedContexts: boolean; agents: AgentProfile[]; packages: Array<{ resource: CapabilityResourceDescriptor; published: { resourceRef: string; revisionRef: string; version: string; checksum: string } }>;
  connections: IntegrationConnectionDescriptor[]; membershipIds: string[]; workspaceIds: string[]; forbiddenWrites: string[];
  watchSubscriptions: Array<{ workspaceId: string; status: number }>;
  workflowWrites: number; ownChoiceWrites: number; readScopes: Array<{ surface: string; workspaceId: string | null; organizationId: string | null; projectId: string | null }>;
  settingsWorkspaceObservations: Array<{ seededPersonalId: string; persistedActiveId: string | null; requestedTeamId: string }> };
let fixture: Fixture, receipt: BrowserReceipt, receiptPath = '';
let admin: BrowserContext, member: BrowserContext, editor: BrowserContext;
let adminId = '', memberId = '', editorId = '', organizationId = '', personalMemberId = '', teamId = '';
let agent: AgentProfile, expectedAgent: Inspection, pkg: CapabilityResourceDescriptor, publication: Publication;
let organizationConnection: IntegrationConnectionDescriptor, teamConnection: IntegrationConnectionDescriptor;
let defaults: { inspection: Inspection; config: ToolsState['config'] };
let initialConfiguration: AgentWorkflowConfiguration;
const pages = new Set<Page>();
const watcherRequests = new Set<Request>();
const ui = en.agentWorkflowManagement, own = en.agentWorkflow;
const toolName = 'canva_find_designs', personalToolName = 'CANVA_LIST_DESIGNS';
const nativeTools = ['mcp', 'email_list_mailboxes'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const query = (workspaceId = teamId) => new URLSearchParams({ workspaceId, organizationId });
const agentsPath = (workspaceId = teamId) => `/api/agents?${query(workspaceId)}`;
const workflowPath = (extra: Record<string, string> = {}, workspaceId = teamId) => `/api/agents/workflow?${new URLSearchParams({ ...Object.fromEntries(query(workspaceId)), agentId: agent.agentId, ...extra })}`;
const resourcePath = (ref = pkg.metadata.resourceRef) => `/api/capabilities/resources/${encodeURIComponent(ref)}?${query()}`;
const packagePath = (ref = pkg.metadata.resourceRef) => `/api/capabilities/packages/${encodeURIComponent(ref)}?${query()}`;
const connectionPath = (value: IntegrationConnectionDescriptor) => `/api/integrations/shared-connections/${encodeURIComponent(value.resource.connectionRef)}?${query()}`;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function data<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  if (response.status() !== status) {
    const rejected = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof rejected?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(rejected.code) ? rejected.code : 'UNCLASSIFIED';
    console.log(`OWN_WORKFLOW_REJECTION ${JSON.stringify({ phase, status: response.status(), code })}`);
  }
  expect(response.status(), `${phase} must be acknowledged by the actual endpoint.`).toBe(status);
  const payload = await response.json() as { success?: boolean; data?: T };
  expect(payload.success).toBe(true); expect(payload.data).toBeDefined(); return payload.data!;
}
async function persist(): Promise<void> {
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await fs.rename(temporary, receiptPath);
}
async function startWrite(label: string): Promise<void> { expect(receipt.outstanding).toBeNull(); receipt.outstanding = label; await persist(); }
async function finishWrite(): Promise<void> { receipt.outstanding = null; await persist(); }
async function inspect(): Promise<Inspection> {
  return data(await admin.request.get(`/api/agents?${new URLSearchParams({ ...Object.fromEntries(query()), agentId: agent.agentId, includeAccess: 'true' })}`), 'Exact acknowledged agent inspection');
}
async function rememberAgent(): Promise<void> {
  expectedAgent = await inspect(); agent = expectedAgent.agent;
  expect(agent.createdByUserId).toBe(adminId); expect(agent.scopeType).toBe('organization');
  expect(agent.name).toBe(`Workflow acceptance ${fixture.nonce}`); expect(agent.type).not.toBe('main');
  receipt.agents = [agent]; await persist();
}
async function readManagement(context = admin): Promise<AgentWorkflowManagement> {
  const result = await data<AgentWorkflowManagement>(await context.request.get(workflowPath({ view: 'management' })), 'Current central management read');
  expect(result.agentId).toBe(agent.agentId); safe(result); return result;
}
async function readWorkflow(): Promise<AgentWorkflowDescriptor> {
  const result = await data<AgentWorkflowDescriptor>(await member.request.get(workflowPath()), 'Current member workflow read');
  expect(result.agentId).toBe(agent.agentId); safe(result); return result;
}
function safe(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of ['personalBinding', 'bindingFingerprint', 'boundProviderRef', 'profileId', 'composioUserId', 'connectedAccountId', 'apiKey', 'rootPath', 'installDir']) {
    expect(serialized).not.toMatch(new RegExp(`"${key}"\\s*:`, 'u'));
  }
}
async function currentResource(): Promise<CapabilityResourceDescriptor> {
  return (await data<{ resource: CapabilityResourceDescriptor }>(await admin.request.get(resourcePath()), 'Own package authority receipt')).resource;
}
async function currentConnection(value: IntegrationConnectionDescriptor): Promise<IntegrationConnectionDescriptor> {
  return (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.get(connectionPath(value)), 'Own connection authority receipt')).connection;
}
function grantInput(value: IntegrationConnectionDescriptor): IntegrationConnectionGrantInput[] {
  expect(value.grants).toBeDefined();
  return value.grants!.map(({ targetType, targetId, canUse, canManage, allowedToolNames }) => ({ targetType, targetId, canUse, canManage, allowedToolNames }));
}
async function centralSnapshot() {
  return { inspection: await inspect(), resource: await currentResource(), connections: [await currentConnection(organizationConnection), await currentConnection(teamConnection)] };
}
function slot(descriptor: AgentWorkflowDescriptor) {
  const value = descriptor.packages.flatMap(value => value.declarations.flatMap(declaration => declaration.capabilities)).find(value => value.capabilityId === 'selectable-design');
  expect(value).toBeDefined(); return value!;
}
function capability(dialog: Locator, id: string): Locator {
  return dialog.getByTestId('workflow-management-capability').filter({ has: dialog.page().getByText(id, { exact: true }) });
}
function ownSelect(dialog: Locator): Locator { return dialog.getByRole('combobox', { name: own.connectionFor.replace('{application}', 'canva'), exact: true }); }
function selector(page: Page): Locator {
  return page.getByRole('button').filter({ hasText: agent.name }).filter({ has: page.getByText(agent.agentId, { exact: true }) });
}
function assertScope(response: Response, surface: string, workspaceId = teamId): void {
  const url = new URL(response.url());
  expect(url.searchParams.get('workspaceId')).toBe(workspaceId); expect(url.searchParams.get('organizationId')).toBe(organizationId);
  expect(url.searchParams.has('projectId')).toBe(false); expect(url.searchParams.has('actorId')).toBe(false);
  receipt.readScopes.push({ surface, workspaceId: url.searchParams.get('workspaceId'), organizationId: url.searchParams.get('organizationId'), projectId: url.searchParams.get('projectId') });
}
async function hydrate(page: Page, url: string, context: BrowserContext): Promise<void> {
  const listing = await context.request.get('/api/workspaces'); expect(listing.status()).toBe(200);
  const actual = await listing.json() as ClientWorkspaceResponse;
  expect(actual.teamFeaturesEnabled).toBe(true); expect(actual.workspaces?.some(value => value.id === teamId && value.permissions.canRead && value.permissions.canRunAgent)).toBe(true);
  const ready = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaces' && response.request().method() === 'GET');
  await page.goto(url, { waitUntil: 'domcontentloaded' }); expect((await ready).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'))).toBeTruthy();
}
async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage(); pages.add(page);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/mcp' || url.pathname.includes('/composio/execute')) receipt.forbiddenWrites.push(`provider:${request.method()}:${url.pathname}`);
    if (url.origin !== process.env.BASE_URL) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const body = request.method() === 'PATCH' && ['/api/agents', '/api/agents/workflow'].includes(url.pathname)
        ? request.postDataJSON() as { agentId?: unknown } : null;
      const watchBody = request.method() === 'POST' && url.pathname === '/api/files/watch' ? request.postDataJSON() as { clientId?: unknown; dirs?: unknown } : null;
      const watch = watchBody && url.search === `?workspaceId=${encodeURIComponent(teamId)}`
        && Object.keys(watchBody).sort().join(',') === 'clientId,dirs'
        && typeof watchBody.clientId === 'string' && /^client-\d+-[a-z0-9]{1,9}$/u.test(watchBody.clientId)
        && Array.isArray(watchBody.dirs) && watchBody.dirs.length === 0;
      if (watch) watcherRequests.add(request);
      const allowed = watch || request.method() === 'POST' && url.pathname === '/api/instance/human-activity'
        || request.method() === 'PATCH' && body?.agentId === agent.agentId;
      if (!allowed) receipt.forbiddenWrites.push(`${request.method()}:${url.pathname}`);
    }
  });
  page.on('response', response => {
    if (watcherRequests.delete(response.request())) receipt.watchSubscriptions.push({ workspaceId: teamId, status: response.status() });
  });
  page.on('requestfailed', request => {
    if (watcherRequests.delete(request)) receipt.forbiddenWrites.push('failed:POST:/api/files/watch');
  });
  return page;
}
async function openManagement(page: Page): Promise<Locator> {
  await hydrate(page, `/en/settings?${new URLSearchParams({ tab: 'agent-settings', ...Object.fromEntries(query()) })}`, admin);
  await expect(selector(page)).toHaveCount(1); await selector(page).click();
  const trigger = page.getByTestId('agent-settings-workflow-management-open'); await expect(trigger).toBeVisible();
  const read = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === '/api/agents/workflow' && url.searchParams.get('view') === 'management';
  });
  await trigger.click(); const response = await read; expect(response.status()).toBe(200); assertScope(response, 'admin-management');
  const dialog = page.getByTestId('agent-workflow-management-dialog'); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveCount(0); return dialog;
}
async function openSettingsChoice(page: Page): Promise<Locator> {
  // Seed the actual persisted personal workspace. Hydration may legitimately select the URL's Team workspace.
  await page.addInitScript(value => localStorage.setItem('canvas.activeWorkspaceId', value), personalMemberId);
  await hydrate(page, `/en/settings?${new URLSearchParams({ tab: 'agent-settings', ...Object.fromEntries(query()) })}`, member);
  receipt.settingsWorkspaceObservations.push({ seededPersonalId: personalMemberId, requestedTeamId: teamId,
    persistedActiveId: await page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId')) });
  await expect(selector(page)).toHaveCount(1); await selector(page).click();
  await expect(page.getByTestId('agent-settings-workflow-management-open')).toHaveCount(0);
  await expect(page.locator('#onboarding-settings-tools')).toHaveCount(0);
  for (const name of [en.settings.agentPanel.capabilities.skillsToggle, en.settings.agentPanel.capabilities.connectionsToggle]) await expect(page.getByRole('switch', { name, exact: true })).toHaveCount(0);
  const read = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === '/api/agents/workflow' && response.request().method() === 'GET' && !url.searchParams.has('view');
  });
  await page.getByTestId('agent-settings-workflow').getByRole('button', { name: own.open, exact: true }).click();
  const response = await read; expect(response.status()).toBe(200); assertScope(response, 'member-settings');
  const dialog = page.getByTestId('agent-workflow-dialog'); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('status')).toHaveCount(0); return dialog;
}
async function openChatChoice(page: Page): Promise<Locator> {
  await hydrate(page, `/en/notebook?${new URLSearchParams({ chat: 'open', ...Object.fromEntries(query()) })}`, member);
  // Chat intentionally follows the actual active WorkspaceStore context.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'))).toBe(teamId);
  const trigger = page.getByTestId('chat-agent-id'); await expect(trigger).toBeVisible(); await trigger.click();
  await expect(page.getByTestId('chat-agent-selector-skeleton')).toHaveCount(0);
  const read = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === '/api/agents/workflow' && !url.searchParams.has('view');
  });
  await page.getByTestId(`chat-agent-workflow-${agent.agentId}`).click();
  const response = await read; expect(response.status()).toBe(200);
  expect(new URL(response.url()).searchParams.get('workspaceId')).toBe(teamId);
  const dialog = page.getByTestId('agent-workflow-dialog'); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('status')).toHaveCount(0); return dialog;
}
async function configureTarget(container: Locator, value: IntegrationConnectionDescriptor): Promise<void> {
  await container.getByRole('button', { name: ui.target.shared, exact: true }).click();
  await container.getByRole('combobox', { name: ui.target.shared, exact: true }).selectOption(value.resource.connectionRef);
  const confirmation = container.getByRole('checkbox', { name: ui.target.confirmMapping, exact: true });
  if (await confirmation.count()) await confirmation.check();
  await container.getByRole('button', { name: ui.target.use, exact: true }).click();
}
async function configureToolCap(container: Locator): Promise<void> {
  await container.locator('summary').filter({ hasText: ui.bindings.toolLimits }).click();
  await container.getByRole('checkbox', { name: ui.bindings.limitTools, exact: true }).check();
  await container.getByRole('textbox', { name: ui.bindings.toolNames, exact: true }).fill(toolName);
}
async function openBindings(dialog: Locator): Promise<void> {
  const toggle = dialog.getByTestId('workflow-management-bindings-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const section = dialog.getByTestId('workflow-management-bindings'); await expect(section).toBeVisible();
  const load = section.getByRole('button', { name: ui.bindings.load, exact: true });
  await expect(load).toBeVisible(); await load.click();
  const selected = capability(dialog, 'selectable-design').getByRole('combobox', { name: ui.bindings.default, exact: true });
  await expect(selected).toBeVisible(); await expect(selected.locator('option')).toHaveCount(3);
}
async function saveCentral(page: Page, dialog: Locator, expectedStatus = 200): Promise<Response> {
  const before = await inspect(); await startWrite(`central:${agent.agentId}`);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'PATCH');
  await dialog.getByTestId('workflow-management-save').click(); const response = await saved;
  expect(response.status()).toBe(expectedStatus);
  const body = response.request().postDataJSON() as { agentId: string; expectedRevision: number; expectedWorkflowRevision: number; workflow: AgentWorkflowConfiguration };
  expect(Object.keys(body).sort()).toEqual(['agentId', 'expectedRevision', 'expectedWorkflowRevision', 'workflow'].sort());
  expect(body.agentId).toBe(agent.agentId); assertScope(response, 'admin-central-save');
  if (expectedStatus === 200) {
    expect(body.expectedRevision).toBe(before.agent.revision); expect(body.expectedWorkflowRevision).toBe(before.agent.workflowRevision ?? 0);
    await data(response, 'Actual central editor save'); receipt.workflowWrites += 1; await rememberAgent();
    expect(agent.enabledTools).toEqual(nativeTools); expect(agent.revision).toBe(before.agent.revision + 1);
    expect(agent.workflowRevision).toBe((before.agent.workflowRevision ?? 0) + 1);
    await expect(dialog.getByText(ui.saved, { exact: true })).toBeVisible(); await expect(dialog.getByTestId('workflow-management-save')).toBeDisabled();
  } else {
    expect((await response.json() as { code: string }).code).toBe('AGENT_REVISION_CONFLICT');
    expect(await inspect()).toEqual(before);
  }
  await finishWrite(); return response;
}
async function saveOwn(page: Page, dialog: Locator, expected: AgentWorkflowDescriptor, choiceId: string | null): Promise<AgentWorkflowDescriptor> {
  await startWrite(`own-choice:${agent.agentId}`);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/workflow' && response.request().method() === 'PATCH');
  await dialog.getByRole('button', { name: own.save, exact: true }).click(); const response = await saved;
  const result = await data<AgentWorkflowDescriptor>(response, 'Actual member choice save'); assertScope(response, 'member-own-choice'); safe(result);
  expect(response.request().postDataJSON()).toEqual({ agentId: agent.agentId, capabilityKey: slot(expected).capabilityKey,
    expectedWorkflowRevision: expected.workflowRevision, expectedPreferenceRevision: expected.preferenceRevision, choiceId });
  expect(result.preferenceRevision).toBe(expected.preferenceRevision + 1); expect(result.workflowRevision).toBe(expected.workflowRevision);
  receipt.ownChoiceWrites += 1; await finishWrite(); await expect(dialog.getByRole('button', { name: own.saved, exact: true })).toBeVisible(); return result;
}
async function createMember(browser: Parameters<typeof createAuthenticatedContext>[0], role: 'member' | 'editor'): Promise<BrowserContext> {
  const email = process.env[role === 'member' ? 'TEST_SECONDARY_EMAIL' : 'TEST_EDITOR_EMAIL'];
  const password = process.env[role === 'member' ? 'TEST_SECONDARY_PASSWORD' : 'TEST_EDITOR_PASSWORD'];
  if (!email || !password) throw new Error('The owning workflow harness must provide private member credentials.');
  await startWrite(`membership:${role}`);
  const proposed = await data<{ membershipId: string; stage: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(
    await admin.request.post('/api/admin/organization/memberships', { data: { name: `Workflow ${role} ${fixture.nonce}`, email, role: 'member' } }), 'Real Team membership proposal', 202);
  receipt.membershipIds.push(proposed.membershipId); await persist(); expect(proposed.approval.required).toBe(false); expect(proposed.quote.nonBillable).toBe(true);
  const activated = await data<{ stage: string; membershipId: string; execution: { onboardingInitialized: boolean } }>(
    await admin.request.post(`/api/admin/organization/memberships/${encodeURIComponent(proposed.membershipId)}/activate`, { data: { password } }), 'Real Team membership activation');
  expect(activated.stage).toBe('active'); expect(activated.membershipId).toBe(proposed.membershipId); expect(activated.execution.onboardingInitialized).toBe(true);
  await finishWrite();
  const context = await createAuthenticatedContext(browser, { baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { Origin: process.env.BASE_URL! } }, { email, password });
  const response = await requestManagedTestSession(context.request); expect(response.status()).toBe(200);
  const session = await response.json() as { user: { id: string; role: string; email: string } };
  expect(session.user.email).toBe(email); expect(session.user.role).toBe('user'); expect(session.user.id).not.toBe(adminId);
  if (role === 'member') memberId = session.user.id; else editorId = session.user.id;
  receipt.actorIds.push(session.user.id); await persist(); return context;
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN).toBe('1'); expect(process.env.E2E_EXTERNAL_SERVER).toBe('1');
  expect(process.env.BASE_URL).toBe('http://127.0.0.1:3001');
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  if (!file || !path.isAbsolute(file)) throw new Error('An owned recovery receipt is required.');
  const stat = await fs.lstat(file); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true); expect(stat.mode & 0o777).toBe(0o600);
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  expect(fixture).toMatchObject({ version: 1, createAcknowledged: true, phase: 'browser', listenerVerified: true });
  expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(fixture.databaseName).toBe(`canvas_connection_test_${fixture.nonce}`);
  expect(fixture.actorId).toBeTruthy(); expect(fixture.serverPid).toBeGreaterThan(0); expect(await fs.realpath(process.cwd())).toBe(fixture.repo);
  expect(path.dirname(file)).toBe(fixture.fixtureRoot); expect(await fs.realpath(fixture.fixtureRoot)).toBe(fixture.fixtureRoot);
  expect((await fs.lstat(fixture.fixtureRoot)).mode & 0o777).toBe(0o700);
  expect(await fs.readFile(path.join(fixture.fixtureRoot, '.fixture-owner'), 'utf8')).toBe(fixture.ownerMarker);
  expect(process.env.DATA).toBe(fixture.dataRoot); expect(process.env.TMPDIR).toBe(fixture.tmpRoot);
  receiptPath = path.join(fixture.fixtureRoot, 'browser-receipt.json');
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, actorIds: [fixture.actorId], phase: 'setup', outstanding: null,
    closedContexts: false, agents: [], packages: [], connections: [], membershipIds: [], workspaceIds: [], forbiddenWrites: [], watchSubscriptions: [], workflowWrites: 0, ownChoiceWrites: 0, readScopes: [], settingsWorkspaceObservations: [] }; await persist();
  admin = await createAuthenticatedContext(browser, { baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { Origin: process.env.BASE_URL! } });
  await runManagedTestPreflight(admin, { baseURL: process.env.BASE_URL });
  const sessionResponse = await requestManagedTestSession(admin.request); expect(sessionResponse.status()).toBe(200);
  const session = await sessionResponse.json() as { user: { id: string; role: string } }; expect(session.user).toMatchObject({ id: fixture.actorId, role: 'admin' }); adminId = session.user.id;
  const health = await admin.request.get('/api/health'); expect(health.status()).toBe(200);
  expect((await health.json() as { deployment: { mode: string; teamFeaturesEnabled: boolean } }).deployment).toMatchObject({ mode: 'team', teamFeaturesEnabled: true });
  member = await createMember(browser, 'member'); editor = await createMember(browser, 'editor');
  const memberListingResponse = await member.request.get('/api/workspaces'); expect(memberListingResponse.status()).toBe(200);
  const memberListing = await memberListingResponse.json() as ClientWorkspaceResponse; expect(memberListing.defaultWorkspace?.type).toBe('personal');
  personalMemberId = memberListing.defaultWorkspace!.id; organizationId = memberListing.defaultWorkspace!.organizationId!; expect(organizationId).toBeTruthy();
  await startWrite('workspace:team');
  const createdWorkspaceResponse = await admin.request.post('/api/workspaces', { data: { type: 'team', name: `Workflow team ${fixture.nonce}` } });
  expect(createdWorkspaceResponse.status()).toBe(201);
  const createdWorkspace = await createdWorkspaceResponse.json() as { success: boolean; workspace: ClientWorkspaceSummary };
  expect(createdWorkspace.success).toBe(true); teamId = createdWorkspace.workspace.id; receipt.workspaceIds.push(teamId); await persist();
  expect(createdWorkspace.workspace).toMatchObject({ type: 'team', organizationId, status: 'active' }); await finishWrite();
  for (const userId of [memberId, editorId]) {
    await startWrite(`workspace-member:${userId}`);
    const joined = await admin.request.post(`/api/workspaces/${encodeURIComponent(teamId)}/members`, { data: { userId, role: 'member', canRead: true, canWrite: false, canManage: false } });
    expect(joined.status()).toBe(200); expect((await joined.json() as { success: boolean }).success).toBe(true); await finishWrite();
  }
  const defaultInspection = await data<Inspection>(await admin.request.get('/api/agents?agentId=bradley&includeAccess=true'), 'Native default before');
  const defaultTools = await data<ToolsState>(await admin.request.get('/api/agents/tools?agentId=bradley'), 'Native default tool settings before');
  defaults = { inspection: defaultInspection, config: defaultTools.config };
  const inert = process.env.INTEGRATION_GATEWAY_E2E_FIXTURE_URL;
  if (!inert) throw new Error('The owned issuer origin is required for inert connection configurations.');
  const endpoint = new URL(inert); expect(endpoint.hostname).toBe('127.0.0.1'); expect(endpoint.protocol).toBe('http:');
  for (const ownership of [{ type: 'organization' as const }, { type: 'team' as const, workspaceId: teamId }]) {
    await startWrite(`connection:${ownership.type}`);
    const connection = (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.post(`/api/integrations/shared-connections?${query()}`, { data: {
      source: 'mcp', ownership, displayName: `Workflow ${ownership.type} ${fixture.nonce}`, accessMode: 'restricted', allowedToolNames: [toolName],
      config: { url: `${endpoint.origin}/mcp`, auth: 'none' }, secrets: [], grants: [
        { targetType: 'user', targetId: adminId, canUse: true, canManage: true, allowedToolNames: [toolName] },
        { targetType: 'user', targetId: memberId, canUse: true, canManage: false, allowedToolNames: [toolName] },
        { targetType: 'user', targetId: editorId, canUse: true, canManage: true, allowedToolNames: [toolName] },
      ],
    } }), 'Own inert scoped MCP connection')).connection;
    receipt.connections.push(connection); await persist(); expect(connection.resource.createdByUserId).toBe(adminId);
    expect(connection.resource.ownership.type).toBe(ownership.type); expect(connection.resource.status).toBe('active'); expect(connection.resource.application).toBeNull();
    if (ownership.type === 'organization') organizationConnection = connection; else teamConnection = connection; await finishWrite();
  }
  const name = `workflow-browser-${fixture.nonce}`, child = 'selected-context', sibling = 'unselected-context';
  const intakeRoot = process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT;
  if (!intakeRoot || path.dirname(intakeRoot) !== fixture.dataRoot) throw new Error('The owned package intake must be inside the receipted DATA.');
  const source = path.join(intakeRoot, name); await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true, mode: 0o700 });
  for (const skill of [child, sibling]) {
    await fs.mkdir(path.join(source, 'skills', skill), { recursive: true });
    await fs.writeFile(path.join(source, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Own isolated workflow context\nmetadata:\n  version: "1.0.0"\n---\nUse the explicitly configured connection.\n`);
  }
  await fs.mkdir(path.join(source, 'skills', child, 'agents'));
  const alternative = { source: 'mcp', connector: 'design', requiredTools: [toolName] };
  const workflow = { version: 1, integrationCapabilities: [
    { id: 'fixed-design', application: 'canva', required: true, alternatives: [alternative] },
    { id: 'selectable-design', application: 'canva', required: true, alternatives: [alternative, { source: 'composio', toolkit: 'canva', requiredTools: [personalToolName] }] },
  ] };
  await fs.writeFile(path.join(source, 'skills', child, 'agents', 'canvas.yaml'), `workflow: ${JSON.stringify(workflow)}\n`);
  await fs.writeFile(path.join(source, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Own multi-user workflow acceptance',
    skills: 'skills', connectors: { mcp: [{ name: 'design', required: false }], composio: [{ toolkit: 'canva', required: false, tools: [personalToolName] }] } }));
  await startWrite('package:install');
  const installed = await admin.request.post(`/api/plugins/install?${query()}`, { data: { sourcePath: source, scope: 'organization', enable: true, replace: false } });
  expect(installed.status()).toBe(200); const install = await installed.json() as { success: boolean; plugin: { resourceId: string; name: string } };
  expect(install.success).toBe(true); expect(install.plugin.name).toBe(name); await finishWrite();
  await startWrite('package:adopt');
  pkg = (await data<{ resource: CapabilityResourceDescriptor }>(await admin.request.post(`/api/capabilities/resources/${encodeURIComponent(install.plugin.resourceId)}?${query()}`, { data: {
    expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'organization' }, accessMode: 'restricted', grants: [
      { targetType: 'user', targetId: adminId, canUse: true, canEdit: true, canManage: true },
      { targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false },
      { targetType: 'user', targetId: editorId, canUse: true, canEdit: false, canManage: false },
    ],
  } }), 'Own package authority')).resource; await finishWrite();
  const inspected = (await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(packagePath()), 'Own source package inspection')).package;
  const expected = { expectedMetadataRevision: pkg.metadata.metadataRevision, expectedGrantsRevision: pkg.metadata.grantsRevision,
    expectedPackageRevision: inspected.state?.packageRevision ?? 0, expectedPublishedRevisionRef: inspected.state?.currentPublishedRevisionRef ?? null };
  await startWrite('package:draft');
  const draft = (await data<{ draft: CapabilityPackageDraft }>(await admin.request.post(`/api/capabilities/packages/drafts?${query()}`, {
    data: { operation: 'edit', resourceRef: pkg.metadata.resourceRef, ...expected },
  }), 'Own publication draft')).draft; await finishWrite();
  await startWrite('package:publish');
  publication = await data<Publication>(await admin.request.post(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish?${query()}`, {
    data: { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, ...expected },
  }), 'Own immutable v1 publication');
  const publishedResource = await currentResource();
  expect(publishedResource.metadata).toEqual(pkg.metadata); expect(publishedResource.grants).toEqual(pkg.grants);
  expect(publishedResource.artifact.resourceId).toBe(pkg.artifact.resourceId);
  expect(publishedResource.artifact.revision).toBe(pkg.artifact.revision + 1);
  expect(publishedResource.artifact.checksum).toBe(publication.published.checksum);
  expect(publishedResource.artifact.version).toBe(publication.published.version);
  pkg = publishedResource;
  receipt.packages.push({ resource: pkg, published: { resourceRef: pkg.metadata.resourceRef, revisionRef: publication.published.revisionRef,
    version: publication.published.version, checksum: publication.published.checksum } }); await persist(); await finishWrite();
  await startWrite('agent:create');
  const created = await data<Inspection>(await admin.request.post(agentsPath(), { data: { name: `Workflow acceptance ${fixture.nonce}`, scopeType: 'organization',
    enabledTools: nativeTools, relevantSkills: [], relevantConnections: [], grants: [
      { targetType: 'workspace', targetId: teamId, canUse: true, canEdit: false, canManage: false },
      { targetType: 'user', targetId: editorId, canUse: true, canEdit: true, canManage: false },
    ],
  } }), 'Own organization workflow agent');
  agent = created.agent; receipt.agents.push(agent); await persist(); await rememberAgent(); await finishWrite();
  expect(agent.workflowVersion).toBeNull(); expect(agent.enabledTools).toEqual(nativeTools);
  receipt.phase = 'ready'; await persist();
});

test.afterAll(async () => {
  let verified = false;
  try {
    if (receipt && receipt.outstanding === null && expectedAgent && defaults && pkg && publication && organizationConnection && teamConnection) {
      expect(await inspect()).toEqual(expectedAgent); expect(await currentResource()).toEqual(pkg);
      expect(await currentConnection(organizationConnection)).toEqual(organizationConnection); expect(await currentConnection(teamConnection)).toEqual(teamConnection);
      const head = (await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(packagePath()), 'Own final package head')).package;
      expect(head.state?.currentPublishedRevisionRef).toBe(publication.published.revisionRef); expect(head.state?.packageRevision).toBe(publication.state.packageRevision);
      expect(head.published?.checksum).toBe(publication.published.checksum);
      const nowDefault = { inspection: await data<Inspection>(await admin.request.get('/api/agents?agentId=bradley&includeAccess=true'), 'Native default after'),
        config: (await data<ToolsState>(await admin.request.get('/api/agents/tools?agentId=bradley'), 'Native tools after')).config };
      expect(hash(nowDefault)).toBe(hash(defaults));
      await expect.poll(() => watcherRequests.size).toBe(0); expect(receipt.forbiddenWrites).toEqual([]);
      expect(receipt.watchSubscriptions.length).toBeGreaterThan(0);
      expect(receipt.watchSubscriptions.every(value => value.workspaceId === teamId && value.status === 200)).toBe(true);
      const sessions = await admin.request.get(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId })}`); expect(sessions.status()).toBe(200);
      expect((await sessions.json() as { sessions: unknown[] }).sessions).toEqual([]); verified = true;
    }
  } finally {
    for (const page of pages) await page.close();
    for (const context of [editor, member, admin]) await context?.close();
    if (verified) { receipt.closedContexts = true; receipt.phase = 'verified_closed'; await persist(); }
  }
  // No Agent DELETE, managed cleanup, archive, arbitrary FS removal or SQL repair.
  // The owning runner drops ONLY this acknowledged whole DB/DATA after all own children exit.
});

test('admin central editor pins a published skill and scopes fixed/selectable connections without changing native tools', async () => {
  const page = await newPage(admin), dialog = await openManagement(page), before = await inspect();
  await dialog.getByRole('button', { name: ui.legacy.configure, exact: true }).click();
  await dialog.getByRole('button', { name: ui.packages.add, exact: true }).click();
  await dialog.getByRole('combobox', { name: ui.packages.versionFor.replace('{name}', pkg.artifact.name), exact: true }).selectOption(publication.published.revisionRef);
  await dialog.getByRole('button', { name: ui.packages.addSelected, exact: true }).click();
  const row = dialog.getByTestId('workflow-management-package'); await row.getByRole('button', { expanded: false }).click();
  await row.getByRole('combobox', { name: ui.packages.selection, exact: true }).selectOption('skills');
  await row.getByRole('checkbox', { name: ui.packages.skill.replace('{name}', 'unselected-context'), exact: true }).uncheck();
  await expect(row.getByRole('checkbox', { name: ui.packages.skill.replace('{name}', 'selected-context'), exact: true })).toBeChecked();
  await dialog.getByTestId('workflow-management-bindings-toggle').click();
  const fixed = capability(dialog, 'fixed-design'), selectable = capability(dialog, 'selectable-design');
  await fixed.getByRole('combobox', { name: ui.bindings.modeFor.replace('{application}', 'canva'), exact: true }).selectOption('fixed');
  await configureTarget(fixed, organizationConnection); await configureToolCap(fixed);
  await selectable.getByRole('combobox', { name: ui.bindings.modeFor.replace('{application}', 'canva'), exact: true }).selectOption('selectable');
  for (const connection of [organizationConnection, teamConnection]) {
    await selectable.getByRole('button', { name: ui.bindings.addChoice, exact: true }).click();
    const choice = selectable.getByTestId('workflow-management-choice').last(); await configureTarget(choice, connection); await configureToolCap(choice);
  }
  const defaultSelect = selectable.getByRole('combobox', { name: ui.bindings.default, exact: true });
  const choiceIds = await defaultSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
  expect(choiceIds).toHaveLength(2); await defaultSelect.selectOption(choiceIds[0]);
  const policy = selectable.getByTestId('workflow-management-personal-policy');
  await policy.getByRole('checkbox').first().check();
  await policy.getByRole('checkbox', { name: ui.bindings.allowAlternative.replace('{alternative}', 'composio:canva'), exact: true }).check();
  await policy.locator('summary').click(); await policy.getByRole('checkbox', { name: ui.bindings.limitTools, exact: true }).check();
  await policy.getByRole('textbox', { name: ui.bindings.toolNames, exact: true }).fill(personalToolName);
  const saved = await saveCentral(page, dialog), body = saved.request().postDataJSON() as { workflow: AgentWorkflowConfiguration };
  initialConfiguration = body.workflow;
  expect(initialConfiguration.packages).toHaveLength(1); expect(initialConfiguration.packages[0]).toMatchObject({ resourceRef: pkg.metadata.resourceRef,
    publishedRevisionRef: publication.published.revisionRef, checksum: publication.published.checksum,
    skillSelection: { kind: 'skills', relativeRoots: ['skills/selected-context'] } });
  const declaration = initialConfiguration.packages[0].declarations[0]; expect(declaration.declarationPath).toBe('skills/selected-context/agents/canvas.yaml');
  expect(declaration.capabilities.map(value => value.capabilityId).sort()).toEqual(['fixed-design', 'selectable-design']);
  const fixedSelection = declaration.capabilities.find(value => value.capabilityId === 'fixed-design')!.selection;
  expect(fixedSelection).toMatchObject({ mode: 'fixed', alternativeKey: 'mcp:design', toolCap: [toolName], target: { kind: 'shared', source: 'mcp',
    connectionRef: organizationConnection.resource.connectionRef, bindingRevision: organizationConnection.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' } } });
  const choiceSelection = declaration.capabilities.find(value => value.capabilityId === 'selectable-design')!.selection;
  expect(choiceSelection.mode).toBe('selectable'); if (choiceSelection.mode !== 'selectable') throw new Error('Actual selectable editor output is required.');
  expect(choiceSelection.allowedChoices.map(value => value.target.kind === 'shared' ? value.target.connectionRef : null)).toEqual([organizationConnection.resource.connectionRef, teamConnection.resource.connectionRef]);
  expect(choiceSelection.allowedChoices.every(value => JSON.stringify(value.toolCap) === JSON.stringify([toolName]))).toBe(true);
  expect(choiceSelection.personalPolicy).toEqual({ sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: [personalToolName] });
  expect(agent.revision).toBe(before.agent.revision + 1); expect(agent.enabledTools).toEqual(before.agent.enabledTools);
  const central = await readManagement(); expect(central.configurationState).toBe('available'); expect(central.profile.enabledTools).toEqual(nativeTools);
  expect(central.configuration?.packages[0]).toMatchObject({ resourceRef: pkg.metadata.resourceRef, publishedRevisionRef: publication.published.revisionRef, checksum: publication.published.checksum });
  await dialog.getByRole('button', { name: ui.close, exact: true }).click(); await expect(page.getByTestId('agent-settings-workflow-management-open')).toBeFocused();
  const editorPage = await newPage(editor);
  await hydrate(editorPage, `/en/settings?${new URLSearchParams({ tab: 'agent-settings', ...Object.fromEntries(query()) })}`, editor);
  await selector(editorPage).click(); await expect(editorPage.getByTestId('agent-settings-workflow-management-open')).toBeVisible();
  const editorManager = await readManagement(editor); expect(editorManager.access).toMatchObject({ canEdit: true, canManage: false });
  const editorPackage = (await data<{ resource: CapabilityResourceDescriptor }>(await editor.request.get(resourcePath()), 'Editor independent package rights')).resource;
  expect(editorPackage.access).toMatchObject({ canUse: true, canEdit: false, canManage: false });
});

test('use-only member chooses within exact Team context and resets the administrator default without changing central configuration', async () => {
  const before = await centralSnapshot(), page = await newPage(member), dialog = await openSettingsChoice(page);
  const current = await readWorkflow(); expect(current.access).toEqual({ canUse: true, canEdit: false, canManage: false });
  expect((await member.request.get(workflowPath({}, personalMemberId))).status()).toBe(403);
  expect((await member.request.patch(workflowPath({}, personalMemberId), { data: { agentId: agent.agentId, capabilityKey: slot(current).capabilityKey,
    expectedWorkflowRevision: current.workflowRevision, expectedPreferenceRevision: current.preferenceRevision, choiceId: null } })).status()).toBe(403);
  await expect(dialog.getByText(own.fixed, { exact: true })).toBeVisible(); await expect(ownSelect(dialog)).toHaveCount(1);
  await expect(dialog.getByRole('option', { name: `${teamConnection.resource.displayName} · ${own.scope.team}`, exact: true })).toHaveCount(1);
  await expect(dialog.getByText(own.status.unknown, { exact: true }).first()).toBeVisible();
  const selectable = slot(current), teamChoice = selectable.choices.find(value => value.scopeLabel === 'team'); expect(teamChoice).toBeDefined();
  await ownSelect(dialog).selectOption(`choice:${encodeURIComponent(teamChoice!.choiceId)}`);
  const selected = await saveOwn(page, dialog, current, teamChoice!.choiceId); expect(slot(selected).selectedChoiceId).toBe(teamChoice!.choiceId);
  await ownSelect(dialog).selectOption('default'); const reset = await saveOwn(page, dialog, selected, null);
  expect(slot(reset).selectionOrigin).toBe('default'); expect(await centralSnapshot()).toEqual(before);
  const personal = dialog.getByTestId('agent-workflow-personal-choice');
  await expect(personal.getByRole('combobox')).toHaveCount(0);
  const metadata = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === '/api/agents/workflow' && url.searchParams.get('view') === 'personal-options';
  });
  await personal.getByRole('button', { name: own.personal.open, exact: true }).click();
  const response = await metadata; assertScope(response, 'member-personal-metadata');
  expect(new URL(response.url()).searchParams.has('providerRef')).toBe(false);
  const providers = await data<AgentWorkflowPersonalOptions>(response, 'Actual lazy personal provider metadata'); safe(providers);
  expect(providers.alternatives.map(value => ({ alternativeKey: value.alternativeKey, source: value.source }))).toEqual([{ alternativeKey: 'composio:canva', source: 'composio' }]);
  expect(providers.alternatives.every(value => value.providers.every(provider => provider.origin === 'personal' && provider.accounts === undefined))).toBe(true);
  await expect(personal.getByRole('combobox', { name: own.personal.account, exact: true })).toHaveCount(0);
  await personal.getByRole('button', { name: own.personal.hide, exact: true }).click();
  expect((await member.request.patch(agentsPath(), { data: { agentId: agent.agentId, expectedRevision: agent.revision,
    expectedWorkflowRevision: agent.workflowRevision, workflow: initialConfiguration } })).status()).toBe(403);
  expect(await centralSnapshot()).toEqual(before);
  for (const [width, theme] of [[1280, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(value => {
      localStorage.setItem('theme', value); window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: value }));
    }, theme);
    await expect(page.locator('html')).toHaveClass(new RegExp(`(?:^|\\s)${theme}(?:\\s|$)`, 'u'));
    await expect(dialog).toBeVisible();
    if (!(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1))) {
      await page.screenshot({ path: path.join(fixture.fixtureRoot, `member-choice-overflow-${width}-${theme}.png`) });
      console.log(`OWN_WORKFLOW_OVERFLOW ${JSON.stringify(await dialog.evaluate(element => {
        const outer = element.getBoundingClientRect();
        return { width: outer.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          children: [...element.querySelectorAll<HTMLElement>('*')].filter(child => child.getBoundingClientRect().right > outer.right + 1)
            .slice(0, 10).map(child => ({ tag: child.tagName, classes: child.className, width: child.getBoundingClientRect().width,
              right: child.getBoundingClientRect().right, text: child.textContent?.slice(0, 120) })) };
      }))}`);
    }
    await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .every(animation => animation.playState !== 'running'))).toBe(true);
    const footerClose = dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: own.close, exact: true });
    await footerClose.scrollIntoViewIfNeeded(); await expect(footerClose).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: path.join(fixture.fixtureRoot, `member-choice-${width}-${theme}.png`) });
  }
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(page.getByTestId('agent-settings-workflow').getByRole('button', { name: own.open, exact: true })).toBeFocused();
  const chatPage = await newPage(member), chat = await openChatChoice(chatPage);
  const chatCurrent = await readWorkflow(); await ownSelect(chat).selectOption(`choice:${encodeURIComponent(teamChoice!.choiceId)}`);
  // Chat has no explicit Org URL scope contract; its current workspace is server-resolved.
  const saved = chatPage.waitForResponse(value => new URL(value.url()).pathname === '/api/agents/workflow' && value.request().method() === 'PATCH');
  await startWrite('own-choice:chat'); await chat.getByRole('button', { name: own.save, exact: true }).click();
  const chatResponse = await saved, chatResult = await data<AgentWorkflowDescriptor>(chatResponse, 'Actual Chat own choice'); safe(chatResult);
  expect(new URL(chatResponse.url()).searchParams.get('workspaceId')).toBe(teamId);
  expect(chatResponse.request().postDataJSON()).toEqual({ agentId: agent.agentId, capabilityKey: slot(chatCurrent).capabilityKey,
    expectedWorkflowRevision: chatCurrent.workflowRevision, expectedPreferenceRevision: chatCurrent.preferenceRevision, choiceId: teamChoice!.choiceId });
  receipt.ownChoiceWrites += 1; await finishWrite(); await expect(chat.getByRole('button', { name: own.saved, exact: true })).toBeVisible();
  await chatPage.keyboard.press('Escape'); await expect(chatPage.getByTestId('chat-agent-id')).toBeFocused();
  expect(await centralSnapshot()).toEqual(before);
});

test('real central revision conflict requires consented reload and current connection/package grants remain independent', async () => {
  const firstPage = await newPage(admin), secondPage = await newPage(admin);
  const first = await openManagement(firstPage), second = await openManagement(secondPage);
  for (const dialog of [first, second]) {
    await openBindings(dialog);
    const selected = capability(dialog, 'selectable-design').getByRole('combobox', { name: ui.bindings.default, exact: true });
    const ids = await selected.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
    expect(ids).toHaveLength(2); await selected.selectOption(ids[1]);
  }
  const pinBefore = publication.published;
  const staleMemberPage = await newPage(member), staleMemberDialog = await openSettingsChoice(staleMemberPage), oldWorkflow = await readWorkflow();
  const oldOrganizationChoice = slot(oldWorkflow).choices.find(value => value.scopeLabel === 'organization'); expect(oldOrganizationChoice).toBeDefined();
  await ownSelect(staleMemberDialog).selectOption(`choice:${encodeURIComponent(oldOrganizationChoice!.choiceId)}`);
  await saveCentral(secondPage, second);
  const beforeStaleOwn = await centralSnapshot(); await startWrite('own-choice:stale-workflow');
  const ownConflict = staleMemberPage.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/workflow' && response.request().method() === 'PATCH');
  await staleMemberDialog.getByRole('button', { name: own.save, exact: true }).click();
  const deniedOwn = await ownConflict; expect(deniedOwn.status()).toBe(409); assertScope(deniedOwn, 'member-stale-workflow');
  expect(deniedOwn.request().postDataJSON()).toEqual({ agentId: agent.agentId, capabilityKey: slot(oldWorkflow).capabilityKey,
    expectedWorkflowRevision: oldWorkflow.workflowRevision, expectedPreferenceRevision: oldWorkflow.preferenceRevision, choiceId: oldOrganizationChoice!.choiceId });
  expect((await deniedOwn.json() as { code: string }).code).toBe('AGENT_WORKFLOW_REVISION_CONFLICT');
  expect(await centralSnapshot()).toEqual(beforeStaleOwn); await finishWrite();
  await expect(staleMemberDialog.getByRole('alert')).toContainText(own.errors.conflict);
  await expect(ownSelect(staleMemberDialog)).toHaveValue(`choice:${encodeURIComponent(oldOrganizationChoice!.choiceId)}`);
  await expect(staleMemberDialog.getByRole('button', { name: own.save, exact: true })).toBeDisabled();
  await staleMemberPage.keyboard.press('Escape');
  await saveCentral(firstPage, first, 409); await expect(first.getByTestId('workflow-management-error')).toContainText(ui.errors.conflict);
  await expect(first.getByTestId('workflow-management-save')).toBeDisabled();
  await first.getByTestId('workflow-management-reload').click();
  const consent = firstPage.getByRole('alertdialog'); await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: ui.confirm.discard, exact: true }).click();
  await expect(first.getByTestId('workflow-management-error')).toHaveCount(0); await expect(first.getByRole('status')).toHaveCount(0);
  await openBindings(first);
  const defaultSelect = capability(first, 'selectable-design').getByRole('combobox', { name: ui.bindings.default, exact: true });
  const ids = await defaultSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean));
  await defaultSelect.selectOption(ids[0]); await saveCentral(firstPage, first);
  const raw = await inspect(); expect(raw.agent.enabledTools).toEqual(nativeTools);
  const descriptor = await readWorkflow(); expect(descriptor.packages[0]).toMatchObject({ resourceRef: pkg.metadata.resourceRef, publishedRevisionRef: pinBefore.revisionRef, checksum: pinBefore.checksum });
  const manager = await readManagement();
  expect(manager.configuration?.packages[0].declarations[0].capabilities.find(value => value.capabilityId === 'fixed-design')?.selection).toMatchObject({
    mode: 'fixed', alternativeKey: 'mcp:design', toolCap: [toolName], target: { kind: 'retained' },
  });
  expect(manager.bindingSummaries?.find(value => value.capabilityId === 'fixed-design')).toMatchObject({ source: 'mcp', label: organizationConnection.resource.displayName, scopeLabel: 'organization' });
  const memberPage = await newPage(member), choiceDialog = await openSettingsChoice(memberPage);
  const current = await readWorkflow(), selectedTeam = slot(current).choices.find(value => value.scopeLabel === 'team'); expect(selectedTeam).toBeDefined();
  if (slot(current).selectedChoiceId !== selectedTeam!.choiceId) {
    await ownSelect(choiceDialog).selectOption(`choice:${encodeURIComponent(selectedTeam!.choiceId)}`); await saveOwn(memberPage, choiceDialog, current, selectedTeam!.choiceId);
  }
  await memberPage.keyboard.press('Escape');
  const beforeRevoke = await inspect(), oldConnection = await currentConnection(teamConnection);
  await startWrite('connection:revoke-member');
  teamConnection = (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.patch(connectionPath(oldConnection), { data: {
    expectedMetadataRevision: oldConnection.resource.metadataRevision, expectedGrantsRevision: oldConnection.resource.grantsRevision,
    expectedBindingRevision: oldConnection.resource.bindingRevision, grants: grantInput(oldConnection).filter(value => value.targetId !== memberId),
  } }), 'Targeted own Team connection grant revoke')).connection;
  receipt.connections = [organizationConnection, teamConnection]; await persist(); await finishWrite();
  expect(teamConnection.resource.metadataRevision).toBe(oldConnection.resource.metadataRevision); expect(teamConnection.resource.bindingRevision).toBe(oldConnection.resource.bindingRevision);
  expect(teamConnection.resource.grantsRevision).toBe(oldConnection.resource.grantsRevision + 1);
  const revoked = await readWorkflow(); expect(slot(revoked).selectedChoiceId).toBe(selectedTeam!.choiceId);
  const unavailable = slot(revoked).choices.find(value => value.choiceId === selectedTeam!.choiceId)!;
  expect(unavailable).toEqual({ choiceId: selectedTeam!.choiceId, kind: 'shared', label: 'Unavailable connection', availability: 'unavailable', status: 'unavailable' });
  expect((await member.request.get(connectionPath(teamConnection))).status()).toBe(404);
  expect((await member.request.get(packagePath())).status()).toBe(200); expect(await inspect()).toEqual(beforeRevoke);
  const revokedDialog = await openSettingsChoice(memberPage);
  await expect(ownSelect(revokedDialog)).toHaveValue(`choice:${encodeURIComponent(selectedTeam!.choiceId)}`);
  expect(await revokedDialog.getByRole('option', { name: /Unavailable connection/u }).evaluate(option => (option as HTMLOptionElement).disabled)).toBe(true);
  await expect(revokedDialog.getByText(own.status.unavailable, { exact: true }).first()).toBeVisible();
  await memberPage.keyboard.press('Escape');
  const oldResource = await currentResource(); expect(oldResource.grants).toBeDefined();
  await startWrite('package:revoke-member');
  pkg = (await data<{ resource: CapabilityResourceDescriptor }>(await admin.request.patch(resourcePath(), { data: {
    expectedMetadataRevision: oldResource.metadata.metadataRevision, expectedGrantsRevision: oldResource.metadata.grantsRevision,
    grants: oldResource.grants!.filter(value => value.targetId !== memberId).map(({ targetType, targetId, canUse, canEdit, canManage }) => ({ targetType, targetId, canUse, canEdit, canManage })),
  } }), 'Targeted own package Use grant revoke')).resource;
  receipt.packages[0].resource = pkg; await persist(); await finishWrite();
  expect(pkg.metadata.metadataRevision).toBe(oldResource.metadata.metadataRevision); expect(pkg.metadata.grantsRevision).toBe(oldResource.metadata.grantsRevision + 1);
  expect((await member.request.get(resourcePath())).status()).toBe(404); expect((await member.request.get(packagePath())).status()).toBe(404);
  const blocked = await readWorkflow(); expect(blocked.packages).toEqual([]); expect(blocked.unavailablePackageCount).toBe(1); expect(blocked.access.canUse).toBe(true);
  const blockedDialog = await openSettingsChoice(memberPage); await expect(blockedDialog.getByText(own.packagesUnavailable, { exact: true })).toBeVisible();
  await expect(blockedDialog.getByRole('combobox')).toHaveCount(0); await expect(blockedDialog.getByText(own.noSlots, { exact: true })).toHaveCount(0);
  expect(await inspect()).toEqual(beforeRevoke); expect(receipt.forbiddenWrites).toEqual([]);
  await memberPage.keyboard.press('Escape'); await persist();
});
