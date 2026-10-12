import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { provisionNaturalWorkflowModel, assertNaturalWorkflowModel, assertNaturalWorkflowSessionModel } from './helpers/natural-workflow-model-setup';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AgentWorkflowConfiguration, AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { AgentWorkflowManagement } from '../app/lib/agents/workflow-management-contracts';
import type { CapabilityPackageDraft, CapabilityPackageFileRead, CapabilityPackagePublishedRevision, CapabilityPackageState } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';
import type { IntegrationProviderDescriptor } from '../app/lib/integration-tools/contracts';
import type { IntegrationBrowserProviderCalls } from '../scripts/fixtures/integration-tool-browser-provider';
import type { ClientWorkspaceResponse, ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import { resolveOrganizationDataRoot } from '../app/lib/runtime-data-paths';
import en from '../messages/en.json';

// Fixed production-harness entry point. There is no model stub, route interception,
// injected tool call, direct provider execution or retry of a business operation.
type Fixture = { version: number; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; databaseName: string; createAcknowledged: boolean; phase: string; serverPid: number; actorId: string; listenerVerified: boolean };
type Identity = { user: { id: string; role: string }; session: { id: string } };
type Actor = { context: BrowserContext; userId: string; authSessionHash: string; name: string; index: number; sessions: Set<string> };
type Inspection = { agent: AgentProfile; access: { canUse: boolean; canEdit: boolean; canManage: boolean } };
type Publication = { state: CapabilityPackageState; published: CapabilityPackagePublishedRevision };
type Block = { type?: string; id?: string; name?: string; text?: string; arguments?: Record<string, unknown> };
type Message = { role: string; toolName?: string; toolCallId?: string; content?: string | Block[]; stopReason?: string;
  isError?: boolean; details?: Record<string, unknown> };
type Flag = { integrationToolGatewayEnabled: boolean; updatedAt: string | null };
type Pin = { resourceRef: string; publishedRevisionRef: string; checksum: string; version: string };
type RunProof = { actorId: string; actorHash: string; authSessionHash: string; sessionId: string; sessionHash: string;
  agentId: string; workspaceId: string; label: string; query: string; scratchHash: string; transcriptSHA: string;
  scriptCallIdHash: string; scriptRefHash: string; package: Pin; selectedBindings: Array<{ alias: string; toolRefHash: string; schemaRefHash: string }>;
  skillReads: Array<{ toolCallIdHash: string; bodySHA: string; byteLength: number; relativePath: 'skills/design-research/SKILL.md' }>;
  effects: Array<{ source: string; toolName: string; toolCallIdHash: string; connectionRef: string }>;
  providerExecutions: IntegrationBrowserProviderCalls['executions']; runtimeHash: string };
type Receipt = { version: 1; nonce: string; actorId: string; actorIds: string[]; phase: string; outstanding: string | null;
  closedContexts: boolean; authClosed: boolean; normalSessionNull: string[]; membershipIds: string[]; workspaceIds: string[];
  agentIds: string[]; connectionRefs: string[]; profileIds: string[]; publications: Pin[]; runs: RunProof[];
  evidence: Array<{ relative: string; sha256: string }>; sourceHashes: Record<string, string>; model?: Record<string, unknown>;
  centralConfigurationHash?: string; finalResourceHash?: string; finalConnectionsHash?: string;
  provider?: IntegrationBrowserProviderCalls; sharedAccountHash?: string; sharedProfileEntityHash?: string;
  domainCleanup: 'owned-parent-after-verified-auth-closure'; failure?: { phase: string; code: string } };

const ui = en.agentWorkflowManagement, resourceLabels = en.skills.resourceManagement, editorLabels = en.skills.packageEditor;
const mcpTool = 'canva_find_designs', composioTool = 'CANVA_LIST_DESIGNS';
const scriptToolNames = ['list_canvas_skill_scripts', 'describe_canvas_skill_script', 'run_canvas_skill_script'];
const enabledTools = ['read', 'mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute', ...scriptToolNames, 'inspect_canvas_resource'];
const sharedWorkflowProtocol = [
  'Execute the centrally assigned design-research workflow in this order. Use actual current tool results; never guess identifiers or execute example placeholders.',
  '1. Before discovery or execution, use the native read tool to read the complete published design-research/SKILL.md at its exact Path listed under Enabled Skills. That listed path belongs to the held workflow version. Do not substitute a draft, original installation, workspace document or another file.',
  '2. Inspect the exact workflow package using inspect_canvas_resource with {"resourceRef":"<the stable workflow package resourceRef configured in AGENTS.md>"}. Omitting resourceRef only lists resources and is not an exact inspection. Read the returned metadata.resourceRef, metadata.responsibleUserId and people.responsible.name. Keep the returned responsible name for the final answer. The user label identifies this run; it is never a person name, responsible person or account identity. If the exact responsible person is unavailable, report that instead of inventing one.',
  '3. Call list_canvas_skill_scripts with {}. Select the ready research entry from the held published package; retain its actual scriptRef, publishedRevisionRef and checksum. Call describe_canvas_skill_script with {"scriptRef":"<scriptRef from that list>"} and read its argument schema and declared integration aliases before running.',
  '4. Discover the two fixed shared providers using integrations with {"action":"list","target":"providers"}. target is the literal string providers, never an object. Select the actual source=mcp Team/workspace provider and source=composio Organization provider from that response, preserving their distinct current providerRef values. Do not use personal accounts or login again.',
  '5. For each selected provider call integrations with {"action":"list","target":"tools","providerRef":"<providerRef from providers>"}. target is the literal string tools. Find the actual tool named by that script alias, then call integrations with {"action":"describe","toolRef":"<toolRef from that tool list>"}. The describe response supplies its current schemaRef. Complete both descriptions in this same user session before starting the script; never guess or reuse references from another user or turn.',
  '6. Execute run_canvas_skill_script exactly once with the discovered scriptRef, arguments {label: the exact user label, query: the exact user search word}, and selectedBindings [{alias:"design_mcp",toolRef: the discovered MCP toolRef,schemaRef: its current described schemaRef},{alias:"design_composio",toolRef: the discovered Composio toolRef,schemaRef: its current described schemaRef}]. Every selected binding requires exactly alias, toolRef and schemaRef; providerRef belongs to provider/tool discovery and must not replace a toolRef or appear in selectedBindings. The script performs both provider reads through the Canvas bridge; make no separate direct business calls.',
  '7. Report the confirmed script version, label and designs from both script results, plus the actual people.responsible.name from the exact inspection in step 2. Keep scratch files private. Stop on an unavailable/uncertain result and inspect recorded effects before any new execution; never repeat an uncertain business operation. Email is outside this workflow and uses Canvas native email tools when separately authorized.',
].join('\n\n');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const providerHash = (value: string) => createHash('sha256').update(value).digest('base64url');
let fixture: Fixture, receipt: Receipt, receiptPath = '', evidenceRoot = '', fixtureUrl = '';
let admin: Actor | undefined, adminPage: Page | undefined;
const users: Actor[] = [];
let organizationId = '', teamId = '', legacyResourceId = '', packageName = '', agentName = '', sourceDirectory = '';
let pkg: CapabilityResourceDescriptor, agent: AgentProfile, teamConnection: IntegrationConnectionDescriptor, orgConnection: IntegrationConnectionDescriptor;
let v1: Publication, v2: Publication, configuration: AgentWorkflowConfiguration;
let model: Awaited<ReturnType<typeof provisionNaturalWorkflowModel>>;
let originalFlag: Flag | undefined, flagRevision: string | undefined, passed = false;
const pages = new Set<Page>();
const scopeQuery = () => new URLSearchParams({ workspaceId: teamId, organizationId });
const scoped = (route: string) => `${route}?${scopeQuery()}`;
const resourcePath = () => scoped(`/api/capabilities/resources/${encodeURIComponent(pkg.metadata.resourceRef)}`);
const workflowPath = (management = false) => `/api/agents/workflow?${new URLSearchParams({ ...Object.fromEntries(scopeQuery()), agentId: agent.agentId,
  ...(management ? { view: 'management' } : {}) })}`;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0, timeout: 20 * 60_000 });

async function payload<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  if (response.status() !== status) {
    let publicCode = '';
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const candidate = (body as Record<string, unknown>).code;
        if (typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(candidate)) publicCode = ` (${candidate})`;
      }
    } catch { /* A non-JSON error keeps the same fixed status-only diagnostic. */ }
    throw new Error(`${phase}: HTTP ${response.status()}${publicCode}; the operation is not retried.`);
  }
  return await response.json() as T;
}
async function data<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  const value = await payload<{ success?: boolean; data?: T }>(response, phase, status);
  if (value.success !== true || value.data === undefined) throw new Error(`${phase}: missing acknowledged data.`);
  return value.data;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An actual structured tool result is required.');
  return value as Record<string, unknown>;
}
async function persist(): Promise<void> {
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await fs.rename(temporary, receiptPath);
}
async function mutate<T>(label: string, work: () => Promise<T>): Promise<T> {
  expect(receipt.outstanding).toBeNull(); receipt.outstanding = label; await persist();
  const value = await work(); receipt.outstanding = null; await persist(); return value;
}
async function artifact(relative: string, bytes: Buffer | string): Promise<void> {
  expect(relative).toMatch(/^[a-z0-9][a-z0-9.-]+$/u);
  await fs.writeFile(path.join(evidenceRoot, relative), bytes, { mode: 0o600, flag: 'wx' });
  receipt.evidence.push({ relative: `natural-workflow-evidence/${relative}`, sha256: bytesHash(bytes) }); await persist();
}
async function screenshot(page: Page, label: string): Promise<void> {
  await artifact(`${label}.png`, await page.screenshot({ fullPage: true, animations: 'disabled' }));
}
async function identity(context: BrowserContext): Promise<Identity> {
  const value = await payload<Identity>(await requestManagedTestSession(context.request), 'Normal authenticated identity');
  if (!value.user?.id || !value.session?.id) throw new Error('The actual user and original auth session are required.');
  return value;
}
async function authenticatedActor(browser: Browser, index: number, credentials?: { email: string; password: string }): Promise<Actor> {
  const context = await createAuthenticatedContext(browser, { baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { Origin: process.env.BASE_URL! } }, credentials);
  // Register immediately so a failed identity/preflight still receives normal closure.
  const actor: Actor = { context, userId: '', authSessionHash: '', name: `Natural workflow user ${index} ${fixture.nonce}`, index, sessions: new Set() };
  if (index === 0) admin = actor; else users.push(actor);
  const current = await identity(context); actor.userId = current.user.id; actor.authSessionHash = bytesHash(current.session.id);
  expect(current.user.role).toBe(index === 0 ? 'admin' : 'user');
  await runManagedTestPreflight(context, { baseURL: process.env.BASE_URL });
  return actor;
}
async function member(browser: Browser, index: 1 | 2): Promise<Actor> {
  const email = process.env[index === 1 ? 'TEST_SECONDARY_EMAIL' : 'TEST_EDITOR_EMAIL'];
  const password = process.env[index === 1 ? 'TEST_SECONDARY_PASSWORD' : 'TEST_EDITOR_PASSWORD'];
  if (!email || !password) throw new Error('The owned Parent must provide two private ordinary-member credentials.');
  const proposed = await mutate(`membership:${index}`, async () => {
    const proposal = await data<{ membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(
      await admin!.context.request.post('/api/admin/organization/memberships', { data: { name: `Natural workflow user ${index} ${fixture.nonce}`, email, role: 'member' } }), 'Ordinary membership proposal', 202);
    receipt.membershipIds.push(proposal.membershipId); await persist();
    expect(proposal.approval.required).toBe(false); expect(proposal.quote.nonBillable).toBe(true);
    const activation = await data<{ membershipId: string; stage: string; execution: { onboardingInitialized: boolean } }>(
      await admin!.context.request.post(`/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`, { data: { password } }), 'Ordinary membership activation');
    expect(activation.membershipId).toBe(proposal.membershipId); expect(activation.stage).toBe('active'); expect(activation.execution.onboardingInitialized).toBe(true);
    return proposal;
  });
  expect(proposed.membershipId).toBeTruthy();
  const actor = await authenticatedActor(browser, index, { email, password });
  expect(actor.userId).not.toBe(admin!.userId); receipt.actorIds.push(actor.userId); await persist(); return actor;
}
async function newPage(actor: Actor): Promise<Page> {
  const page = await actor.context.newPage(); pages.add(page); return page;
}
async function navigate(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId')), { timeout: 30_000 }).toBe(teamId);
}
async function inspectAgent(context = admin!.context): Promise<Inspection> {
  return data(await context.request.get(`/api/agents?${new URLSearchParams({ ...Object.fromEntries(scopeQuery()), agentId: agent.agentId, includeAccess: 'true' })}`), 'Actual exact shared agent');
}
async function management(): Promise<AgentWorkflowManagement> {
  return data(await admin!.context.request.get(workflowPath(true)), 'Actual central workflow');
}
async function currentResource(context = admin!.context): Promise<CapabilityResourceDescriptor> {
  return (await data<{ resource: CapabilityResourceDescriptor }>(await context.request.get(resourcePath()), 'Actual current resource')).resource;
}
async function providerCalls(): Promise<IntegrationBrowserProviderCalls> {
  const value = await payload<IntegrationBrowserProviderCalls>(await admin!.context.request.get(`${fixtureUrl}/__fixture/calls`), 'Owned controlled-provider counters');
  expect(value.executions.length).toBeLessThanOrEqual(100); return value;
}
async function gatewayFlag(request: APIRequestContext): Promise<Flag> {
  return data(await request.get('/api/admin/experimental-settings'), 'Current local gateway flag');
}
async function activateGatewayUi(): Promise<void> {
  originalFlag = await gatewayFlag(admin!.context.request);
  await adminPage!.goto('/en/settings?tab=experimental', { waitUntil: 'domcontentloaded' });
  const toggle = adminPage!.locator('#integration-tool-gateway-enabled'); await expect(toggle).toBeEnabled();
  if (!originalFlag.integrationToolGatewayEnabled) await mutate('flag:ui-enable', async () => {
    const pending = adminPage!.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/experimental-settings' && r.request().method() === 'PATCH');
    await toggle.click(); const saved = await data<{ integrationToolGatewayEnabled: boolean; integrationToolGatewayUpdatedAt: string }>(await pending, 'Admin UI gateway enable');
    expect(saved.integrationToolGatewayEnabled).toBe(true); flagRevision = saved.integrationToolGatewayUpdatedAt;
  });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect((await gatewayFlag(admin!.context.request)).integrationToolGatewayEnabled).toBe(true);
}
async function setupConnections(): Promise<void> {
  const request = admin!.context.request;
  const secrets = await data<{ revision: string; entries: Array<{ key: string }> }>(await request.get('/api/integrations/env?scope=integrations&secretScope=organization&key=COMPOSIO_API_KEY'), 'Own central integration secret preflight');
  expect(secrets.entries.some(entry => entry.key === 'COMPOSIO_API_KEY')).toBe(false);
  await mutate('central-secrets:controlled-provider', async () => payload(await request.patch('/api/integrations/env', { data: {
    scope: 'integrations', secretScope: 'organization', baseRevision: secrets.revision,
    patches: [{ key: 'COMPOSIO_API_KEY', value: `owned-natural-fixture-${randomBytes(24).toString('hex')}` }],
  } }), 'Own central controlled-provider secret'));
  const grants = (toolName: string) => [admin!, ...users].map(actor => ({ targetType: 'user', targetId: actor.userId,
    canUse: true, canManage: actor.index === 0, allowedToolNames: [toolName] }));
  teamConnection = await mutate('connection:team-mcp', async () => (await data<{ connection: IntegrationConnectionDescriptor }>(
    await request.post(scoped('/api/integrations/shared-connections'), { data: { source: 'mcp', ownership: { type: 'team', workspaceId: teamId },
      displayName: `Team design ${fixture.nonce}`, accessMode: 'restricted', allowedToolNames: [mcpTool],
      config: { url: `${fixtureUrl}/mcp`, auth: 'none' }, secrets: [], grants: grants(mcpTool) } }), 'Actual Team MCP setup')).connection);
  receipt.connectionRefs.push(teamConnection.resource.connectionRef); await persist();
  expect(teamConnection.resource.ownership).toEqual({ type: 'team', organizationId, workspaceId: teamId });
  const profile = await mutate('profile:organization', async () => (await data<{ profile: { id: string; createdByUserId: string } }>(
    await request.post(scoped('/api/composio/shared-profiles'), { data: { name: `Shared design ${fixture.nonce}`, ownership: { type: 'organization' }, providerMode: 'local' } }), 'Actual shared Composio profile')).profile);
  expect(profile.createdByUserId).toBe(admin!.userId); receipt.profileIds.push(profile.id); await persist();
  orgConnection = await mutate('connection:org-composio', async () => (await data<{ connection: IntegrationConnectionDescriptor }>(
    await request.post(scoped('/api/integrations/shared-connections'), { data: { source: 'composio', ownership: { type: 'organization' },
      profileId: profile.id, toolkit: 'canva', displayName: `Organization design ${fixture.nonce}`, accessMode: 'restricted', allowedToolNames: [composioTool], grants: grants(composioTool) } }), 'Actual Organization Composio setup')).connection);
  receipt.connectionRefs.push(orgConnection.resource.connectionRef); await persist();
  const accountsPath = scoped(`/api/composio/shared-connections/${encodeURIComponent(orgConnection.resource.connectionRef)}/accounts`);
  const selection = await data<{ accounts: Array<{ accountRef: string; selectable: boolean; status: string }>; revisions: {
    metadataRevision: number; grantsRevision: number; bindingRevision: number } }>(await request.get(accountsPath), 'Actual current shared account choices');
  const ready = selection.accounts.filter(account => account.selectable && account.status === 'ACTIVE'); expect(ready).toHaveLength(1);
  orgConnection = await mutate('connection:explicit-account-cas', async () => (await data<{ connection: IntegrationConnectionDescriptor }>(
    await request.patch(accountsPath, { data: { accountRef: ready[0].accountRef, expectedMetadataRevision: selection.revisions.metadataRevision,
      expectedGrantsRevision: selection.revisions.grantsRevision, expectedBindingRevision: selection.revisions.bindingRevision } }), 'Explicit current shared account selection')).connection);
  expect(orgConnection.resource.bindingRevision).toBe(selection.revisions.bindingRevision + 1);
  expect(orgConnection.resource.ownership).toEqual({ type: 'organization', organizationId });
}
function nodeSource(version: 1 | 2): string {
  return `const fs = require('node:fs');\nconst crypto = require('node:crypto');\nconst sdk = require(process.env.CANVAS_SKILL_BRIDGE_MODULE);\n(async () => {\n const args = sdk.arguments();\n const marker = 'SHARED_DESIGN_V${version}_${fixture.nonce}';\n const scratch = JSON.stringify({ marker, label: args.label, query: args.query });\n fs.writeFileSync('design-research.txt', scratch);\n if (fs.readFileSync('design-research.txt', 'utf8') !== scratch) throw new Error('Scratch verification failed');\n const mcp = await sdk.call('design_mcp', { design_query: args.query, exact_match: false });\n const composio = await sdk.call('design_composio', { query: args.query });\n const scratchHash = crypto.createHash('sha256').update(process.cwd()).digest('hex');\n process.stdout.write(JSON.stringify({ marker, version: ${version}, label: args.label, query: args.query, scratchWritten: true, scratchHash, mcp, composio }) + '\\n');\n})().catch(() => { process.stderr.write('The design workflow stopped; inspect the recorded effects before repeating.\\n'); process.exitCode = 1; });\n`;
}
function authoredSkillSource(version: 1 | 2): string {
  return `---\nname: design-research\ndescription: Research designs using the central shared workflow and return its verified package version and both design results.\nmetadata:\n  version: "${version}.0.0"\n---\n\n${sharedWorkflowProtocol}\n`;
}
async function setupPackage(): Promise<void> {
  const intake = process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT;
  if (!intake || path.dirname(intake) !== fixture.dataRoot) throw new Error('The private package intake must belong to the exact owned DATA.');
  sourceDirectory = path.join(intake, packageName); const skill = path.join(sourceDirectory, 'skills', 'design-research');
  await fs.mkdir(path.join(sourceDirectory, '.canvas-plugin'), { recursive: true, mode: 0o700 });
  for (const sub of ['.canvas-skill', 'scripts', 'agents']) await fs.mkdir(path.join(skill, sub), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(sourceDirectory, '.canvas-plugin/plugin.json'), JSON.stringify({ name: packageName, version: '1.0.0',
    description: 'Shared design research workflow', skills: 'skills', connectors: { mcp: [{ name: 'design', required: false }],
      composio: [{ toolkit: 'canva', required: false, tools: [composioTool] }] } }), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(skill, 'SKILL.md'), authoredSkillSource(1), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(skill, 'scripts/research.cjs'), nodeSource(1), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(skill, '.canvas-skill/runtime.json'), JSON.stringify({ version: 1, scripts: [{ id: 'research', displayName: 'Shared design research',
    runtime: { kind: 'node' }, path: 'scripts/research.cjs', argumentsSchema: { type: 'object', additionalProperties: false, required: ['label', 'query'],
      properties: { label: { type: 'string', minLength: 1, maxLength: 128 }, query: { type: 'string', minLength: 1, maxLength: 128 } } },
    tools: [{ alias: 'design_mcp', kind: 'integration', source: 'mcp', toolName: mcpTool },
      { alias: 'design_composio', kind: 'integration', source: 'composio', application: 'canva', toolName: composioTool }], outputs: [] }] }), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(skill, 'agents/canvas.yaml'), `workflow: ${JSON.stringify({ version: 1, integrationCapabilities: [
    { id: 'team-design', application: 'canva', required: true, alternatives: [{ source: 'mcp', connector: 'design', requiredTools: [mcpTool] }] },
    { id: 'org-design', application: 'canva', required: true, alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: [composioTool] }] },
  ] })}\n`, { mode: 0o600, flag: 'wx' });
  const installed = await mutate('package:install', async () => payload<{ success: boolean; plugin: { resourceId: string; name: string } }>(
    await admin!.context.request.post(scoped('/api/plugins/install'), { data: { sourcePath: sourceDirectory, scope: 'organization', enable: true, replace: false } }), 'Actual complete package installation'));
  expect(installed.success).toBe(true); expect(installed.plugin.name).toBe(packageName); legacyResourceId = installed.plugin.resourceId;
  pkg = await mutate('package:explicit-team-authority', async () => (await data<{ resource: CapabilityResourceDescriptor }>(
    await admin!.context.request.post(scoped(`/api/capabilities/resources/${encodeURIComponent(legacyResourceId)}`), { data: {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'team', workspaceId: teamId }, accessMode: 'restricted', grants: [
        { targetType: 'user', targetId: admin!.userId, canUse: true, canEdit: true, canManage: true },
        { targetType: 'user', targetId: users[0].userId, canUse: true, canEdit: false, canManage: false },
      ],
    } }), 'Actual Team package authority')).resource);
  expect(pkg.metadata.ownership).toEqual({ type: 'team', organizationId, workspaceId: teamId });
}
async function openPackage(page: Page): Promise<Locator> {
  await navigate(page, `/en/plugins?${new URLSearchParams({ view: 'installed', scope: 'team', teamId, workspaceId: teamId,
    plugin: packageName, source: 'installed', resourceId: legacyResourceId })}`);
  await page.getByTestId('package-detail-tab-content').click();
  await expect(page.getByTestId('package-detail-tab-content')).toHaveAttribute('aria-selected', 'true');
  const section = page.getByTestId('package-editor'); await expect(section).toBeVisible();
  const disclosure = section.locator(':scope > details');
  if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').filter({ hasText: editorLabels.title }).click();
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(section.getByTestId('package-reload')).toBeEnabled(); return section;
}
async function beginDraft(page: Page): Promise<CapabilityPackageDraft> {
  const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/capabilities/packages/drafts' && r.request().method() === 'POST');
  await page.getByTestId('package-create-edit').click();
  return (await data<{ draft: CapabilityPackageDraft }>(await pending, 'UI private package draft')).draft;
}
async function saveDraftFile(page: Page, draft: CapabilityPackageDraft, file: string, content: string): Promise<CapabilityPackageDraft> {
  const pending = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/file') && new URL(r.url()).searchParams.get('path') === file);
  await page.getByTestId('package-file-picker').selectOption(file); await payload(await pending, 'UI selected complete file');
  await page.getByTestId('package-file-content').fill(content);
  const saved = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/${encodeURIComponent(draft.draftRef)}/file`));
  await page.getByTestId('package-save-file').click();
  const result = (await data<{ draft: CapabilityPackageDraft }>(await saved, 'UI script/manifest save')).draft;
  expect(result.draftRevision).toBe(draft.draftRevision + 1); return result;
}
async function publishUi(page: Page, draft: CapabilityPackageDraft): Promise<Publication> {
  const validated = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/${encodeURIComponent(draft.draftRef)}/validate`));
  await page.getByTestId('package-validate').click();
  const validation = await data<{ validation: { valid: boolean } }>(await validated, 'UI complete package validation'); expect(validation.validation.valid).toBe(true);
  await expect(page.getByTestId('package-publish')).toBeEnabled();
  const published = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/${encodeURIComponent(draft.draftRef)}/publish`));
  await page.getByTestId('package-publish').click(); const result = await data<Publication>(await published, 'UI immutable publication');
  receipt.publications.push({ resourceRef: pkg.metadata.resourceRef, publishedRevisionRef: result.published.revisionRef, checksum: result.published.checksum, version: result.published.version });
  await persist(); await expect(page.getByTestId('package-publish')).toHaveCount(0); pkg = await currentResource(); return result;
}
async function resourceUiChange(): Promise<void> {
  await navigate(adminPage!, `/en/plugins?${new URLSearchParams({ view: 'installed', scope: 'team', teamId, workspaceId: teamId, plugin: packageName, source: 'installed', resourceId: legacyResourceId })}`);
  await adminPage!.getByTestId('package-detail-tab-sharing').click();
  await expect(adminPage!.getByTestId('package-detail-tab-sharing')).toHaveAttribute('aria-selected', 'true');
  const section = adminPage!.getByTestId('resource-management'); await expect(section).toBeVisible();
  const disclosure = section.locator(':scope > details');
  if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').filter({ hasText: resourceLabels.edit }).click();
  await expect(disclosure).toHaveAttribute('open', '');
  await section.getByTestId('resource-description').fill(`Shared workflow metadata ${fixture.nonce}`);
  for (const picker of ['resource-responsible-picker', 'resource-grant-target']) {
    const trigger = section.getByTestId(picker); await trigger.click(); const controls = await trigger.getAttribute('aria-controls');
    if (!controls) throw new Error('The actual user picker did not disclose its active popover.');
    const popover = section.locator(`[data-slot="popover-content"][data-state="open"][id=${JSON.stringify(controls)}]`);
    await popover.getByRole('combobox', { name: resourceLabels.searchTargets, exact: true }).fill(users[1].name);
    await popover.getByTestId(`${picker}-option-${users[1].userId}`).click();
  }
  await section.getByTestId('resource-new-canUse').check();
  await expect(section.getByTestId('resource-new-canEdit')).not.toBeChecked(); await expect(section.getByTestId('resource-new-canManage')).not.toBeChecked();
  await section.getByRole('button', { name: resourceLabels.addGrant, exact: true }).click();
  const before = pkg.metadata;
  pkg = await mutate('resource:ui-responsibility-and-user-circle', async () => {
    const pending = adminPage!.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/capabilities/resources/') && !new URL(r.url()).pathname.endsWith('/targets'));
    await section.getByTestId('resource-save').click(); return (await data<{ resource: CapabilityResourceDescriptor }>(await pending, 'UI shared responsibility and separate Use grant')).resource;
  });
  expect(pkg.metadata.metadataRevision).toBe(before.metadataRevision + 1); expect(pkg.metadata.grantsRevision).toBe(before.grantsRevision + 1);
  expect(pkg.metadata.responsibleUserId).toBe(users[1].userId); expect(pkg.metadata.updatedByUserId).toBe(admin!.userId);
  await screenshot(adminPage!, 'admin-resource-sharing');
}
async function centralUi(publication: Publication, first: boolean): Promise<void> {
  await navigate(adminPage!, `/en/settings?${new URLSearchParams({ tab: 'agent-settings', ...Object.fromEntries(scopeQuery()) })}`);
  const selector = adminPage!.getByRole('button').filter({ hasText: agentName }).filter({ has: adminPage!.getByText(agent.agentId, { exact: true }) });
  await expect(selector).toHaveCount(1); await selector.click(); await adminPage!.getByTestId('agent-settings-workflow-management-open').click();
  const dialog = adminPage!.getByTestId('agent-workflow-management-dialog'); await expect(dialog).toBeVisible();
  if (first) { await dialog.getByRole('button', { name: ui.legacy.configure, exact: true }).click(); await dialog.getByRole('button', { name: ui.packages.add, exact: true }).click(); }
  if (first) {
    await dialog.getByRole('combobox', { name: ui.packages.versionFor.replace('{name}', packageName), exact: true }).selectOption(publication.published.revisionRef);
    await dialog.getByRole('button', { name: ui.packages.addSelected, exact: true }).click();
  }
  const row = dialog.getByTestId('workflow-management-package');
  await expect(row).toBeVisible();
  const disclosure = row.locator('button[aria-expanded]');
  await expect(disclosure).toBeEnabled();
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  if (!first) {
    await row.getByRole('button', { name: ui.packages.versions, exact: true }).click();
    await row.getByRole('combobox', { name: ui.packages.publishedVersion, exact: true }).selectOption(publication.published.revisionRef);
    await row.getByRole('button', { name: ui.packages.useVersion, exact: true }).click();
    // Applying a new immutable version replaces the keyed row and its disclosure.
    await expect(row).toBeVisible();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(disclosure).toBeEnabled(); await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  }
  await row.getByRole('combobox', { name: ui.packages.selection, exact: true }).selectOption('skills');
  await expect(row.getByRole('checkbox', { name: ui.packages.skill.replace('{name}', 'design-research'), exact: true })).toBeChecked();
  const toggle = dialog.getByTestId('workflow-management-bindings-toggle'); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  for (const [id, connection, toolName] of [['team-design', teamConnection, mcpTool], ['org-design', orgConnection, composioTool]] as const) {
    const cap = dialog.getByTestId('workflow-management-capability').filter({ has: adminPage!.getByText(id, { exact: true }) });
    await cap.getByRole('combobox', { name: ui.bindings.modeFor.replace('{application}', 'canva'), exact: true }).selectOption('fixed');
    await cap.getByRole('button', { name: ui.target.shared, exact: true }).click();
    await cap.getByRole('combobox', { name: ui.target.shared, exact: true }).selectOption(connection.resource.connectionRef);
    const confirm = cap.getByRole('checkbox', { name: ui.target.confirmMapping, exact: true });
    if (connection.resource.source === 'mcp') await confirm.check();
    else await expect(confirm).toHaveCount(0);
    await cap.getByRole('button', { name: ui.target.use, exact: true }).click();
    const limits = cap.locator('details').filter({ has: adminPage!.locator('summary').filter({ hasText: ui.bindings.toolLimits }) });
    if (await limits.getAttribute('open') === null) await limits.locator('summary').click();
    await cap.getByRole('checkbox', { name: ui.bindings.limitTools, exact: true }).check();
    await cap.getByRole('textbox', { name: ui.bindings.toolNames, exact: true }).fill(toolName);
  }
  const before = await inspectAgent();
  await mutate(`workflow:ui-pin-v${first ? 1 : 2}`, async () => {
    const pending = adminPage!.waitForResponse(r => new URL(r.url()).pathname === '/api/agents' && r.request().method() === 'PATCH');
    await dialog.getByTestId('workflow-management-save').click(); const response = await pending;
    const body = response.request().postDataJSON() as { agentId: string; expectedRevision: number; expectedWorkflowRevision: number; workflow: AgentWorkflowConfiguration };
    expect(body.agentId).toBe(agent.agentId); expect(body.expectedRevision).toBe(before.agent.revision);
    expect(body.expectedWorkflowRevision).toBe(before.agent.workflowRevision ?? 0);
    await data(response, 'UI central explicit package CAS'); configuration = body.workflow; agent = (await inspectAgent()).agent;
    expect(agent.revision).toBe(before.agent.revision + 1); expect(agent.workflowRevision).toBe((before.agent.workflowRevision ?? 0) + 1);
  });
  expect(configuration.packages).toHaveLength(1); expect(configuration.packages[0]).toMatchObject({ resourceRef: pkg.metadata.resourceRef,
    publishedRevisionRef: publication.published.revisionRef, checksum: publication.published.checksum,
    skillSelection: { kind: 'skills', relativeRoots: ['skills/design-research'] } });
  for (const [id, connection] of [['team-design', teamConnection], ['org-design', orgConnection]] as const) {
    const cap = configuration.packages[0].declarations.flatMap(d => d.capabilities).find(c => c.capabilityId === id);
    expect(cap?.selection).toMatchObject({ mode: 'fixed', target: { kind: 'shared', source: connection.resource.source,
      connectionRef: connection.resource.connectionRef, bindingRevision: connection.resource.bindingRevision,
      ...(connection.resource.source === 'mcp' ? { mcpMapping: { kind: 'manager_confirmation' } } : {}) } });
  }
  const currentManagement = await management();
  expect(currentManagement).toMatchObject({ agentId: agent.agentId, revision: agent.revision, workflowRevision: agent.workflowRevision,
    workflowVersion: 1, configurationState: 'available', unavailablePackageCount: 0, unavailableConnectionCount: 0 });
  // Keep the actual full CAS request unchanged. The public management read replaces only
  // its verified MCP target with an actor/revision/slot-bound opaque retention reference.
  const expectedPublic = structuredClone(configuration);
  const expectedMcp = expectedPublic.packages[0].declarations.flatMap(d => d.capabilities).find(c => c.capabilityId === 'team-design');
  const publicMcp = currentManagement.configuration?.packages[0].declarations.flatMap(d => d.capabilities).find(c => c.capabilityId === 'team-design');
  if (expectedMcp?.selection.mode !== 'fixed' || publicMcp?.selection.mode !== 'fixed' || publicMcp.selection.target.kind !== 'retained') {
    throw new Error('The current public MCP binding must preserve its exact fixed slot using the retention contract.');
  }
  expect(Object.keys(publicMcp.selection.target).sort()).toEqual(['kind', 'retainedBindingRef']);
  expect(publicMcp.selection.target.retainedBindingRef).toMatch(/^agent-workflow-retain:v1:[a-f0-9]{64}$/u);
  expectedMcp.selection.target = structuredClone(publicMcp.selection.target);
  expect(currentManagement.configuration).toEqual(expectedPublic);
  expect(currentManagement.bindingSummaries).toHaveLength(2);
  const currentWorkflow = await data<AgentWorkflowDescriptor>(await admin!.context.request.get(workflowPath()), 'Current saved fixed workflow bindings');
  expect(currentWorkflow).toMatchObject({ agentId: agent.agentId, revision: agent.revision, workflowRevision: agent.workflowRevision, workflowVersion: 1 });
  expect(currentWorkflow.packages).toHaveLength(1);
  expect(currentWorkflow.packages[0]).toMatchObject({ resourceRef: pkg.metadata.resourceRef, publishedRevisionRef: publication.published.revisionRef,
    checksum: publication.published.checksum });
  const currentCapabilities = currentWorkflow.packages[0].declarations.flatMap(d => d.capabilities); expect(currentCapabilities).toHaveLength(2);
  for (const [id, connection] of [['team-design', teamConnection], ['org-design', orgConnection]] as const) {
    const declaration = configuration.packages[0].declarations.find(d => d.capabilities.some(c => c.capabilityId === id))!;
    const selected = declaration.capabilities.find(c => c.capabilityId === id)!;
    if (selected.selection.mode !== 'fixed') throw new Error('The actual saved request must retain both fixed selections.');
    expect(currentManagement.bindingSummaries!.find(s => s.capabilityId === id)).toEqual({ resourceRef: pkg.metadata.resourceRef,
      publishedRevisionRef: publication.published.revisionRef, declarationPath: declaration.declarationPath, capabilityId: id,
      alternativeKey: selected.selection.alternativeKey, source: connection.resource.source, label: connection.resource.displayName,
      scopeLabel: connection.resource.source === 'mcp' ? 'team' : 'organization', status: 'unknown' });
    expect(currentCapabilities.find(c => c.capabilityId === id)).toMatchObject({ selectionMode: 'fixed', selectionOrigin: 'fixed',
      selectedKind: 'shared', personalChoiceAllowed: false, selectedConnection: { connectionRef: connection.resource.connectionRef,
        source: connection.resource.source, scopeLabel: connection.resource.source === 'mcp' ? 'team' : 'organization', availability: 'available', status: 'unknown' } });
  }
  await screenshot(adminPage!, `admin-central-v${first ? 1 : 2}`);
}
async function verifyUseOnlyUi(actor: Actor): Promise<void> {
  const current = await currentResource(actor.context); expect(current.access).toMatchObject({ canUse: true, canEdit: false, canManage: false });
  expect(current.metadata).toEqual(pkg.metadata); expect(current.grants).toBeUndefined();
  expect((await inspectAgent(actor.context)).access).toEqual({ canUse: true, canEdit: false, canManage: false });
  const workflow = await data<AgentWorkflowDescriptor>(await actor.context.request.get(workflowPath()), 'Current Use-only workflow');
  expect(workflow.packages[0]).toMatchObject({ resourceRef: pkg.metadata.resourceRef, publishedRevisionRef: v2.published.revisionRef, checksum: v2.published.checksum });
  const choices = workflow.packages.flatMap(p => p.declarations.flatMap(d => d.capabilities)); expect(choices).toHaveLength(2);
  expect(choices.every(c => c.selectionMode === 'fixed' && c.selectionOrigin === 'fixed' && c.selectedKind === 'shared' && !c.personalChoiceAllowed)).toBe(true);
  expect(choices.map(c => c.selectedConnection?.connectionRef).sort()).toEqual(receipt.connectionRefs.slice().sort());
  for (const connection of [teamConnection, orgConnection]) {
    const actual = (await data<{ connection: IntegrationConnectionDescriptor }>(await actor.context.request.get(scoped(`/api/integrations/shared-connections/${encodeURIComponent(connection.resource.connectionRef)}`)), 'Current Use-only exact connection')).connection;
    expect(actual.access).toEqual({ canRead: true, canUse: true, canManage: false }); expect(actual.resource).toEqual(connection.resource);
  }
  const page = await newPage(actor);
  await navigate(page, `/en/plugins?${new URLSearchParams({ view: 'installed', scope: 'team', teamId, workspaceId: teamId, plugin: packageName, source: 'installed', resourceId: legacyResourceId })}`);
  await page.getByTestId('package-detail-tab-sharing').click();
  await expect(page.getByTestId('package-detail-tab-sharing')).toHaveAttribute('aria-selected', 'true');
  const section = page.getByTestId('resource-management'); await expect(section).toBeVisible(); await expect(section.getByTestId('resource-save')).toHaveCount(0);
  await expect(section).toContainText(users[1].name);
  expect(current.metadata.description).toBe(`Shared workflow metadata ${fixture.nonce}`);
  await screenshot(page, `user-${actor.index}-use-only-fresh`);
  await page.getByTestId('package-detail-tab-content').click();
  await expect(page.getByTestId('package-detail-tab-content')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('package-editor')).toBeVisible();
  await expect(page.getByTestId('package-reload')).toBeEnabled();
  await expect(page.getByTestId('package-create-edit')).toHaveCount(0);
  await expect(page.getByTestId('package-default-activation')).toHaveCount(0);
  await screenshot(page, `user-${actor.index}-content-use-only`);
  await navigate(page, `/en/settings?${new URLSearchParams({ tab: 'agent-settings', ...Object.fromEntries(scopeQuery()) })}`);
  await page.getByRole('button').filter({ hasText: agentName }).filter({ has: page.getByText(agent.agentId, { exact: true }) }).click();
  await expect(page.getByTestId('agent-settings-workflow-management-open')).toHaveCount(0);
  await expect(page.locator('#onboarding-settings-tools')).toHaveCount(0); await screenshot(page, `user-${actor.index}-workflow-use-only`);
}
function blocks(message: Message): Block[] { return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || []; }
function text(messages: Message[]): string { return messages.flatMap(blocks).filter(b => b.type === 'text').map(b => b.text || '').join('\n'); }
async function transcript(actor: Actor, sessionId: string): Promise<Message[]> {
  const url = `/api/sessions/messages?${new URLSearchParams({ agentId: agent.agentId, workspaceId: teamId, sessionId, limit: '200' })}`;
  return (await payload<{ messages: Message[] }>(await actor.context.request.get(url), 'Actual actor-owned model transcript')).messages;
}
async function runNaturalSharedWorkflowAcceptance(actor: Actor): Promise<void> {
  const runtime = await assertNaturalWorkflowModel(actor.context.request, { workspaceId: teamId, agentId: agent.agentId, providerInstallationId: model.installationId, userId: actor.userId });
  expect(runtime.userId).toBe(actor.userId); expect(runtime.organizationId).toBe(organizationId);
  const skillRelativePath = 'skills/design-research/SKILL.md';
  const skillEntries = v2.published.files.filter(file => file.path === skillRelativePath); expect(skillEntries).toHaveLength(1);
  const skillEntry = skillEntries[0];
  expect(v2.published.files.filter(file => file.checksum === skillEntry.checksum)).toHaveLength(1);
  const publishedSkill = await data<{ file: CapabilityPackageFileRead }>(await actor.context.request.get(
    `/api/capabilities/packages/${encodeURIComponent(v2.published.resourceRef)}/file?${new URLSearchParams({ workspaceId: teamId,
      revisionRef: v2.published.revisionRef, path: skillRelativePath })}`), 'Exact actor-readable published V2 skill');
  expect(publishedSkill.file).toMatchObject({ path: skillRelativePath, encoding: 'base64', checksum: skillEntry.checksum,
    size: skillEntry.size, byteLength: skillEntry.size, offset: 0, eof: true });
  const skillBody = Buffer.from(publishedSkill.file.content, 'base64').toString('utf8');
  expect(bytesHash(skillBody)).toBe(skillEntry.checksum);
  expect(skillBody).toBe(authoredSkillSource(2));
  const originalSkillBody = await fs.readFile(path.join(sourceDirectory, skillRelativePath), 'utf8');
  expect(originalSkillBody).toBe(authoredSkillSource(1));
  expect(skillBody).not.toBe(originalSkillBody); expect(skillEntry.checksum).not.toBe(bytesHash(originalSkillBody));
  const olderSkillEntries = v1.published.files.filter(file => file.path === skillRelativePath); expect(olderSkillEntries).toHaveLength(1);
  expect(olderSkillEntries[0].checksum).toBe(bytesHash(authoredSkillSource(1)));
  expect(skillEntry.checksum).not.toBe(olderSkillEntries[0].checksum);
  const resourceUuid = /^canvas-resource:([a-f0-9-]{36})$/u.exec(v2.published.resourceRef)?.[1];
  const revisionUuid = /^canvas-package-revision:([a-f0-9-]{36})$/u.exec(v2.published.revisionRef)?.[1];
  if (!resourceUuid || !revisionUuid) throw new Error('Exact published V2 identities are required for the held skill path.');
  expect(pkg.metadata.ownership).toEqual({ type: 'team', organizationId, workspaceId: teamId });
  const organizationRoot = resolveOrganizationDataRoot(organizationId);
  expect(organizationRoot).toBe(path.join(fixture.dataRoot, 'organizations', organizationId));
  // Team publications use the Org owner root and immutable identity layout from packages/io.ts.
  const skillPath = await fs.realpath(path.join(organizationRoot, 'capability-packages', 'published', resourceUuid,
    revisionUuid, v2.published.name, skillRelativePath));
  expect(bytesHash(await fs.readFile(skillPath))).toBe(skillEntry.checksum);
  const page = await newPage(actor); await navigate(page, `/en/notebook?${new URLSearchParams({ chat: 'open', ...Object.fromEntries(scopeQuery()) })}`);
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 30_000 }); await page.getByTestId('chat-agent-id').click();
  await page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ hasText: agentName }).click();
  await expect(page.getByTestId('chat-agent-id')).toContainText(agentName); await page.getByRole('button', { name: /new chat|neuen chat|neuer chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  const label = `${actor.index === 1 ? 'Anna' : 'Ben'}-${fixture.nonce}`, query = `${actor.index === 1 ? 'Fruehlingskampagne' : 'Sommerkampagne'}-${fixture.nonce}`;
  const before = await providerCalls(); expect(before.executions.length).toBe((actor.index - 1) * 2);
  await mutate(`model:ordinary-user-${actor.index}`, async () => {
    await page.getByTestId('chat-input').fill(`Nutze unseren freigegebenen Workflow „${agentName}“ für die Designrecherche zum Suchwort „${query}“. Verwende die Kennung „${label}“. Führe die veröffentlichte Recherche einmal aus und gib die bestätigten Designs beider gemeinsamen Anbindungen, die tatsächlich verwendete Paketversion und die aktuelle verantwortliche Person zurück.`);
    await page.getByTestId('chat-send').click(); await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', /.+/u, { timeout: 30_000 });
    const sessionId = (await page.getByTestId('chat-session-id').getAttribute('title'))!; actor.sessions.add(sessionId);
    await expect.poll(async () => (await transcript(actor, sessionId)).some(m => m.role === 'assistant' && m.stopReason === 'stop'),
      { timeout: 240_000, intervals: [1000, 2000, 3000] }).toBe(true);
    const messages = await transcript(actor, sessionId), results = messages.filter(m => m.role === 'toolResult'), calls = messages.flatMap(blocks).filter(b => b.type === 'toolCall');
    const content = JSON.stringify(messages); if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('The model transcript exceeds its private evidence bound.');
    await artifact(`user-${actor.index}-transcript.json`, content);
    const actualSessionRuntime = await assertNaturalWorkflowSessionModel(actor.context.request, {
      workspaceId: teamId, agentId: agent.agentId, sessionId, providerInstallationId: model.installationId,
      userId: actor.userId, organizationId,
    });
    await artifact(`user-${actor.index}-session-model.json`, JSON.stringify(actualSessionRuntime));
    expect(results.every(r => !r.isError && !r.details?.error && !r.details?.integrationError)).toBe(true);
    expect(calls.every(c => ['read', 'integrations', ...scriptToolNames, 'inspect_canvas_resource'].includes(c.name || ''))).toBe(true);
    const skillReads = calls.filter(call => call.name === 'read'); expect(skillReads.length).toBeGreaterThan(0);
    expect(new Set(skillReads.map(call => call.id)).size).toBe(skillReads.length);
    expect(results.filter(result => result.toolName === 'read')).toHaveLength(skillReads.length);
    const skillReadProofs: RunProof['skillReads'] = [];
    for (const call of skillReads) {
      // Absolute host paths are removed before persistence and client transport.
      // The complete paired body must uniquely match the actual published V2 file.
      expect(call.id).toBeTruthy(); expect(call.arguments).toEqual({});
      const matched = results.filter(result => result.toolName === 'read' && result.toolCallId === call.id); expect(matched).toHaveLength(1);
      const details = object(matched[0].details);
      expect(details).toMatchObject({ sha256: skillEntry.checksum, type: 'text', size: skillEntry.size,
        textLength: skillBody.length, totalChars: skillBody.length, offset: 0, nextOffset: skillBody.length, eof: true, truncated: false });
      for (const field of ['filePath', 'requestedPath', 'resolvedPath', 'absPath']) expect(details[field]).toBeUndefined();
      expect(details.proposal).toBeUndefined(); expect(details.toolOutputRead).toBeUndefined();
      const layout = object(details.toolOutputReadWindow), returned = text(matched);
      expect(Number.isSafeInteger(layout.bodyStart) && Number.isSafeInteger(layout.bodyEnd)).toBe(true);
      expect(Number(layout.bodyStart)).toBeGreaterThanOrEqual(0); expect(Number(layout.bodyEnd)).toBeGreaterThanOrEqual(Number(layout.bodyStart));
      expect(Number(layout.bodyEnd)).toBeLessThanOrEqual(returned.length);
      const body = returned.slice(Number(layout.bodyStart), Number(layout.bodyEnd)); expect(body).toBe(skillBody);
      expect(bytesHash(body)).toBe(skillEntry.checksum); expect(body).not.toBe(originalSkillBody);
      expect(bytesHash(body)).not.toBe(olderSkillEntries[0].checksum);
      skillReadProofs.push({ toolCallIdHash: bytesHash(call.id!), bodySHA: bytesHash(body), byteLength: Buffer.byteLength(body), relativePath: skillRelativePath });
    }
    expect(results.filter(r => r.toolName === 'integrations').every(r => object(r.details!.integrations).action !== 'call')).toBe(true);
    const runs = results.filter(r => r.toolName === 'run_canvas_skill_script'); expect(runs).toHaveLength(1);
    const run = object(runs[0].details); expect(run).toMatchObject({ kind: 'skill_script_result', success: true, safeToAutoRetry: false,
      id: 'research', runtime: 'node', publishedRevisionRef: v2.published.revisionRef, checksum: v2.published.checksum, stderr: '', files: [] });
    const listed = results.filter(r => r.toolName === 'list_canvas_skill_scripts').flatMap(r => r.details?.scripts as Array<Record<string, unknown>> || []).find(s => s.id === 'research');
    expect(listed).toBeDefined(); expect(listed!.scriptRef).toBe(run.scriptRef); expect(listed!.publishedRevisionRef).toBe(v2.published.revisionRef);
    expect(object(listed!.readiness).available).toBe(true);
    expect(results.some(r => r.toolName === 'describe_canvas_skill_script' && object(r.details!.script).scriptRef === run.scriptRef)).toBe(true);
    const actual = JSON.parse(String(run.stdout).trim()) as { marker: string; version: number; label: string; query: string; scratchWritten: boolean; scratchHash: string; mcp: unknown; composio: unknown };
    expect(actual).toMatchObject({ marker: `SHARED_DESIGN_V2_${fixture.nonce}`, version: 2, label, query, scratchWritten: true }); expect(actual.scratchHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(actual.mcp)).toContain('stage3_MCP_DESIGN'); expect(JSON.stringify(actual.composio)).toContain('stage3_COMPOSIO_DESIGN');
    const answer = text(messages.filter(m => m.role === 'assistant' && m.stopReason === 'stop'));
    for (const value of ['stage3_MCP_DESIGN', 'stage3_COMPOSIO_DESIGN', label, users[1].name]) expect(answer).toContain(value);
    const inspected = results.filter(r => r.toolName === 'inspect_canvas_resource').map(r => object(object(r.details!.capabilityResource).result));
    expect(inspected.some(r => {
      // A legitimate first discovery returns {resources:[...]}, then exact Inspect.
      if (!r.metadata || typeof r.metadata !== 'object' || Array.isArray(r.metadata)) return false;
      const metadata = object(r.metadata);
      return metadata.resourceRef === pkg.metadata.resourceRef && metadata.responsibleUserId === users[1].userId
        && metadata.metadataRevision === pkg.metadata.metadataRevision && metadata.grantsRevision === pkg.metadata.grantsRevision;
    })).toBe(true);
    const runCall = calls.filter(c => c.name === 'run_canvas_skill_script'); expect(runCall).toHaveLength(1);
    expect(runCall[0].arguments?.arguments).toEqual({ label, query });
    const bindings = runCall[0].arguments?.selectedBindings as Array<{ alias: string; toolRef: string; schemaRef: string }>;
    expect(bindings.map(b => b.alias).sort()).toEqual(['design_composio', 'design_mcp']);
    const providers = results.filter(r => r.toolName === 'integrations').flatMap(r => r.details?.providers as IntegrationProviderDescriptor[] || []);
    const effects = run.toolResults as Array<{ toolName: string; result: { details: Record<string, unknown> } }>; expect(effects).toHaveLength(2);
    const safeEffects: RunProof['effects'] = [];
    for (const [source, alias, connection, toolName] of [['mcp', 'design_mcp', teamConnection, mcpTool], ['composio', 'design_composio', orgConnection, composioTool]] as const) {
      const binding = bindings.find(b => b.alias === alias)!;
      const description = results.find(r => r.toolName === 'integrations' && object(r.details!.integrations).action === 'describe'
        && r.details?.toolRef === binding.toolRef && r.details?.schemaRef === binding.schemaRef); expect(description).toBeDefined();
      const providerRef = description!.details!.providerRef;
      expect(providers.some(p => p.providerRef === providerRef && p.source === source && p.scope.resourceId === connection.resource.connectionRef
        && p.scope.type === (source === 'mcp' ? 'workspace' : 'organization'))).toBe(true);
      const effect = effects.find(e => object(e.result.details.integrations).source === source); expect(effect).toBeDefined(); expect(effect!.toolName).toBe('integrations');
      const effectIntegration = object(effect!.result.details.integrations);
      // Call success identifies the provider/tool; the exact schema belongs to
      // selectedBindings and the current describe result checked above.
      expect(effectIntegration).toMatchObject({ version: 1, action: 'call', toolRef: binding.toolRef, providerRef, source });
      expect(effectIntegration.schemaRef).toBeUndefined();
      expect(object(effect!.result.details.integrationReceipt)).toMatchObject({ action: 'call', source, toolName });
      expect(runs[0].toolCallId).toBeTruthy();
      safeEffects.push({ source, toolName, connectionRef: connection.resource.connectionRef,
        toolCallIdHash: bytesHash(`skill-script:${String(run.scriptRef)}:${source === 'mcp' ? 2 : 4}`) });
    }
    const after = await providerCalls(), executions = after.executions.slice(before.executions.length); expect(executions).toHaveLength(2);
    expect(executions.map(e => e.source)).toEqual(['mcp', 'composio']); expect(executions.every(e => e.exactBinding && e.successful)).toBe(true);
    expect(executions[0].argumentsHash).toBe(providerHash(JSON.stringify({ design_query: query, exact_match: false })));
    expect(executions[1].argumentsHash).toBe(providerHash(JSON.stringify({ query }))); expect(executions[1].versionHash).toBe(providerHash('20261006_03'));
    expect(executions[1].accountHash).toBeTruthy(); expect(executions[1].userHash).toBeTruthy();
    if (receipt.sharedAccountHash) { expect(executions[1].accountHash).toBe(receipt.sharedAccountHash); expect(executions[1].userHash).toBe(receipt.sharedProfileEntityHash); }
    else { receipt.sharedAccountHash = executions[1].accountHash; receipt.sharedProfileEntityHash = executions[1].userHash; }
    receipt.runs.push({ actorId: actor.userId, actorHash: bytesHash(actor.userId), authSessionHash: actor.authSessionHash, sessionId, sessionHash: bytesHash(sessionId),
      agentId: agent.agentId, workspaceId: teamId, label, query, scratchHash: actual.scratchHash, transcriptSHA: bytesHash(content),
      scriptCallIdHash: bytesHash(runs[0].toolCallId!), scriptRefHash: bytesHash(String(run.scriptRef)), package: receipt.publications[1],
      selectedBindings: bindings.map(b => ({ alias: b.alias, toolRefHash: bytesHash(b.toolRef), schemaRefHash: bytesHash(b.schemaRef) })),
      skillReads: skillReadProofs, effects: safeEffects, providerExecutions: executions, runtimeHash: hash(actualSessionRuntime) }); receipt.provider = after; await persist();
    await screenshot(page, `user-${actor.index}-natural-result`);
  });
}
async function normalClosure(): Promise<void> {
  const failures: string[] = [];
  if (!passed && evidenceRoot && path.dirname(evidenceRoot) === fixture.fixtureRoot) {
    const observations: Array<{ page: number; closed: boolean; screenshot: string; aria: string; dom: string }> = [];
    for (const [index, page] of Array.from(pages).entries()) {
      if (index >= 8) break;
      const observation = { page: index + 1, closed: page.isClosed(), screenshot: 'not-captured', aria: 'not-captured', dom: 'not-captured' };
      if (!observation.closed) {
        try {
          const bytes = await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 5000 });
          if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Diagnostic screenshot bound.');
          await artifact(`failure-page-${index + 1}.png`, bytes); observation.screenshot = 'captured';
        } catch { observation.screenshot = 'unavailable'; }
        try {
          const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 });
          if (Buffer.byteLength(snapshot) > 1024 * 1024) throw new Error('Diagnostic accessibility bound.');
          await artifact(`failure-page-${index + 1}-aria.txt`, snapshot); observation.aria = 'captured';
        } catch { observation.aria = 'unavailable'; }
        try {
          const url = new URL(page.url());
          const query = Object.fromEntries(['view', 'scope', 'teamId', 'workspaceId', 'organizationId', 'plugin', 'source', 'resourceId', 'resourceRef', 'task', 'file']
            .flatMap(key => { const value = url.searchParams.get(key); return value && /^[A-Za-z0-9._:/-]{1,2048}$/u.test(value) ? [[key, value]] : []; }));
          const state = await page.locator('body').evaluate(body => ({ readyState: document.readyState,
            workspaceId: localStorage.getItem('canvas.activeWorkspaceId'), title: document.title.slice(0, 512),
            headings: Array.from(body.querySelectorAll('h1,h2,h3')).slice(0, 24).map(element => element.textContent?.trim().slice(0, 512) || ''),
            tabs: Array.from(body.querySelectorAll('[role="tab"][data-testid]')).slice(0, 24).map(element => ({
              testId: element.getAttribute('data-testid'), selected: element.getAttribute('aria-selected'), text: element.textContent?.trim().slice(0, 512) || '' })),
            notices: Array.from(body.querySelectorAll('[role="alert"],[role="status"]')).slice(0, 12).map(element => element.textContent?.trim().slice(0, 1024) || ''),
            sections: ['plugin-workspace', 'package-detail-workspace', 'package-editor', 'resource-management', 'agent-workflow-management-dialog']
              .map(testId => ({ testId, present: Boolean(body.querySelector(`[data-testid="${testId}"]`)) })),
          }), undefined, { timeout: 5000 });
          const content = JSON.stringify({ urlHash: bytesHash(page.url()), ownOrigin: url.origin === process.env.BASE_URL,
            pathname: url.origin === process.env.BASE_URL ? url.pathname.slice(0, 512) : 'other-origin', query, state });
          if (Buffer.byteLength(content) > 64 * 1024) throw new Error('Diagnostic DOM bound.');
          await artifact(`failure-page-${index + 1}-dom.json`, content); observation.dom = 'captured';
        } catch { observation.dom = 'unavailable'; }
      }
      observations.push(observation);
    }
    // Diagnosis never changes the original failure, effect counters or closure requirements.
    try { await artifact('failure-diagnostics.json', JSON.stringify({ phase: receipt.phase, outstanding: receipt.outstanding, observations })); }
    catch { /* Normal auth/context closure must still run if a private diagnostic cannot be saved. */ }
  }
  for (const page of pages) try { await page.close(); } catch { failures.push('page-close'); }
  // On a failed/unknown business outcome preserve its sessions and entire fixture.
  // Only the successful owned run deletes its exact actor-owned chats normally.
  if (passed && receipt.outstanding === null) for (const actor of users) for (const sessionId of actor.sessions) {
    try {
      const result = await payload<{ success: boolean; deleted: string }>(await actor.context.request.delete(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId, sessionId, workspaceId: teamId })}`), 'Exact own chat deletion');
      expect(result.success).toBe(true); expect(result.deleted).toBe(sessionId);
    } catch { failures.push('own-chat-delete'); }
  }
  if (flagRevision && originalFlag && admin) try {
    const current = await gatewayFlag(admin.context.request); expect(current.updatedAt).toBe(flagRevision);
    await payload(await admin.context.request.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: originalFlag.integrationToolGatewayEnabled } }), 'Normal owned gateway flag restoration');
    expect((await gatewayFlag(admin.context.request)).integrationToolGatewayEnabled).toBe(originalFlag.integrationToolGatewayEnabled);
  } catch { failures.push('flag-restore'); }
  let signedOut = 0, disposed = 0;
  for (const actor of [...users, ...(admin ? [admin] : [])].reverse()) {
    try {
      const signed = await actor.context.request.post('/api/auth/sign-out', { data: {}, headers: { Origin: process.env.BASE_URL! } });
      if (signed.status() !== 200) throw new Error('Normal sign-out not acknowledged.');
      const session = await requestManagedTestSession(actor.context.request); expect(session.status()).toBe(200); expect(await session.json()).toBeNull();
      signedOut += 1; receipt.normalSessionNull.push(actor.userId || `unresolved-${actor.index}`);
    } catch { failures.push(`auth-close-${actor.index}`); }
    try { await actor.context.close(); disposed += 1; } catch { failures.push(`context-close-${actor.index}`); }
  }
  receipt.authClosed = signedOut === users.length + (admin ? 1 : 0) && signedOut > 0;
  receipt.closedContexts = disposed === users.length + (admin ? 1 : 0) && disposed > 0;
  receipt.phase = passed && receipt.outstanding === null && failures.length === 0 && receipt.authClosed && receipt.closedContexts ? 'verified_closed' : 'preserved';
  if (receipt.phase !== 'verified_closed') receipt.failure = { phase: receipt.outstanding || 'normal-closure', code: 'NATURAL_WORKFLOW_UNCONFIRMED' };
  await persist(); if (failures.length) throw new Error('Normal owned workflow closure failed; the fixture must be preserved.');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  expect(process.env.CANVAS_AGENT_WORKFLOW_NATURAL_MODEL_RUN).toBe('1'); expect(process.env.E2E_EXTERNAL_SERVER).toBe('1');
  expect(process.env.BASE_URL).toBe('http://127.0.0.1:3001');
  const recoveryPath = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE, inputPath = process.env.CANVAS_NATURAL_MODEL_INPUT;
  if (!recoveryPath || !inputPath || !path.isAbsolute(recoveryPath) || !path.isAbsolute(inputPath)) throw new Error('Private owned recovery/model handoff paths are required.');
  const stat = await fs.lstat(recoveryPath); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true); expect(stat.mode & 0o777).toBe(0o600);
  fixture = JSON.parse(await fs.readFile(recoveryPath, 'utf8')) as Fixture;
  expect(fixture).toMatchObject({ version: 1, createAcknowledged: true, phase: 'browser', listenerVerified: true }); expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u);
  expect(fixture.databaseName).toBe(`canvas_connection_test_${fixture.nonce}`); expect(fixture.actorId).toBeTruthy(); expect(fixture.serverPid).toBeGreaterThan(0);
  expect(await fs.realpath(process.cwd())).toBe(fixture.repo); expect(path.dirname(recoveryPath)).toBe(fixture.fixtureRoot);
  expect(await fs.realpath(fixture.fixtureRoot)).toBe(fixture.fixtureRoot); expect((await fs.lstat(fixture.fixtureRoot)).mode & 0o777).toBe(0o700);
  expect(await fs.readFile(path.join(fixture.fixtureRoot, '.fixture-owner'), 'utf8')).toBe(fixture.ownerMarker);
  expect(process.env.DATA).toBe(fixture.dataRoot); expect(process.env.TMPDIR).toBe(fixture.tmpRoot);
  const origin = new URL(process.env.INTEGRATION_BROWSER_FIXTURE_URL || '');
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.search || origin.hash) throw new Error('The exact Parent-owned controlled provider origin is required.');
  fixtureUrl = origin.origin; packageName = `natural-design-${fixture.nonce}`; agentName = `Shared design research ${fixture.nonce}`;
  receiptPath = path.join(fixture.fixtureRoot, 'browser-receipt.json');
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, actorIds: [fixture.actorId], phase: 'setup', outstanding: null,
    closedContexts: false, authClosed: false, normalSessionNull: [], membershipIds: [], workspaceIds: [], agentIds: [], connectionRefs: [], profileIds: [],
    publications: [], runs: [], evidence: [], sourceHashes: {}, domainCleanup: 'owned-parent-after-verified-auth-closure' };
  await fs.writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  evidenceRoot = path.join(fixture.fixtureRoot, 'natural-workflow-evidence'); await fs.mkdir(evidenceRoot, { mode: 0o700 });
  for (const relative of ['tests/agent-workflow-natural-model-local.spec.ts', 'tests/helpers/natural-workflow-model-setup.ts', 'app/lib/skills/script-runtime/sdk/node.cjs',
    'app/lib/skills/script-runtime/tool-bridge.ts', 'app/lib/pi/skill-script-tools.ts', 'app/lib/pi/integration-tool-gateway.ts']) receipt.sourceHashes[relative] = bytesHash(await fs.readFile(path.join(fixture.repo, relative)));
  const owner = await authenticatedActor(browser, 0); expect(owner.userId).toBe(fixture.actorId);
  const health = await payload<{ deployment: { mode: string; teamFeaturesEnabled: boolean } }>(await owner.context.request.get('/api/health'), 'Actual Team license deployment');
  expect(health.deployment).toMatchObject({ mode: 'team', teamFeaturesEnabled: true });
  await member(browser, 1); await member(browser, 2);
  expect(new Set([owner, ...users].map(a => a.userId)).size).toBe(3); expect(new Set([owner, ...users].map(a => a.authSessionHash)).size).toBe(3);
  const listing = await payload<ClientWorkspaceResponse>(await users[0].context.request.get('/api/workspaces'), 'Actual ordinary member workspace');
  organizationId = listing.defaultWorkspace?.organizationId || ''; expect(organizationId).toBeTruthy();
  const team = await mutate('workspace:team', async () => payload<{ success: boolean; workspace: ClientWorkspaceSummary }>(
    await owner.context.request.post('/api/workspaces', { data: { type: 'team', name: `Natural workflow team ${fixture.nonce}` } }), 'Actual owned Team workspace', 201));
  teamId = team.workspace.id; expect(team.workspace).toMatchObject({ type: 'team', organizationId, status: 'active' }); receipt.workspaceIds.push(teamId); await persist();
  for (const actor of users) await mutate(`workspace-member:${actor.index}`, async () => payload(await owner.context.request.post(`/api/workspaces/${encodeURIComponent(teamId)}/members`, {
    data: { userId: actor.userId, role: 'member', canRead: true, canWrite: false, canManage: false } }), 'Ordinary Use-only team member'));
  adminPage = await newPage(owner); await activateGatewayUi();
  model = await mutate('model:central-provision-and-verify', () => provisionNaturalWorkflowModel(owner.context.request, { organizationId, inputPath }));
  receipt.model = { ...model }; await persist();
  await setupConnections(); await setupPackage();
  agent = (await mutate('agent:shared-team-assignment', async () => data<Inspection>(await owner.context.request.post(scoped('/api/agents'), { data: {
    name: agentName, scopeType: 'organization', enabledTools, relevantSkills: [], relevantConnections: [],
    grants: [{ targetType: 'workspace', targetId: teamId, canUse: true, canEdit: false, canManage: false }],
    files: { 'AGENTS.md': `Workflow package resourceRef: ${pkg.metadata.resourceRef}\nThis is the actual stable package reference for exact inspection; a resource list or child-skill reference does not replace it.\n\n${sharedWorkflowProtocol}\n` },
  } }), 'Actual centrally assigned shared agent'))).agent;
  expect(agent.scopeType).toBe('organization'); expect(agent.createdByUserId).toBe(owner.userId); receipt.agentIds.push(agent.agentId); await persist(); receipt.phase = 'ready'; await persist();
});

test.afterAll(async () => { test.setTimeout(180_000); if (receipt) await normalClosure(); });

test('admin publishes script V2 and two Use-only members execute the same shared workflow through the real model', async () => {
  await openPackage(adminPage!); v1 = await mutate('package:ui-publish-v1', async () => publishUi(adminPage!, await beginDraft(adminPage!)));
  expect(v1.published.version).toBe('1.0.0'); await centralUi(v1, true);
  await openPackage(adminPage!);
  v2 = await mutate('package:ui-edit-script-and-publish-v2', async () => {
    let draft = await beginDraft(adminPage!); draft = await saveDraftFile(adminPage!, draft, 'skills/design-research/scripts/research.cjs', nodeSource(2));
    draft = await saveDraftFile(adminPage!, draft, 'skills/design-research/SKILL.md', authoredSkillSource(2));
    const manifest = JSON.stringify({ name: packageName, version: '2.0.0', description: 'Shared design research workflow', skills: 'skills',
      connectors: { mcp: [{ name: 'design', required: false }], composio: [{ toolkit: 'canva', required: false, tools: [composioTool] }] } });
    draft = await saveDraftFile(adminPage!, draft, '.canvas-plugin/plugin.json', manifest); return publishUi(adminPage!, draft);
  });
  expect(v2.published.version).toBe('2.0.0'); expect(v2.state.packageRevision).toBe(v1.state.packageRevision + 1); expect(v2.published.revisionRef).not.toBe(v1.published.revisionRef);
  expect(v2.published.checksum).not.toBe(v1.published.checksum);
  // Publishing does not migrate the central fixed pin: only the next explicit UI CAS does.
  expect((await management()).configuration?.packages[0].publishedRevisionRef).toBe(v1.published.revisionRef);
  const oldFile = await data<{ file: CapabilityPackageFileRead }>(await admin!.context.request.get(`/api/capabilities/packages/${encodeURIComponent(pkg.metadata.resourceRef)}/file?${new URLSearchParams({ workspaceId: teamId, path: 'skills/design-research/scripts/research.cjs', revisionRef: v1.published.revisionRef })}`), 'Immutable older script revision');
  expect(oldFile.file).toMatchObject({ path: 'skills/design-research/scripts/research.cjs', encoding: 'base64', offset: 0, eof: true,
    size: Buffer.byteLength(nodeSource(1)), byteLength: Buffer.byteLength(nodeSource(1)), checksum: bytesHash(nodeSource(1)) });
  expect(Buffer.from(oldFile.file.content, 'base64').toString()).toBe(nodeSource(1));
  const oldSkill = await data<{ file: CapabilityPackageFileRead }>(await admin!.context.request.get(`/api/capabilities/packages/${encodeURIComponent(pkg.metadata.resourceRef)}/file?${new URLSearchParams({ workspaceId: teamId, path: 'skills/design-research/SKILL.md', revisionRef: v1.published.revisionRef })}`), 'Immutable older skill revision');
  expect(oldSkill.file).toMatchObject({ path: 'skills/design-research/SKILL.md', encoding: 'base64', offset: 0, eof: true,
    size: Buffer.byteLength(authoredSkillSource(1)), byteLength: Buffer.byteLength(authoredSkillSource(1)), checksum: bytesHash(authoredSkillSource(1)) });
  expect(Buffer.from(oldSkill.file.content, 'base64').toString('utf8')).toBe(authoredSkillSource(1));
  expect(oldSkill.file.checksum).not.toBe(bytesHash(authoredSkillSource(2)));
  await resourceUiChange(); await centralUi(v2, false);
  const before = { central: await management(), resource: await currentResource(), connections: [teamConnection.resource, orgConnection.resource] };
  receipt.centralConfigurationHash = hash(before.central); receipt.finalResourceHash = hash(before.resource); receipt.finalConnectionsHash = hash(before.connections); await persist();
  expect((await providerCalls()).executions).toEqual([]);
  for (const actor of users) { await verifyUseOnlyUi(actor); await runNaturalSharedWorkflowAcceptance(actor); }
  expect(receipt.runs).toHaveLength(2); expect(new Set(receipt.runs.map(r => r.actorId)).size).toBe(2);
  expect(new Set(receipt.runs.map(r => r.sessionId)).size).toBe(2); expect(new Set(receipt.runs.map(r => r.authSessionHash)).size).toBe(2);
  expect(new Set(receipt.runs.map(r => r.scratchHash)).size).toBe(2);
  for (const alias of ['design_mcp', 'design_composio']) expect(new Set(receipt.runs.map(r => r.selectedBindings.find(b => b.alias === alias)!.schemaRefHash)).size).toBe(2);
  expect(receipt.runs.every(r => r.agentId === agent.agentId && r.workspaceId === teamId && r.package.publishedRevisionRef === v2.published.revisionRef && r.package.checksum === v2.published.checksum)).toBe(true);
  const finalProvider = await providerCalls(); expect(finalProvider.executions).toHaveLength(4);
  expect(finalProvider.executions.every(e => e.successful && e.exactBinding)).toBe(true);
  expect(finalProvider.executions.filter(e => e.source === 'mcp')).toHaveLength(2); expect(finalProvider.executions.filter(e => e.source === 'composio')).toHaveLength(2);
  expect(hash(await management())).toBe(receipt.centralConfigurationHash); expect(hash(await currentResource())).toBe(receipt.finalResourceHash);
  const finalConnections: IntegrationConnectionDescriptor[] = [];
  for (const connection of [teamConnection, orgConnection]) finalConnections.push((await data<{ connection: IntegrationConnectionDescriptor }>(
    await admin!.context.request.get(scoped(`/api/integrations/shared-connections/${encodeURIComponent(connection.resource.connectionRef)}`)), 'Final exact central connection authority')).connection);
  expect(hash(finalConnections.map(c => c.resource))).toBe(receipt.finalConnectionsHash);
  receipt.provider = finalProvider; receipt.phase = 'verified'; await persist(); passed = true;
});
