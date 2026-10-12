import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AgentWorkflowManagement, AgentWorkflowManagementOptions } from '../app/lib/agents/workflow-management-contracts';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedRevision,
  CapabilityPackageState } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import en from '../messages/en.json';

type Fixture = { version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; databaseName: string; createAcknowledged: boolean; phase: string; serverPid: number; actorId: string };
type Inspection = { agent: AgentProfile; bindings: unknown[]; access: { canUse: boolean; canEdit: boolean; canManage: boolean } };
type ToolsState = { tools: Array<{ name: string; label: string; availability?: { available: boolean } }>;
  config: { agentId: string; enabledTools: string[]; overrideState: { tools: boolean }; inheritedFromMain: boolean } };
type BrowserReceipt = { version: 1; nonce: string; actorId: string; phase: string; outstanding: string | null;
  agents: AgentProfile[]; forbiddenWrites: string[]; humanActivityWrites: number;
  heldResponses: number; fulfilledResponses: number; cancelledResponses: number };
let fixture: Fixture, admin: BrowserContext, page: Page, workspaceId = '';
let a: AgentProfile | undefined, b: AgentProfile | undefined;
let c: AgentProfile | undefined, cExpected: Inspection | undefined;
let aBefore: Inspection | undefined, defaultBefore: { inspection: Inspection; config: ToolsState['config'] } | undefined;
let receipt: BrowserReceipt, receiptPath = '';
const labels = en.settings.agentPanel;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  expect(response.status(), `${phase} must use the real successful endpoint.`).toBe(200);
  const value = await response.json() as { success?: boolean; data?: T };
  expect(value.success).toBe(true); expect(value.data).toBeDefined(); return value.data!;
}
async function persist(): Promise<void> {
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await fs.rename(temporary, receiptPath);
}
async function inspect(agentId: string): Promise<Inspection> {
  return data(await admin.request.get(`/api/agents?${new URLSearchParams({ agentId, includeAccess: 'true' })}`), 'Exact agent inspection');
}
async function tools(agentId: string): Promise<ToolsState> {
  const result = await data<ToolsState>(await admin.request.get(`/api/agents/tools?${new URLSearchParams({ agentId })}`), 'Exact tools read');
  expect(result.config.agentId).toBe(agentId); return result;
}
async function createOwn(label: 'A' | 'B' | 'C', enabledTools: string[]): Promise<AgentProfile> {
  const name = `Switch ${label} ${fixture.nonce}`;
  receipt.outstanding = `create:${label}`; await persist();
  const created = await data<Inspection>(await admin.request.post('/api/agents', { data: {
    name, scopeType: 'user', enabledTools, capabilities: [], relevantSkills: [], relevantConnections: [],
  } }), 'Acknowledged own personal agent creation');
  const agent = created.agent;
  receipt.agents.push(agent); await persist();
  expect(agent).toMatchObject({ name, scopeType: 'user', ownerUserId: fixture.actorId, createdByUserId: fixture.actorId,
    enabledTools, relevantSkills: [], relevantConnections: [], workflowVersion: null });
  expect(agent.agentId).not.toBe('bradley'); expect(agent.type).not.toBe('main');
  expect(agent.defaultProvider).toBeNull(); expect(agent.defaultModel).toBeNull(); expect(agent.defaultThinking).toBeNull();
  expect((await inspect(agent.agentId)).agent).toEqual(agent);
  receipt.outstanding = null; await persist(); return agent;
}
function selector(agent: AgentProfile): Locator {
  return page.getByRole('button', { pressed: undefined }).filter({ hasText: agent.name }).filter({ has: page.getByText(agent.agentId, { exact: true }) });
}
function toolSwitch(name: string): Locator {
  return page.locator('#onboarding-settings-tools [data-slot="collapsible"]').filter({ has: page.getByText(name, { exact: true }) }).getByRole('switch');
}
async function exactOwned(): Promise<void> {
  if (!a || !b || !aBefore || !defaultBefore) throw new Error('The acknowledged fixture snapshots are incomplete.');
  const currentA = await inspect(a.agentId), currentB = await inspect(b.agentId);
  expect(currentA).toEqual(aBefore);
  expect(currentB.agent).toMatchObject({ agentId: b.agentId, name: b.name, scopeType: 'user', ownerUserId: fixture.actorId,
    createdByUserId: fixture.actorId, relevantSkills: [], relevantConnections: [], workflowVersion: null });
  const defaultNow = { inspection: await inspect('bradley'), config: (await tools('bradley')).config };
  expect(hash(defaultNow)).toBe(hash(defaultBefore));
  for (const agent of [a, b]) {
    const sessions = await admin.request.get(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId })}`);
    expect(sessions.status()).toBe(200);
    expect((await sessions.json() as { sessions: unknown[] }).sessions).toEqual([]);
  }
  if (c) {
    const currentC = await inspect(c.agentId);
    expect(currentC).toEqual(cExpected);
    expect((await admin.request.get(`/api/sessions?${new URLSearchParams({ agentId: c.agentId })}`)).status()).toBe(200);
    receipt.agents = [currentA.agent, currentB.agent, currentC.agent];
  } else receipt.agents = [currentA.agent, currentB.agent];
  await persist();
}

test.beforeAll(async ({ browser }) => {
  const receiptFile = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE!;
  const stat = await fs.lstat(receiptFile); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true);
  expect(stat.mode & 0o777).toBe(0o600);
  fixture = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as Fixture;
  expect(fixture).toMatchObject({ version: 1, createAcknowledged: true, phase: 'browser' });
  expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(fixture.databaseName).toBe(`canvas_connection_test_${fixture.nonce}`);
  expect(fixture.actorId).toBeTruthy(); expect(fixture.serverPid).toBeGreaterThan(0);
  expect(path.dirname(receiptFile)).toBe(fixture.fixtureRoot); expect(await fs.realpath(fixture.fixtureRoot)).toBe(fixture.fixtureRoot);
  expect(await fs.readFile(path.join(fixture.fixtureRoot, '.fixture-owner'), 'utf8')).toBe(fixture.ownerMarker);
  expect(process.env.DATA).toBe(fixture.dataRoot); expect(process.env.TMPDIR).toBe(fixture.tmpRoot);
  receiptPath = path.join(fixture.fixtureRoot, 'browser-receipt.json');
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, phase: 'setup', outstanding: null,
    agents: [], forbiddenWrites: [], humanActivityWrites: 0, heldResponses: 0, fulfilledResponses: 0, cancelledResponses: 0 }; await persist();
  admin = await createAuthenticatedContext(browser, { baseURL: 'http://127.0.0.1:3001' });
  await runManagedTestPreflight(admin, { baseURL: 'http://127.0.0.1:3001' });
  const session = await requestManagedTestSession(admin.request);
  expect(session.status()).toBe(200);
  expect((await session.json() as { user: { id: string; role: string } }).user).toMatchObject({ id: fixture.actorId, role: 'admin' });
  const listing = await admin.request.get('/api/workspaces'); expect(listing.status()).toBe(200);
  const workspaces = await listing.json() as ClientWorkspaceResponse;
  expect(workspaces.defaultWorkspace?.type).toBe('personal'); workspaceId = workspaces.defaultWorkspace!.id;
  defaultBefore = { inspection: await inspect('bradley'), config: (await tools('bradley')).config };
  const available = (await tools('bradley')).tools;
  for (const name of ['read', 'ls', 'grep']) expect(available.some(tool => tool.name === name && tool.availability?.available !== false)).toBe(true);
  a = await createOwn('A', ['read']); b = await createOwn('B', ['ls']); aBefore = await inspect(a.agentId);
  page = await admin.newPage();
});

test.afterAll(async () => {
  try {
    await page?.close();
    if (admin && receipt && receipt.outstanding === null && a && b && defaultBefore && aBefore) {
      await exactOwned();
      expect(receipt.forbiddenWrites).toEqual([]); receipt.phase = 'verified_closed'; await persist();
    }
  } finally { await admin?.close(); }
  // The owning fixture drops ONLY its whole acknowledged database and DATA
  // after its server exits. This suite never calls Agent DELETE or session POST.
});

test('authenticated workflow management reads keep exact revisions and native defaults', async () => {
  expect(a && aBefore).toBeTruthy();
  const agent = a!, endpoint = '/api/agents/workflow';
  const selectors = { agentId: agent.agentId, workspaceId };
  const response = await admin.request.get(`${endpoint}?${new URLSearchParams({ ...selectors, view: 'management' })}`);
  expect(response.headers()['cache-control']).toBe('no-store');
  const current = await data<AgentWorkflowManagement>(response, 'Authenticated central workflow inspection');
  expect(current).toMatchObject({ schemaVersion: 1, view: 'management', agentId: agent.agentId,
    revision: agent.revision, workflowRevision: agent.workflowRevision ?? 0,
    workflowVersion: null, configurationState: 'legacy', configuration: null,
    unavailablePackageCount: 0, unavailableConnectionCount: 0,
    profile: { agentId: agent.agentId, name: agent.name, scopeType: 'user', enabledTools: ['read'] },
    access: { canUse: true, canEdit: true, canManage: true } });
  const query = new URLSearchParams({ ...selectors, view: 'packages',
    expectedRevision: String(current.revision), expectedWorkflowRevision: String(current.workflowRevision) });
  const options = await data<AgentWorkflowManagementOptions>(await admin.request.get(`${endpoint}?${query}`), 'Authenticated published package discovery');
  expect(options).toMatchObject({ schemaVersion: 1, view: 'packages', agentId: current.agentId,
    revision: current.revision, workflowRevision: current.workflowRevision });
  const publicJson = JSON.stringify([current, options]);
  for (const field of ['personalBinding', 'bindingFingerprint', 'boundProviderRef', 'connectedAccountId', 'composioUserId', 'rootPath']) {
    expect(publicJson).not.toMatch(new RegExp(`"${field}"\\s*:`, 'u'));
  }
  query.set('expectedRevision', String(current.revision + 1));
  expect((await admin.request.get(`${endpoint}?${query}`)).status()).toBe(409);
  query.set('expectedRevision', String(current.revision));
  expect((await admin.request.get(`${endpoint}?${query}&page=1&page=2`)).status()).toBe(400);
  expect((await admin.request.get(`${endpoint}?${new URLSearchParams({ ...selectors, view: 'management', unsupported: 'value' })}`)).status()).toBe(400);
  expect((await admin.request.get(`${endpoint}?${new URLSearchParams({ agentId: 'bradley', workspaceId, view: 'management' })}`)).status()).toBe(403);
  const anonymous = await admin.browser()!.newContext({ baseURL: 'http://127.0.0.1:3001' });
  try {
    expect((await anonymous.request.get(`${endpoint}?${new URLSearchParams({ ...selectors, view: 'management' })}`)).status()).toBe(401);
  } finally { await anonymous.close(); }
  await exactOwned();
});

test('late genuine A responses cannot replace B tools or change the B save target', async () => {
  expect(a && b).toBeTruthy(); const agentA = a!, agentB = b!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const delayed: Promise<void>[] = [];
  const routeErrors: string[] = [];
  let delayA = true;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:3001') { await route.abort(); return; }
    if (request.method() === 'POST' && url.pathname === '/api/instance/human-activity') {
      receipt.humanActivityWrites += 1; await persist(); await route.continue(); return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const body = url.pathname === '/api/agents' && request.method() === 'PATCH'
        ? request.postDataJSON() as { agentId?: string; enabledTools?: string[]; expectedRevision?: number } | null : null;
      if (url.pathname !== '/api/agents' || request.method() !== 'PATCH' || body?.agentId !== agentB.agentId) {
        receipt.forbiddenWrites.push(`${request.method()}:${url.pathname}`); await persist(); await route.abort(); return;
      }
    }
    if (request.method() !== 'GET' || url.pathname !== '/api/agents/tools' || url.searchParams.get('agentId') !== agentA.agentId || !delayA) {
      await route.continue(); return;
    }
    const response = await route.fetch();
    const original = await response.json() as { success: boolean; data: ToolsState };
    expect(response.status()).toBe(200); expect(original.success).toBe(true);
    expect(original.data.config).toMatchObject({ agentId: agentA.agentId, enabledTools: ['read'] });
    receipt.heldResponses += 1; await persist();
    // Metadata+config may be separate GETs or a future single merged GET. Every
    // initial A request is held, without fabricating or changing its payload.
    const finish = held.then(async () => {
      try { await route.fulfill({ response }); receipt.fulfilledResponses += 1; }
      catch { receipt.cancelledResponses += 1; } // A guarded abort may legitimately cancel the original browser request.
    });
    delayed.push(finish);
    await finish.catch(() => { routeErrors.push('A response release failed.'); });
  });
  try {
    await page.goto(`/en/settings?${new URLSearchParams({ tab: 'agent-settings', workspaceId })}`, { waitUntil: 'domcontentloaded' });
    await expect(selector(agentA)).toHaveCount(1); await selector(agentA).click();
    await expect.poll(() => receipt.heldResponses).toBeGreaterThanOrEqual(1);
    await expect(selector(agentB)).toHaveCount(1); await selector(agentB).click();
    await expect(selector(agentB)).toHaveAttribute('aria-pressed', 'true');
    const toolsCard = page.locator('#onboarding-settings-tools');
    const expand = toolsCard.getByRole('button', { name: `${en.settings.sections.expand}: ${labels.tools.title}`, exact: true });
    if (await expand.count()) await expand.click();
    await expect(toolSwitch('ls')).toBeChecked(); await expect(toolSwitch('read')).not.toBeChecked();
    delayA = false; release(); await Promise.all(delayed);
    expect(routeErrors).toEqual([]); expect(receipt.fulfilledResponses + receipt.cancelledResponses).toBe(receipt.heldResponses);
    await expect(selector(agentB)).toHaveAttribute('aria-pressed', 'true');
    await expect(toolSwitch('ls')).toBeChecked(); await expect(toolSwitch('read')).not.toBeChecked();
    await expect(toolSwitch('grep')).not.toBeChecked();
    const currentB = await inspect(agentB.agentId);
    receipt.outstanding = `patch:${agentB.agentId}`; await persist();
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'PATCH');
    await toolSwitch('grep').click();
    const response = await saved;
    expect(response.request().postDataJSON()).toEqual({ agentId: agentB.agentId, expectedRevision: currentB.agent.revision, enabledTools: ['ls', 'grep'] });
    const result = await data<{ agent: AgentProfile & { access: Inspection['access'] } }>(response, 'Actual B tool save');
    expect(result.agent).toMatchObject({ agentId: agentB.agentId, revision: currentB.agent.revision + 1, enabledTools: ['ls', 'grep'] });
    const { access: savedAccess, ...savedProfile } = result.agent;
    const inspectedB = await inspect(agentB.agentId);
    expect(inspectedB.agent).toEqual(savedProfile); expect(inspectedB.access).toEqual(savedAccess);
    b = savedProfile; receipt.outstanding = null; await persist();
    await expect(selector(agentB)).toHaveAttribute('aria-pressed', 'true');
    await expect(toolSwitch('ls')).toBeChecked(); await expect(toolSwitch('grep')).toBeChecked(); await expect(toolSwitch('read')).not.toBeChecked();
    await exactOwned(); expect(receipt.forbiddenWrites).toEqual([]);
  } finally { delayA = false; release(); await Promise.allSettled(delayed); }
});

async function setupWorkflowEditorPackage() {
  const name = `workflow-editor-${fixture.nonce}`, child = 'selected-context', sibling = 'other-context';
  const intake = path.join(fixture.dataRoot, 'workflow-editor-intake', name);
  expect(process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT).toBe(path.dirname(intake));
  await fs.mkdir(path.join(intake, '.canvas-plugin'), { recursive: true });
  for (const skill of [child, sibling]) {
    const directory = path.join(intake, 'skills', skill);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${skill}\ndescription: Isolated workflow editor context\nmetadata:\n  version: "1.0.0"\n---\nUse the configured workflow.\n`);
  }
  await fs.mkdir(path.join(intake, 'skills', child, 'agents'));
  await fs.writeFile(path.join(intake, 'skills', child, 'agents', 'canvas.yaml'), 'workflow:\n  version: 1\n  integrationCapabilities: []\n');
  await fs.writeFile(path.join(intake, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0',
    description: 'Own isolated workflow editor acceptance', skills: 'skills', workflow: { version: 1, integrationCapabilities: [] } }));
  receipt.outstanding = 'install:workflow-editor'; await persist();
  const installed = await admin.request.post('/api/plugins/install', { data: { sourcePath: intake, scope: 'user', enable: true, replace: false } });
  expect(installed.status()).toBe(200);
  const result = await installed.json() as { success: boolean; plugin: { resourceId: string; name: string } };
  expect(result.success).toBe(true); expect(result.plugin.name).toBe(name);
  const resource = await data<{ resource: CapabilityResourceDescriptor }>(await admin.request.post(
    `/api/capabilities/resources/${encodeURIComponent(result.plugin.resourceId)}`, { data: {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'inherit',
    } }), 'Own personal package adoption');
  const ref = resource.resource.metadata.resourceRef;
  const descriptor = await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(
    `/api/capabilities/packages/${encodeURIComponent(ref)}`), 'Own personal package descriptor');
  const expected = { expectedMetadataRevision: resource.resource.metadata.metadataRevision,
    expectedGrantsRevision: resource.resource.metadata.grantsRevision,
    expectedPackageRevision: descriptor.package.state?.packageRevision ?? 0,
    expectedPublishedRevisionRef: descriptor.package.state?.currentPublishedRevisionRef ?? null };
  receipt.outstanding = 'publish:workflow-editor'; await persist();
  const created = await data<{ draft: CapabilityPackageDraft }>(await admin.request.post('/api/capabilities/packages/drafts', {
    data: { operation: 'edit', resourceRef: ref, ...expected },
  }), 'Own personal package publication draft');
  const publication = await data<{ state: CapabilityPackageState; published: CapabilityPackagePublishedRevision }>(
    await admin.request.post(`/api/capabilities/packages/drafts/${encodeURIComponent(created.draft.draftRef)}/publish`, {
      data: { draftRef: created.draft.draftRef, expectedDraftRevision: created.draft.draftRevision, ...expected },
    }), 'Own exact immutable package publication');
  expect(publication.published.resourceRef).toBe(ref); expect(publication.published.version).toBe('1.0.0');
  receipt.outstanding = null; await persist();
  return { name, child, sibling, ref, publication };
}

test('real central editor selects an exact published skill root and preserves native tools', async function workflowEditorBrowserAcceptance() {
  await page.unroute('**/api/**');
  const pkg = await setupWorkflowEditorPackage();
  c = await createOwn('C', ['read']); cExpected = await inspect(c.agentId);
  const target = c, before = cExpected, ui = en.agentWorkflowManagement;
  const workflowWrites: Array<{ agentId: string; expectedRevision: number; expectedWorkflowRevision: number; workflow: unknown; enabledTools?: unknown }> = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:3001') { await route.abort(); return; }
    if (request.method() === 'POST' && url.pathname === '/api/instance/human-activity') {
      receipt.humanActivityWrites += 1; await persist(); await route.continue(); return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const body = url.pathname === '/api/agents' && request.method() === 'PATCH' ? request.postDataJSON() : null;
      if (!body || body.agentId !== target.agentId || Object.hasOwn(body, 'enabledTools') || !Object.hasOwn(body, 'workflow')) {
        receipt.forbiddenWrites.push(`${request.method()}:${url.pathname}`); await persist(); await route.abort(); return;
      }
      workflowWrites.push(body);
    }
    await route.continue();
  });
  await page.goto(`/en/settings?${new URLSearchParams({ tab: 'agent-settings', workspaceId })}`, { waitUntil: 'domcontentloaded' });
  await selector(target).click();
  await page.getByTestId('agent-settings-workflow-management-open').click();
  const dialog = page.getByTestId('agent-workflow-management-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: ui.legacy.configure, exact: true }).click();
  await dialog.getByRole('button', { name: ui.packages.add, exact: true }).click();
  await dialog.getByRole('combobox', { name: ui.packages.versionFor.replace('{name}', pkg.name) }).selectOption(pkg.publication.published.revisionRef);
  await dialog.getByRole('button', { name: ui.packages.addSelected, exact: true }).click();
  const row = dialog.getByTestId('workflow-management-package');
  await row.getByRole('button', { expanded: false }).click();
  await row.getByRole('combobox', { name: ui.packages.selection }).selectOption('skills');
  await row.getByRole('checkbox', { name: ui.packages.skill.replace('{name}', pkg.sibling) }).uncheck();
  await expect(row.getByRole('checkbox', { name: ui.packages.skill.replace('{name}', pkg.child) })).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => ({ viewport: window.innerWidth, width: element.getBoundingClientRect().width,
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))).toMatchObject({ viewport: 390 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(fixture.fixtureRoot, 'workflow-editor-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(fixture.fixtureRoot, 'workflow-editor-desktop.png') });
  const saved = page.waitForResponse(response => response.url().includes('/api/agents?') && response.request().method() === 'PATCH');
  receipt.outstanding = 'workflow:C'; await persist();
  await dialog.getByRole('button', { name: ui.save, exact: true }).click();
  await data(await saved, 'Actual editor central PATCH');
  cExpected = await inspect(target.agentId);
  expect(cExpected.agent).toMatchObject({ agentId: target.agentId, revision: before.agent.revision + 1,
    workflowRevision: (before.agent.workflowRevision ?? 0) + 1, workflowVersion: 1, enabledTools: before.agent.enabledTools });
  expect(workflowWrites).toHaveLength(1);
  expect(workflowWrites[0]).toEqual({ agentId: target.agentId, expectedRevision: before.agent.revision,
    expectedWorkflowRevision: before.agent.workflowRevision ?? 0, workflow: { version: 1, packages: [{
      resourceRef: pkg.ref, publishedRevisionRef: pkg.publication.published.revisionRef, checksum: pkg.publication.published.checksum,
      skillSelection: { kind: 'skills', relativeRoots: [`skills/${pkg.child}`] },
      declarations: [{ declarationPath: `skills/${pkg.child}/agents/canvas.yaml`, capabilities: [] }],
    }] } });
  receipt.outstanding = null; await persist();
  const management = await data<AgentWorkflowManagement>(await admin.request.get(`/api/agents/workflow?${new URLSearchParams({
    agentId: target.agentId, workspaceId, view: 'management',
  })}`), 'Actual editor fresh management read');
  expect(management.configurationState).toBe('available'); expect(management.configuration).toEqual(workflowWrites[0].workflow);
  expect(management.profile.enabledTools).toEqual(['read']);
  await expect(dialog.getByRole('button', { name: ui.save, exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: ui.close, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('agent-settings-workflow-management-open')).toBeFocused();
  await exactOwned();
});
