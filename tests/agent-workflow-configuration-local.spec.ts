import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page, type Response, type TestInfo } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture } from './helpers/capability-package-test-cleanup';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AgentWorkflowConfiguration, AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { AgentWorkflowPersonalOptions } from '../app/lib/agents/workflow-personal-options';
import type { IntegrationBrowserProviderCalls } from '../scripts/fixtures/integration-tool-browser-provider';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedRevision, CapabilityPackageState } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

type Inspection = { agent: AgentProfile; access: { canUse: boolean; canEdit: boolean; canManage: boolean }; bindings: unknown[]; grants?: unknown[] };
type HttpResponse = Pick<APIResponse | Response, 'ok' | 'status' | 'json'>;
type Publication = { state: CapabilityPackageState; published: CapabilityPackagePublishedRevision };
type CapabilityView = AgentWorkflowDescriptor['packages'][number]['declarations'][number]['capabilities'][number];
const nonce = randomBytes(5).toString('hex');
// Reuse the existing cleanup helper's exact allowlisted namespace, not a broader cleanup rule.
const packageName = `package-editor-qa-${nonce}`, childName = `workflow-context-${nonce}`;
const agentName = `Workflow Configuration QA ${nonce}`, connectionNames = [`Workflow QA ${nonce} MCP A`, `Workflow QA ${nonce} MCP B`];
const labels = en.agentWorkflow, toolName = 'canva_find_designs', personalToolName = 'CANVA_LIST_DESIGNS';
let admin: BrowserContext, member: BrowserContext;
let adminId = '', memberId = '', adminWorkspaceId = '', memberWorkspaceId = '', organizationId = '';
let agent: AgentProfile | undefined, agentReceipt: Inspection | undefined;
let packageReceipt: OwnedCapabilityPackageFixture | undefined, publication: Publication, configuration: AgentWorkflowConfiguration;
let artifacts = '', fixtureOrigin = '', initialCentral: unknown;
const connections = new Map<string, IntegrationConnectionDescriptor>();
test.use({ trace: 'off', video: 'off' });

async function payload<T>(response: HttpResponse, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}
const connectionPath = (ref: string) => `/api/integrations/shared-connections/${encodeURIComponent(ref)}`;
const packagePath = (ref: string) => `/api/capabilities/packages/${encodeURIComponent(ref)}`;
const workflowPath = (context = member) => `/api/agents/workflow?${new URLSearchParams({ agentId: agent!.agentId,
  workspaceId: context === admin ? adminWorkspaceId : memberWorkspaceId })}`;
const connectionRevisions = (value: IntegrationConnectionDescriptor) => ({ expectedMetadataRevision: value.resource.metadataRevision,
  expectedGrantsRevision: value.resource.grantsRevision, expectedBindingRevision: value.resource.bindingRevision });
function rememberConnection(value: IntegrationConnectionDescriptor) {
  expect(value.resource.createdByUserId).toBe(adminId); expect(connectionNames).toContain(value.resource.displayName);
  expect(value.resource.ownership).toEqual({ type: 'organization', organizationId });
  connections.set(value.resource.connectionRef, value); return value;
}
function publicWorkflow(value: AgentWorkflowDescriptor) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ['connectedAccountId', 'connected_account_id', 'composioUserId', 'profileId', 'bindingFingerprint', 'personalBinding',
    'verifiedMcpMapping', 'configFingerprint', 'providerRef', 'accountSelectionRef', 'authorization', 'backend', 'http://127.0.0.1']) {
    expect(serialized.includes(forbidden), `Workflow DTO must not expose ${forbidden}`).toBe(false);
  }
  for (const pkg of value.packages) {
    expect(pkg.resourceRef).toMatch(/^canvas-resource:/u); expect(pkg.publishedRevisionRef).toMatch(/^canvas-package-revision:/u);
  }
}
async function inspectAgent(): Promise<Inspection> {
  return (await payload<{ data: Inspection }>(await admin.request.get(`/api/agents?agentId=${encodeURIComponent(agent!.agentId)}&includeAccess=true`), 'Own agent snapshot')).data;
}
async function readWorkflow(context = member): Promise<AgentWorkflowDescriptor> {
  const value = (await payload<{ data: AgentWorkflowDescriptor }>(await context.request.get(workflowPath(context)), 'Actual workflow inspection')).data;
  publicWorkflow(value); return value;
}
function ownSlot(descriptor: AgentWorkflowDescriptor): CapabilityView {
  const slot = descriptor.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities)).find(capability => capability.capabilityId === 'own-choice');
  expect(slot).toBeDefined(); return slot!;
}
async function centralSnapshot() {
  const inspected = await inspectAgent(), workflow = await readWorkflow(admin);
  return { agent: inspected.agent, bindings: inspected.bindings, grants: inspected.grants,
    workflowVersion: workflow.workflowVersion, workflowRevision: workflow.workflowRevision, packages: workflow.packages };
}
async function rememberAgent(value: AgentProfile) {
  expect(value.createdByUserId).toBe(adminId); expect(value.name).toBe(agentName); expect(value.scopeType).toBe('organization');
  agent = value; agentReceipt = await inspectAgent(); expect(agentReceipt.agent).toEqual(value);
}
async function configure(next = configuration) {
  const result = (await payload<{ data: { agent: AgentProfile; workflow: AgentWorkflowDescriptor } }>(await admin.request.patch('/api/agents', {
    data: { agentId: agent!.agentId, expectedRevision: agent!.revision, expectedWorkflowRevision: agent!.workflowRevision ?? 0,
      enabledTools: ['mcp'], workflow: next },
  }), 'Atomic package pin and connection configuration')).data;
  const { access: _access, ...profile } = result.agent as AgentProfile & { access?: Inspection['access'] };
  publicWorkflow(result.workflow); await rememberAgent(profile); return result.workflow;
}
async function saveChoice(descriptor: AgentWorkflowDescriptor, choiceId: string | null) {
  const result = (await payload<{ data: AgentWorkflowDescriptor }>(await member.request.patch(workflowPath(), {
    data: { agentId: agent!.agentId, capabilityKey: ownSlot(descriptor).capabilityKey,
      expectedWorkflowRevision: descriptor.workflowRevision, expectedPreferenceRevision: descriptor.preferenceRevision, choiceId },
  }), 'Actual own-choice CAS')).data;
  publicWorkflow(result); return result;
}
async function hydrate(page: Page, url: string, workspaceId: string) {
  const hydrated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaces' && response.request().method() === 'GET');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const current = await payload<ClientWorkspaceResponse>(await hydrated, 'Actual page workspace hydration');
  expect(current.workspaces?.some(workspace => workspace.id === workspaceId && workspace.status === 'active')).toBe(true);
  await expect.poll(async () => {
    const active = await page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'));
    return current.workspaces?.some(workspace => workspace.status === 'active' && workspace.id === active);
  }).toBe(true);
}
async function openChatChoices(page: Page) {
  await hydrate(page, `/en/notebook?chat=open&workspaceId=${encodeURIComponent(memberWorkspaceId)}`, memberWorkspaceId);
  const trigger = page.getByTestId('chat-agent-id'); await expect(trigger).toBeVisible({ timeout: 30_000 }); await expect(trigger).toBeEnabled();
  await trigger.click(); await expect(page.getByTestId('chat-agent-selector-skeleton')).toHaveCount(0, { timeout: 30_000 });
  const chooser = page.getByTestId(`chat-agent-workflow-${agent!.agentId}`); await expect(chooser).toBeVisible(); await chooser.click();
  await expect(page.getByTestId('agent-workflow-dialog')).toBeVisible();
  await expect(page.getByTestId('agent-workflow-choices').getByRole('status')).toHaveCount(0, { timeout: 30_000 });
  return page.getByTestId('agent-workflow-dialog');
}
async function openSettingsChoices(page: Page, context: 'admin' | 'member' = 'member') {
  const workspaceId = context === 'admin' ? adminWorkspaceId : memberWorkspaceId;
  await hydrate(page, `/en/settings?tab=agent-settings&workspaceId=${encodeURIComponent(workspaceId)}`, workspaceId);
  const selection = page.getByRole('button').filter({ hasText: agentName }).first(); await expect(selection).toBeVisible({ timeout: 30_000 }); await selection.click();
  const workflow = page.getByTestId('agent-settings-workflow'); await expect(workflow).toBeVisible();
  for (const name of [en.settings.agentPanel.capabilities.skillsToggle, en.settings.agentPanel.capabilities.connectionsToggle]) {
    await expect(page.getByRole('switch', { name, exact: true })).toHaveCount(0);
  }
  const trigger = workflow.getByRole('button', { name: labels.open, exact: true }); await trigger.click();
  const dialog = page.getByTestId('agent-workflow-dialog'); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveCount(0, { timeout: 30_000 }); return { dialog, trigger };
}
const selectable = (page: Page) => page.getByTestId('agent-workflow-capability').filter({ has: page.getByRole('combobox') });
async function uiSave(page: Page, expectedStatus = 200) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/agents/workflow' && value.request().method() === 'PATCH');
  await selectable(page).getByRole('button', { name: labels.save, exact: true }).click();
  const result = await response; expect(result.status()).toBe(expectedStatus); return result;
}
async function screenshot(page: Page, info: TestInfo, label: string) {
  const file = path.join(artifacts, `${label}.png`); await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  await info.attach(label, { path: file, contentType: 'image/png' });
}
async function personalMetadataChoices(page: Page) {
  const calls = async () => payload<IntegrationBrowserProviderCalls>(await admin.request.get(`${fixtureOrigin}/__fixture/calls`), 'Owned provider fixture counters');
  const before = await calls(), descriptor = await readWorkflow();
  const capability = ownSlot(descriptor); expect(capability.personalChoiceAllowed).toBe(true);
  const panel = page.getByTestId('agent-workflow-personal-choice');
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  const response = page.waitForResponse(value => {
    const url = new URL(value.url());
    return url.pathname === '/api/agents/workflow' && value.request().method() === 'GET' && url.searchParams.get('view') === 'personal-options';
  });
  await panel.getByRole('button', { name: labels.personal.open, exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200);
  const query = new URL(actual.url()).searchParams;
  expect(query.get('agentId')).toBe(agent!.agentId); expect(query.get('capabilityKey')).toBe(capability.capabilityKey);
  expect(query.get('expectedWorkflowRevision')).toBe(String(descriptor.workflowRevision));
  expect(query.has('providerRef')).toBe(false); expect(query.has('alternativeKey')).toBe(false);
  const options = (await payload<{ data: AgentWorkflowPersonalOptions }>(actual, 'Authenticated personal metadata options')).data;
  expect(options).toMatchObject({ agentId: agent!.agentId, capabilityKey: capability.capabilityKey,
    workflowRevision: descriptor.workflowRevision, preferenceRevision: descriptor.preferenceRevision });
  expect(options.alternatives.map(({ alternativeKey, source }) => ({ alternativeKey, source }))).toEqual([{ alternativeKey: 'composio:canva', source: 'composio' }]);
  const providers = options.alternatives[0].providers;
  expect(new Set(providers.map(provider => provider.providerRef)).size).toBe(providers.length);
  for (const provider of providers) {
    expect(provider.providerRef).toMatch(/^composio:v1:/u); expect(provider.origin).toBe('personal'); expect(provider.status).toBe('unverified');
    expect(typeof provider.label).toBe('string'); expect(provider.label.trim()).not.toBe('');
    expect(Object.keys(provider).sort()).toEqual(['label', 'origin', 'profileLabel', 'providerRef', 'status'].sort());
    expect(provider.accounts).toBeUndefined(); expect(provider.noAuth).toBeUndefined();
  }
  const serialized = JSON.stringify(options);
  for (const field of ['profileId', 'ownerUserId', 'composioUserId', 'connectedAccountId', 'connected_account_id', 'auth_config', 'backend', 'config', 'apiKey']) {
    expect(serialized.includes(`"${field}":`), `Personal option metadata must not expose ${field}`).toBe(false);
  }
  await expect(panel.getByRole('status')).toHaveCount(0); await expect(panel.getByRole('alert')).toHaveCount(0);
  if (providers.length) await expect(panel.getByRole('combobox', { name: labels.personal.provider, exact: true })).toHaveValue('');
  else await expect(panel.getByText(labels.personal.empty, { exact: true })).toBeVisible();
  await expect(panel.getByRole('combobox', { name: labels.personal.account, exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: labels.personal.use, exact: true })).toHaveCount(0);
  // No profile is selected or probed, and this GET may not start MCP/Composio provider I/O.
  expect(await calls()).toEqual(before);
  await panel.getByRole('button', { name: labels.personal.hide, exact: true }).click();
  await expect(panel.getByRole('combobox')).toHaveCount(0);
}
async function responsive(page: Page, info: TestInfo, surface: 'chat' | 'settings') {
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/en/notebook', { waitUntil: 'domcontentloaded' }); await page.evaluate(value => localStorage.setItem('theme', value), theme);
    const opened = surface === 'settings' ? await openSettingsChoices(page) : { dialog: await openChatChoices(page), trigger: page.getByTestId('chat-agent-id') };
    if (surface === 'settings' && width === 1280 && theme === 'light') await personalMetadataChoices(page);
    await expect(opened.dialog.getByText(labels.fixed, { exact: true })).toBeVisible();
    await expect(opened.dialog.getByText(labels.scope.organization, { exact: true }).first()).toBeVisible();
    await expect(opened.dialog.getByText(labels.status.unknown, { exact: true }).first()).toBeVisible();
    await expect(opened.dialog.getByRole('combobox', { name: labels.connectionFor.replace('{application}', 'canva'), exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await opened.dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const save = selectable(page).getByRole('button', { name: labels.save, exact: true });
    await save.scrollIntoViewIfNeeded(); await expect(save).toBeInViewport();
    const close = opened.dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: labels.close, exact: true });
    await close.scrollIntoViewIfNeeded(); await expect(close).toBeInViewport();
    await screenshot(page, info, `${surface}-${width}-${theme}`);
    await page.keyboard.press('Escape'); await expect(opened.dialog).toBeHidden();
    await expect(opened.trigger).toBeFocused();
  }
}

async function setupOwnedWorkflowFixture(browser: Parameters<typeof createAuthenticatedContext>[0]) {
  expect(process.env.E2E_EXTERNAL_SERVER).toBe('1'); const base = new URL(process.env.BASE_URL || '');
  expect(['localhost', '127.0.0.1']).toContain(base.hostname); expect(base.port).toBe('3001');
  const intake = process.env.CAPABILITY_PACKAGE_E2E_SOURCE_ROOT || process.env.CAPABILITY_RESOURCE_E2E_SOURCE_ROOT;
  const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
  const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
  if (!intake || !path.isAbsolute(intake) || !process.env.DATA || !email || !password) throw new Error('Actual managed DATA/intake and existing admin/member credentials are required; no users are provisioned.');
  const endpoint = new URL(process.env.INTEGRATION_GATEWAY_E2E_FIXTURE_URL || '');
  expect(endpoint.protocol).toBe('http:'); expect(endpoint.hostname).toBe('127.0.0.1');
  fixtureOrigin = endpoint.origin;
  admin = await createAuthenticatedContext(browser, { baseURL: base.toString(), viewport: { width: 1280, height: 850 } });
  member = await createAuthenticatedContext(browser, { baseURL: base.toString(), viewport: { width: 1280, height: 850 } }, { email, password });
  for (const context of [admin, member]) await runManagedTestPreflight(context, { baseURL: base.toString() });
  const primary = await payload<{ user: { id: string; role: string } }>(await requestManagedTestSession(admin.request), 'Admin identity');
  const secondary = await payload<{ user: { id: string; role: string } }>(await requestManagedTestSession(member.request), 'Member identity');
  expect(primary.user.role).toBe('admin'); expect(secondary.user.role).toBe('user'); expect(secondary.user.id).not.toBe(primary.user.id);
  adminId = primary.user.id; memberId = secondary.user.id;
  const ownerWorkspaces = await payload<ClientWorkspaceResponse>(await admin.request.get('/api/workspaces'), 'Admin workspace');
  const memberWorkspaces = await payload<ClientWorkspaceResponse>(await member.request.get('/api/workspaces'), 'Member workspace');
  expect(ownerWorkspaces.defaultWorkspace?.type).toBe('personal'); expect(memberWorkspaces.defaultWorkspace?.type).toBe('personal');
  adminWorkspaceId = ownerWorkspaces.defaultWorkspace!.id; memberWorkspaceId = memberWorkspaces.defaultWorkspace!.id;
  organizationId = ownerWorkspaces.defaultWorkspace!.organizationId!; expect(organizationId).toBeTruthy();
  expect(memberWorkspaces.defaultWorkspace!.organizationId).toBe(organizationId);
  for (const displayName of connectionNames) {
    const value = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await admin.request.post('/api/integrations/shared-connections', {
      data: { source: 'mcp', ownership: { type: 'organization' }, displayName, accessMode: 'restricted', allowedToolNames: [toolName],
        config: { url: `${endpoint.origin}/mcp`, auth: 'none' }, secrets: [], grants: [
          { targetType: 'user', targetId: adminId, canUse: true, canManage: true, allowedToolNames: [toolName] },
          { targetType: 'user', targetId: memberId, canUse: true, canManage: false, allowedToolNames: [toolName] },
        ] },
    }), 'Own inert shared MCP setup')).data.connection;
    rememberConnection(value); expect(value.resource.status).toBe('active'); expect(value.resource.source).toBe('mcp');
  }
  artifacts = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-workflow-ui-${nonce}-`));
  await fs.mkdir(intake, { recursive: true }); const sourceDirectory = await fs.mkdtemp(path.join(intake, `${packageName}-`));
  await fs.mkdir(path.join(sourceDirectory, '.canvas-plugin')); await fs.mkdir(path.join(sourceDirectory, 'skills', childName), { recursive: true });
  const alternative = { source: 'mcp', connector: 'design', requiredTools: [toolName] };
  await fs.writeFile(path.join(sourceDirectory, '.canvas-plugin/plugin.json'), JSON.stringify({ name: packageName, version: '1.0.0', description: 'Own immutable workflow UI fixture', skills: 'skills',
    connectors: { mcp: [{ name: 'design', required: false }] }, workflow: { version: 1, integrationCapabilities: [
      { id: 'fixed', application: 'canva', required: true, alternatives: [alternative], skillRefs: [childName] },
      { id: 'own-choice', application: 'canva', required: true, alternatives: [alternative,
        { source: 'composio', toolkit: 'canva', requiredTools: [personalToolName] }], skillRefs: [childName] },
    ] } }));
  await fs.writeFile(path.join(sourceDirectory, 'skills', childName, 'SKILL.md'), `---\nname: ${childName}\ndescription: Immutable workflow UI context\nmetadata:\n  version: "1.0.0"\n---\nUse only the centrally selected connection.\n`);
  const installed = await payload<{ success: boolean; plugin: { resourceId: string; name: string; checksum: string; version: string } }>(await admin.request.post('/api/plugins/install', {
    data: { sourcePath: sourceDirectory, scope: 'organization', enable: true, replace: false },
  }), 'Own actual package installation');
  expect(installed.success).toBe(true); expect(installed.plugin.name).toBe(packageName);
  packageReceipt = { nonce, names: [packageName], actorIds: [adminId, memberId], adminId, organizationId, dataRoot: await fs.realpath(process.env.DATA),
    sourceDirectory, sourceName: packageName, initialChecksum: installed.plugin.checksum, initialVersion: installed.plugin.version, publications: [], resourceRevisions: [] };
  const resource = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.post(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`, {
    data: { expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'organization' }, accessMode: 'restricted', grants: [
      { targetType: 'user', targetId: adminId, canUse: true, canEdit: true, canManage: true },
      { targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false },
    ] },
  }), 'Own package adoption and explicit use grants')).data.resource;
  const ref = resource.metadata.resourceRef; packageReceipt.sourceResourceRef = ref;
  packageReceipt.resourceRevisions.push({ resourceRef: ref, metadataRevision: resource.metadata.metadataRevision, grantsRevision: resource.metadata.grantsRevision });
  const inspected = (await payload<{ data: { package: CapabilityPackageDescriptor } }>(await admin.request.get(packagePath(ref)), 'Own package head')).data.package;
  const expectations = { expectedMetadataRevision: resource.metadata.metadataRevision, expectedGrantsRevision: resource.metadata.grantsRevision,
    expectedPackageRevision: inspected.state?.packageRevision ?? 0, expectedPublishedRevisionRef: inspected.state?.currentPublishedRevisionRef ?? null };
  const draft = (await payload<{ data: { draft: CapabilityPackageDraft } }>(await admin.request.post('/api/capabilities/packages/drafts', {
    data: { operation: 'edit', resourceRef: ref, ...expectations },
  }), 'Own private publication draft')).data.draft;
  publication = (await payload<{ data: Publication }>(await admin.request.post(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish`, {
    data: { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, ...expectations },
  }), 'Own immutable workflow v1 publication')).data;
  packageReceipt.publications.push({ resourceRef: ref, revisionRef: publication.published.revisionRef, checksum: publication.published.checksum, version: publication.published.version });
  const created = (await payload<{ data: Inspection }>(await admin.request.post('/api/agents', {
    data: { name: agentName, scopeType: 'organization', enabledTools: ['__none__'], relevantSkills: [], relevantConnections: [], grants: [
      { targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false },
    ] },
  }), 'Own use-only organization agent')).data.agent;
  agent = created; await rememberAgent(created); expect(created.enabledTools).toEqual(['__none__']); expect(created.workflowVersion).toBeNull();
  const targets = [...connections.values()].map(value => ({ kind: 'shared' as const, source: 'mcp' as const, connectionRef: value.resource.connectionRef,
    bindingRevision: value.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' as const } }));
  configuration = { version: 1, packages: [{ resourceRef: ref, publishedRevisionRef: publication.published.revisionRef, checksum: publication.published.checksum,
    skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [
      { capabilityId: 'fixed', selection: { mode: 'fixed', alternativeKey: 'mcp:design', target: targets[0], toolCap: [toolName] } },
      { capabilityId: 'own-choice', selection: { mode: 'selectable', allowedChoices: targets.map((target, index) => ({ choiceId: index === 0 ? 'a' : 'b', alternativeKey: 'mcp:design', target, toolCap: [toolName] })), defaultChoiceId: 'a',
        personalPolicy: { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: [personalToolName] } } },
    ] }] }] };
}

async function cleanupOwnedWorkflowFixture() {
  const errors: unknown[] = [];
  if (agent && admin) {
    try {
      const current = await inspectAgent(); expect(current).toEqual(agentReceipt);
      expect(current.agent).toMatchObject({ agentId: agent.agentId, name: agentName, createdByUserId: adminId, organizationId, scopeType: 'organization', ownerUserId: null });
      expect(current.agent.type).not.toBe('main');
      const sessions = await payload<{ sessions: unknown[] }>(await admin.request.get(`/api/sessions?agentId=${encodeURIComponent(agent.agentId)}`), 'Own agent foreign-session guard');
      expect(sessions.sessions, 'Any unexpected session preserves the fixture agent and its packages.').toHaveLength(0);
      const preview = (await payload<{ data: { agent: AgentProfile; confirmationToken: string; impacts: { sessions: number } } }>(await admin.request.post('/api/agents/delete-preview', { data: { agentId: agent.agentId } }), 'Own agent delete preview')).data;
      expect(preview.agent).toEqual(agent); expect(preview.impacts.sessions).toBe(0);
      await payload(await admin.request.delete('/api/agents', { data: { agentId: agent.agentId, expectedRevision: agent.revision, confirmationToken: preview.confirmationToken } }), 'Exact own agent deletion');
      expect((await member.request.get(workflowPath())).status(), 'Deleted agent own-choice preferences are no longer publicly reachable.').toBe(404);
      agent = undefined;
    } catch (error) { errors.push(error); }
  }
  if (!errors.length) for (const [ref, expected] of connections) {
    try {
      const current = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await admin.request.get(connectionPath(ref)), 'Own connection cleanup snapshot')).data.connection;
      expect(current).toEqual(expected); expect(current.resource).toMatchObject({ connectionRef: ref, createdByUserId: adminId, ownership: { type: 'organization', organizationId } });
      expect(connectionNames).toContain(current.resource.displayName); expect(current.resource.source).toBe('mcp');
      const archived = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await admin.request.patch(connectionPath(ref), {
        data: { ...connectionRevisions(current), status: 'archived' },
      }), 'Public API archival of exact owned secret-free MCP resource')).data.connection;
      expect(archived.resource.status).toBe('archived'); expect(archived.grants).toEqual(current.grants); connections.set(ref, archived);
    } catch (error) { errors.push(error); }
  }
  if (!errors.length && packageReceipt) try { await cleanupOwnedCapabilityPackageFixture(packageReceipt); } catch (error) { errors.push(error); }
  for (const context of [member, admin]) if (context) await context.close().catch(error => errors.push(error));
  if (errors.length) throw new AggregateError(errors, 'Owned workflow cleanup preserved changed or unverified resources.');
  // Shared audit/archived backend rows are deliberately retained by the public archival contract.
}

test.describe('Actual agent workflow pins and own choices through Chat/Settings', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000, retries: 0 });
  test.beforeAll(async ({ browser }) => setupOwnedWorkflowFixture(browser));
  test.afterAll(cleanupOwnedWorkflowFixture);

  test('atomically configures exact v1 fixed/selectable bindings and denies use-only central/legacy edits', async ({}, info) => {
    const before = await inspectAgent(), missing = structuredClone(configuration);
    missing.packages[0].declarations[0].capabilities.pop();
    const rejected = await admin.request.patch('/api/agents', { data: { agentId: agent!.agentId, expectedRevision: agent!.revision,
      expectedWorkflowRevision: 0, workflow: missing } });
    expect(rejected.status()).toBe(409); expect((await rejected.json()).code).toBe('AGENT_WORKFLOW_REQUIRED_BINDING'); expect(await inspectAgent()).toEqual(before);
    const configured = await configure(); expect(configured.workflowVersion).toBe(1); expect(configured.workflowRevision).toBe(1);
    expect(configured.packages[0]).toMatchObject({ resourceRef: publication.state.resourceRef, publishedRevisionRef: publication.published.revisionRef, checksum: publication.published.checksum });
    initialCentral = await centralSnapshot();
    const memberInspection = (await payload<{ data: Inspection }>(await member.request.get(`/api/agents?agentId=${encodeURIComponent(agent!.agentId)}`), 'Use-only real actor rights')).data;
    expect(memberInspection.access).toEqual({ canUse: true, canEdit: false, canManage: false });
    const denied = await member.request.patch('/api/agents', { data: { agentId: agent!.agentId, expectedRevision: agent!.revision,
      expectedWorkflowRevision: 1, workflow: { version: 1, packages: [] } } });
    expect(denied.status()).toBe(403); expect((await denied.json()).code).toBe('AGENT_ACCESS_DENIED');
    const legacy = await admin.request.patch('/api/agents', { data: { agentId: agent!.agentId, expectedRevision: agent!.revision, relevantSkills: [], relevantConnections: [] } });
    expect(legacy.status()).toBe(409); expect((await legacy.json()).code).toBe('AGENT_WORKFLOW_UPDATE_REQUIRED');
    expect(await centralSnapshot()).toEqual(initialCentral);
    const page = await member.newPage(); try { await responsive(page, info, 'settings'); } finally { await page.close(); }
  });

  test('saves own choices, retains a real stale CAS draft, reloads and explicitly resets the administrator default', async ({}, info) => {
    const page = await member.newPage();
    try {
      await openChatChoices(page); const slot = selectable(page), picker = slot.getByRole('combobox');
      await expect(picker).toHaveValue('default'); await expect(slot.getByRole('button', { name: labels.save, exact: true })).toBeDisabled();
      const initial = await readWorkflow(); await picker.selectOption('choice:b');
      const saved = (await payload<{ data: AgentWorkflowDescriptor }>(await uiSave(page), 'Actual Chat own-choice save')).data;
      publicWorkflow(saved); expect(saved.preferenceRevision).toBe(initial.preferenceRevision + 1); expect(ownSlot(saved)).toMatchObject({ selectedChoiceId: 'b', selectionOrigin: 'user', selectedKind: 'shared' });
      expect(await centralSnapshot()).toEqual(initialCentral);
      await picker.selectOption('default');
      const concurrent = await saveChoice(saved, 'a'); expect(concurrent.preferenceRevision).toBe(saved.preferenceRevision + 1);
      const stale = await uiSave(page, 409); expect((await stale.json()).code).toBe('AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT');
      await expect(page.getByRole('alert')).toContainText(labels.errors.conflict); await expect(picker).toHaveValue('default');
      const reload = page.waitForResponse(value => new URL(value.url()).pathname === '/api/agents/workflow' && value.request().method() === 'GET');
      await page.getByRole('button', { name: labels.reload, exact: true }).click(); await payload(await reload, 'Actual conflict reload');
      await expect(page.getByRole('alert')).toHaveCount(0); await expect(picker).toHaveValue('default');
      const resetResponse = await uiSave(page); expect(resetResponse.request().postDataJSON().choiceId).toBeNull();
      const reset = (await payload<{ data: AgentWorkflowDescriptor }>(resetResponse, 'Explicit own default reset')).data;
      expect(reset.preferenceRevision).toBe(concurrent.preferenceRevision + 1); expect(ownSlot(reset)).toMatchObject({ selectionOrigin: 'default', selectedChoiceId: 'a' });
      expect(await centralSnapshot()).toEqual(initialCentral);
      await page.keyboard.press('Escape'); await expect(page.getByTestId('agent-workflow-dialog')).toBeHidden();
      await responsive(page, info, 'chat');
    } finally { await page.close(); }
  });

  test('shows stale workflow selection and revoked required connections without inventing health or widening rights', async () => {
    const saved = await saveChoice(await readWorkflow(), 'b'); expect(ownSlot(saved).selectionOrigin).toBe('user');
    await configure(); initialCentral = await centralSnapshot();
    const stale = await readWorkflow(); expect(ownSlot(stale)).toMatchObject({ selectionOrigin: 'stale', selectedChoiceId: null, selectedKind: null });
    const page = await member.newPage();
    try {
      await openChatChoices(page); const picker = selectable(page).getByRole('combobox');
      await expect(picker).toHaveValue('unavailable'); await expect(picker.locator('option[value="unavailable"]')).toHaveText(labels.unavailableSelection);
      await expect(selectable(page).getByRole('button', { name: labels.save, exact: true })).toBeDisabled();
      await picker.selectOption('choice:b'); const renewed = (await payload<{ data: AgentWorkflowDescriptor }>(await uiSave(page), 'Explicit selection after central revision change')).data;
      expect(ownSlot(renewed)).toMatchObject({ selectionOrigin: 'user', selectedChoiceId: 'b' });
      expect(await centralSnapshot()).toEqual(initialCentral);
      const selectedRef = [...connections.keys()][1], current = connections.get(selectedRef)!;
      const grants = current.grants!.map(({ targetType, targetId, canUse, canManage, allowedToolNames }) => ({ targetType, targetId,
        canUse: targetId === memberId ? false : canUse, canManage, allowedToolNames }));
      const revoked = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await admin.request.patch(connectionPath(selectedRef), {
        data: { ...connectionRevisions(current), grants },
      }), 'Actual selected connection grant revocation')).data.connection;
      rememberConnection(revoked); expect(revoked.resource.grantsRevision).toBe(current.resource.grantsRevision + 1);
      await page.keyboard.press('Escape'); await openChatChoices(page);
      const deniedSlot = ownSlot(await readWorkflow()); expect(deniedSlot.selectedConnection).toMatchObject({ availability: 'unavailable', status: 'unavailable' });
      expect(deniedSlot.choices.find(choice => choice.choiceId === 'b')?.availability).toBe('unavailable');
      const disabledChoice = selectable(page).getByRole('combobox').locator('option[value="choice:b"]');
      expect(await disabledChoice.evaluate(option => (option as HTMLOptionElement).disabled)).toBe(true);
      await expect(selectable(page)).toContainText(labels.unavailable); await expect(selectable(page)).not.toContainText('Ready');
      expect(await centralSnapshot()).toEqual(initialCentral);
      const unchangedPackage = (await payload<{ data: { package: CapabilityPackageDescriptor } }>(await admin.request.get(packagePath(publication.state.resourceRef)), 'Pinned source unchanged')).data.package;
      expect(unchangedPackage.state).toEqual(publication.state); expect(unchangedPackage.published).toEqual(publication.published);
    } finally { await page.close(); }
  });
});
