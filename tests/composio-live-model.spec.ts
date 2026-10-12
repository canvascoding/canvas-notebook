import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AgentWorkflowConfiguration, AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { CapabilityPackageDraft, CapabilityPackagePublishedRevision, CapabilityPackageState } from '../app/lib/capabilities/packages/contracts';
import type { IntegrationConnectionDescriptor, IntegrationConnectionGrantInput } from '../app/lib/integration-tools/connections/contracts';
import { provisionNaturalWorkflowModel, assertNaturalWorkflowModel, assertNaturalWorkflowSessionModel } from './helpers/natural-workflow-model-setup';
import { LIVE_MODEL_BASE, LIVE_MODEL_TOOL, liveModelApi, liveModelHash, liveModelRecord, liveModelRequire,
  readComposioLiveModelHandoff, readLiveModelIdentity, verifyLiveModelTranscript, writeLiveModelArtifact,
  type LiveModelHandoff, type LiveModelIdentity, type LiveModelMessage } from './helpers/composio-live-model-fixture';

// Root owns the recovered production host, license and encrypted source lineage.
// This test never executes a dispatcher, installs a mock provider or retries a model turn.
type Actor = { index: number; context: BrowserContext; identity?: LiveModelIdentity; sessions: Set<string> };
type Inspection = { agent: AgentProfile; access: { canUse: boolean; canEdit: boolean; canManage: boolean } };
type Flag = { integrationToolGatewayEnabled: boolean; updatedAt: string | null };
type Receipt = { version: 1; nonce: string; actorId: string; actorIds: string[]; organizationId: string; workspaceId: string;
  phase: 'setup' | 'ready' | 'verified_closed' | 'preserved'; outstanding: string | null; authClosed: boolean;
  closedContexts: boolean; normalSessionNull: string[]; memberships: string[]; agentId: string | null;
  targets: LiveModelHandoff['targets']; inputSHA: string; recoverySHA: string; sourceHashes: Record<string, string>;
  runs: Array<Record<string, unknown>>; evidence: Array<{ relative: string; sha256: string }>; cleanupFailures: string[];
  model?: Record<string, unknown>; publication?: Record<string, unknown>; fixedConfigurationHash?: string;
  preservedSourceHashes?: string[]; failure?: { phase: string; code: 'LIVE_COMPOSIO_MODEL_UNCONFIRMED' };
  proofBoundary: string };
const routingProtocol = [
  'Use only the two centrally fixed shared Canva connections in this workflow. Do not use a personal connection or reconnect an account.',
  'Discover with integrations {"action":"list","target":"providers"}. The literal target is providers. Find both current source=composio, application=canva providers: one Organization and one Team/workspace. Preserve the distinct actual providerRef values and exact scope.resourceId identities from that response.',
  'For each provider use integrations {"action":"list","target":"tools","providerRef":"<actual current providerRef>"}. Find CANVA_GET_USERS_ME_CAPABILITIES. Describe each actual tool with integrations {"action":"describe","toolRef":"<actual toolRef>"}. Read its current inputSchema, toolVersion and schemaRef; do not guess or borrow references from another session.',
  'Only after both current descriptions, call each exactly once using integrations {"action":"call","toolRef":"<actual toolRef>","schemaRef":"<same-session described schemaRef>","arguments":{}}. This is a read-only capability check; make no other business call, script, browser action or external mutation. Do not retry an uncertain or failed call.',
  'Return a short comparison of the actual successful capability results and their Organization/Team scope. Stop on an error or uncertain outcome; never invent a successful result.',
].join('\n\n');
const actors: Actor[] = [];
const pages = new Set<Page>();
const originalConnections: IntegrationConnectionDescriptor[] = [];
const currentConnections: IntegrationConnectionDescriptor[] = [];
let input: LiveModelHandoff, receipt: Receipt, receiptPath = '', owner: Actor;
let agent: AgentProfile, model: Awaited<ReturnType<typeof provisionNaturalWorkflowModel>>;
let originalFlag: Flag | undefined, changedFlagRevision: string | null = null, passed = false;
let resource: CapabilityResourceDescriptor, publication: CapabilityPackagePublishedRevision;
const query = () => new URLSearchParams({ organizationId: input.organizationId, workspaceId: input.targets[1].workspaceId });
const scoped = (route: string) => `${route}?${query()}`;
const connectionPath = (ref: string) => scoped(`/api/integrations/shared-connections/${encodeURIComponent(ref)}`);

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0, timeout: 20 * 60_000 });

async function persistLiveModelReceipt(): Promise<void> {
  const temporary = `${receiptPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, receiptPath);
}
async function performLiveModelMutation<T>(phase: string, work: () => Promise<T>): Promise<T> {
  liveModelRequire(receipt.outstanding === null, 'mutation-order');
  receipt.outstanding = phase; await persistLiveModelReceipt();
  const result = await work(); receipt.outstanding = null; await persistLiveModelReceipt(); return result;
}
async function createLiveModelActor(browser: Browser, index: number, email: string, password: string): Promise<Actor> {
  const context = await browser.newContext({ baseURL: LIVE_MODEL_BASE, viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { Origin: LIVE_MODEL_BASE } });
  // Register before sign-in so all partially acknowledged normal logins receive closure.
  const actor: Actor = { index, context, sessions: new Set() }; actors.push(actor);
  liveModelRequire(await liveModelApi(context.request, 'GET', '/api/auth/get-session', 'initial-session', { envelope: 'nullable' }) === null, 'fresh-jar');
  await liveModelApi(context.request, 'POST', '/api/auth/sign-in/email', 'normal-sign-in', {
    data: { email, password }, envelope: 'nullable' });
  actor.identity = await readLiveModelIdentity(context.request);
  liveModelRequire(actor.identity.role === (index === 0 ? 'admin' : 'user'), 'ordinary-role');
  const listing = await liveModelApi<{ defaultWorkspace?: { organizationId?: string } }>(context.request, 'GET', '/api/workspaces', 'actual-organization', { envelope: 'top' });
  liveModelRequire(listing.defaultWorkspace?.organizationId === input.organizationId, 'actual-organization');
  return actor;
}
async function setupLiveModelMembers(browser: Browser): Promise<void> {
  for (const index of [1, 2]) {
    const email = `live-composio-model-${input.nonce}-${index}@example.test`;
    const password = `Live-${randomBytes(32).toString('base64url')}-9!`;
    await performLiveModelMutation(`membership-${index}`, async () => {
      const proposal = await liveModelApi<{ membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(
        owner.context.request, 'POST', '/api/admin/organization/memberships', 'membership-proposal', { status: 202,
          data: { name: `Live Canva member ${index} ${input.nonce}`, email, role: 'member' } });
      liveModelRequire(typeof proposal.membershipId === 'string' && proposal.membershipId.length > 0, 'membership-id');
      receipt.memberships.push(proposal.membershipId); await persistLiveModelReceipt();
      liveModelRequire(proposal.approval.required === false && proposal.quote.nonBillable === true, 'nonbillable-membership');
      const activation = await liveModelApi<{ membershipId: string; stage: string; execution: { onboardingInitialized: boolean } }>(
        owner.context.request, 'POST', `/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`,
        'membership-activation', { data: { password } });
      liveModelRequire(activation.membershipId === proposal.membershipId && activation.stage === 'active'
        && activation.execution.onboardingInitialized === true, 'membership-activation');
    });
    const actor = await createLiveModelActor(browser, index, email, password);
    receipt.actorIds.push(actor.identity!.userId); await persistLiveModelReceipt();
    const member = await performLiveModelMutation(`team-member-${index}`, () => liveModelApi<{ member: { userId: string;
      role: string; canRead: boolean; canWrite: boolean; canManage: boolean } }>(owner.context.request, 'POST',
    `/api/workspaces/${encodeURIComponent(input.targets[1].workspaceId)}/members`, 'team-membership', { envelope: 'top',
      data: { userId: actor.identity!.userId, role: 'member', canRead: true, canWrite: false, canManage: false } }));
    liveModelRequire(member.member.userId === actor.identity!.userId && member.member.role === 'member'
      && member.member.canRead === true && member.member.canWrite === false && member.member.canManage === false, 'team-use-only');
  }
  liveModelRequire(new Set(actors.map(actor => actor.identity!.userId)).size === 3
    && new Set(actors.map(actor => actor.identity!.authSessionHash)).size === 3, 'distinct-actors');
}

async function setupLiveModelRouting(): Promise<void> {
  const teamId = input.targets[1].workspaceId;
  for (const target of input.targets) {
    const actual = (await liveModelApi<{ connection: IntegrationConnectionDescriptor }>(owner.context.request, 'GET', connectionPath(target.connectionRef),
      'original-connection', { workspaceId: teamId })).connection;
    liveModelRequire(actual.resource.connectionRef === target.connectionRef && actual.resource.source === 'composio'
      && actual.resource.application === 'canva' && actual.resource.status === 'active'
      && actual.resource.ownership.type === target.scope && actual.resource.ownership.organizationId === input.organizationId
      && (actual.resource.ownership.type !== 'team' || actual.resource.ownership.workspaceId === teamId)
      && actual.access.canManage === true && Array.isArray(actual.grants)
      && JSON.stringify(actual.resource.allowedToolNames) === JSON.stringify([LIVE_MODEL_TOOL]), 'original-shared-source');
    originalConnections.push(actual);
    const profile = (await liveModelApi<{ profile: { id: string; ownership: unknown; status: string; providerMode: string; canManage: boolean } }>(
      owner.context.request, 'GET', scoped(`/api/composio/shared-profiles/${encodeURIComponent(target.profileId)}`), 'original-profile', { workspaceId: teamId })).profile;
    const profileOwner = liveModelRecord(profile.ownership);
    liveModelRequire(profile.id === target.profileId && profile.status === 'active' && profile.providerMode === 'local'
      && profile.canManage === true && profileOwner.type === target.scope && profileOwner.organizationId === input.organizationId
      && (target.scope !== 'team' || profileOwner.workspaceId === teamId), 'original-profile');
    const originalGrants: IntegrationConnectionGrantInput[] = actual.grants!.map(grant => ({ targetType: grant.targetType,
      targetId: grant.targetId, canUse: grant.canUse, canManage: grant.canManage, allowedToolNames: grant.allowedToolNames }));
    const grants = [...originalGrants, ...actors.filter(actor => actor.index > 0).map(actor => ({ targetType: 'user' as const,
      targetId: actor.identity!.userId, canUse: true, canManage: false, allowedToolNames: [LIVE_MODEL_TOOL] }))];
    const saved = (await performLiveModelMutation(`grant-${target.scope}`, () => liveModelApi<{ connection: IntegrationConnectionDescriptor }>(
      owner.context.request, 'PATCH', connectionPath(target.connectionRef), 'connection-use-grants', { workspaceId: teamId, data: {
        expectedMetadataRevision: actual.resource.metadataRevision, expectedGrantsRevision: actual.resource.grantsRevision,
        expectedBindingRevision: actual.resource.bindingRevision, grants,
      } }))).connection;
    liveModelRequire(saved.resource.metadataRevision === actual.resource.metadataRevision
      && saved.resource.bindingRevision === actual.resource.bindingRevision && saved.resource.grantsRevision === actual.resource.grantsRevision + 1
      && JSON.stringify(saved.resource.ownership) === JSON.stringify(actual.resource.ownership), 'grant-only-cas');
    currentConnections.push(saved);
    receipt.evidence.push(await writeLiveModelArtifact(input.root, `source-${target.scope}.json`, {
      target, original: actual.resource, current: saved.resource, profile, grants: saved.grants }));
  }
  receipt.preservedSourceHashes = originalConnections.map(connection => liveModelHash(JSON.stringify(connection.resource))); await persistLiveModelReceipt();
  const intake = process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT;
  liveModelRequire(intake && path.isAbsolute(intake) && path.dirname(intake) === process.env.DATA, 'owned-intake');
  const intakeStat = await fs.lstat(intake);
  liveModelRequire(intakeStat.isDirectory() && !intakeStat.isSymbolicLink() && intakeStat.uid === process.getuid?.()
    && (intakeStat.mode & 0o777) === 0o700 && await fs.realpath(intake) === intake, 'owned-intake');
  const packageName = `live-canva-policy-${input.nonce}`, skillRoot = 'skills/live-canva-capabilities';
  const source = path.join(intake, packageName);
  await fs.mkdir(source, { mode: 0o700 }); await fs.mkdir(path.join(source, '.canvas-plugin'), { mode: 0o700 });
  await fs.mkdir(path.join(source, skillRoot, 'agents'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name: packageName, version: '1.0.0',
    description: 'Exact shared Canva capability routing', skills: 'skills', connectors: { composio: [{ toolkit: 'canva', required: true, tools: [LIVE_MODEL_TOOL] }] } }), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(source, skillRoot, 'SKILL.md'), `---\nname: live-canva-capabilities\ndescription: Check the two centrally fixed shared Canva capability scopes.\n---\n\n${routingProtocol}\n`, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(source, skillRoot, 'agents/canvas.yaml'), `workflow: ${JSON.stringify({ version: 1,
    integrationCapabilities: input.targets.map(target => ({ id: `${target.scope}-canva`, application: 'canva', required: true,
      alternatives: [{ source: 'composio', toolkit: 'canva', requiredTools: [LIVE_MODEL_TOOL] }] })) })}\n`, { flag: 'wx', mode: 0o600 });
  const installed = await performLiveModelMutation('routing-package-install', () => liveModelApi<{ plugin: { resourceId: string; name: string } }>(
    owner.context.request, 'POST', scoped('/api/plugins/install'), 'routing-package-install', { envelope: 'top',
      data: { sourcePath: source, scope: 'organization', enable: true, replace: false } }));
  liveModelRequire(installed.plugin.name === packageName && typeof installed.plugin.resourceId === 'string', 'routing-package-installed');
  resource = (await performLiveModelMutation('routing-package-grants', () => liveModelApi<{ resource: CapabilityResourceDescriptor }>(
    owner.context.request, 'POST', scoped(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`), 'routing-package-grants',
    { data: { expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'organization' }, accessMode: 'restricted',
      grants: actors.map(actor => ({ targetType: 'user', targetId: actor.identity!.userId, canUse: true,
        canEdit: actor.index === 0, canManage: actor.index === 0 })) } }))).resource;
  const packageRoute = `/api/capabilities/packages/${encodeURIComponent(resource.metadata.resourceRef)}?${new URLSearchParams({ workspaceId: teamId })}`;
  const pkg = (await liveModelApi<{ package: { state: CapabilityPackageState | null } }>(owner.context.request, 'GET', packageRoute, 'routing-package-state')).package;
  const draft = (await performLiveModelMutation('routing-package-draft', () => liveModelApi<{ draft: CapabilityPackageDraft }>(owner.context.request,
    'POST', `/api/capabilities/packages/drafts?${new URLSearchParams({ workspaceId: teamId })}`, 'routing-package-draft', { data: {
      operation: 'edit', resourceRef: resource.metadata.resourceRef, expectedMetadataRevision: resource.metadata.metadataRevision,
      expectedGrantsRevision: resource.metadata.grantsRevision, expectedPackageRevision: pkg.state?.packageRevision ?? 0,
      expectedPublishedRevisionRef: pkg.state?.currentPublishedRevisionRef ?? null } }))).draft;
  const draftRoute = `/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}`;
  const validated = await liveModelApi<{ draft: CapabilityPackageDraft; target: { expectedMetadataRevision: number; expectedGrantsRevision: number };
    validation: { valid: boolean } }>(owner.context.request, 'POST', `${draftRoute}/validate?${new URLSearchParams({ workspaceId: teamId })}`, 'routing-validation');
  liveModelRequire(validated.validation.valid === true, 'routing-validation');
  publication = (await performLiveModelMutation('routing-publication', () => liveModelApi<{ state: CapabilityPackageState; published: CapabilityPackagePublishedRevision }>(
    owner.context.request, 'POST', `${draftRoute}/publish?${new URLSearchParams({ workspaceId: teamId })}`, 'routing-publication', { data: {
      draftRef: draft.draftRef, expectedDraftRevision: validated.draft.draftRevision,
      expectedMetadataRevision: validated.target.expectedMetadataRevision, expectedGrantsRevision: validated.target.expectedGrantsRevision,
      expectedPackageRevision: validated.draft.basePackageRevision, expectedPublishedRevisionRef: validated.draft.basePublishedRevisionRef } }))).published;
  liveModelRequire(publication.resourceRef === resource.metadata.resourceRef && publication.version === '1.0.0', 'immutable-routing');
  const created = await performLiveModelMutation('central-agent', () => liveModelApi<Inspection>(owner.context.request, 'POST', scoped('/api/agents'), 'central-agent', { data: {
    name: `Live Canva read ${input.nonce}`, scopeType: 'organization', relevantSkills: [], relevantConnections: [],
    enabledTools: ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'],
    grants: actors.filter(actor => actor.index > 0).map(actor => ({ targetType: 'user', targetId: actor.identity!.userId, canUse: true, canEdit: false, canManage: false })),
    files: { 'AGENTS.md': `${routingProtocol}\n\nExact Organization connection: ${input.targets[0].connectionRef}\nExact Team connection: ${input.targets[1].connectionRef}\n` },
  } }));
  agent = created.agent; receipt.agentId = agent.agentId; await persistLiveModelReceipt();
  liveModelRequire(agent.scopeType === 'organization' && agent.organizationId === input.organizationId && agent.createdByUserId === input.actorId, 'central-agent-owner');
  const configuration: AgentWorkflowConfiguration = { version: 1, packages: [{ resourceRef: publication.resourceRef,
    publishedRevisionRef: publication.revisionRef, checksum: publication.checksum, skillSelection: { kind: 'skills', relativeRoots: [skillRoot] },
    declarations: [{ declarationPath: `${skillRoot}/agents/canvas.yaml`, capabilities: input.targets.map((target, index) => ({ capabilityId: `${target.scope}-canva`,
      selection: { mode: 'fixed', alternativeKey: 'composio:canva', target: { kind: 'shared', source: 'composio', connectionRef: target.connectionRef,
        bindingRevision: currentConnections[index].resource.bindingRevision }, toolCap: [LIVE_MODEL_TOOL] } })) }] }] };
  agent = (await performLiveModelMutation('central-fixed-routing', () => liveModelApi<{ agent: AgentProfile }>(owner.context.request, 'PATCH', scoped('/api/agents'),
    'central-fixed-routing', { data: { agentId: agent.agentId, expectedRevision: agent.revision, expectedWorkflowRevision: agent.workflowRevision ?? 0,
      workflow: configuration } }))).agent;
  receipt.publication = { resourceRef: publication.resourceRef, publishedRevisionRef: publication.revisionRef, checksum: publication.checksum,
    version: publication.version }; receipt.fixedConfigurationHash = liveModelHash(JSON.stringify(configuration));
  receipt.evidence.push(await writeLiveModelArtifact(input.root, 'fixed-routing.json', { agentId: agent.agentId, revision: agent.revision,
    workflowRevision: agent.workflowRevision, configuration })); await persistLiveModelReceipt();
}

async function runLiveModelTurn(actor: Actor): Promise<void> {
  const teamId = input.targets[1].workspaceId;
  await readLiveModelIdentity(actor.context.request, actor.identity);
  const inspection = await liveModelApi<Inspection>(actor.context.request, 'GET', scoped(`/api/agents`) + `&${new URLSearchParams({ agentId: agent.agentId, includeAccess: 'true' })}`, 'member-agent');
  liveModelRequire(inspection.access.canUse && !inspection.access.canEdit && !inspection.access.canManage
    && inspection.agent.revision === agent.revision && inspection.agent.workflowRevision === agent.workflowRevision, 'agent-use-only');
  const workflow = await liveModelApi<AgentWorkflowDescriptor>(actor.context.request, 'GET', scoped('/api/agents/workflow') + `&${new URLSearchParams({ agentId: agent.agentId })}`, 'member-fixed-workflow');
  const capabilities = workflow.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities));
  liveModelRequire(workflow.workflowVersion === 1 && capabilities.length === 2
    && workflow.access.canUse && !workflow.access.canEdit && !workflow.access.canManage
    && capabilities.every(capability => capability.selectionMode === 'fixed' && capability.selectionOrigin === 'fixed'
      && capability.selectedKind === 'shared' && !capability.personalChoiceAllowed)
    && JSON.stringify(capabilities.map(capability => capability.selectedConnection?.connectionRef).sort())
      === JSON.stringify(input.targets.map(target => target.connectionRef).sort()), 'fixed-two-ref-readback');
  for (let index = 0; index < input.targets.length; index += 1) {
    const actual = (await liveModelApi<{ connection: IntegrationConnectionDescriptor }>(actor.context.request, 'GET',
      connectionPath(input.targets[index].connectionRef), 'member-connection', { workspaceId: teamId })).connection;
    liveModelRequire(actual.access.canRead && actual.access.canUse && !actual.access.canManage && actual.grants === undefined
      && JSON.stringify(actual.resource) === JSON.stringify(currentConnections[index].resource), 'connection-use-only');
  }
  const effective = await assertNaturalWorkflowModel(actor.context.request, { workspaceId: teamId, agentId: agent.agentId,
    providerInstallationId: model.installationId, userId: actor.identity!.userId });
  liveModelRequire(effective.organizationId === input.organizationId, 'central-model-context');
  const page = await actor.context.newPage(); pages.add(page);
  await page.goto(`/en/notebook?${new URLSearchParams({ chat: 'open', workspaceId: teamId, organizationId: input.organizationId })}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 30_000 }); await page.getByTestId('chat-agent-id').click();
  await page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ hasText: agent.name }).click();
  await expect(page.getByTestId('chat-agent-id')).toContainText(agent.name);
  await page.getByRole('button', { name: /new chat|neuen chat|neuer chat/iu }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  await performLiveModelMutation(`model-user-${actor.index}`, async () => {
    await page.getByTestId('chat-input').fill(`Please check my actual Canva capabilities through both centrally fixed shared connections, Organization ${input.targets[0].connectionRef} and Team ${input.targets[1].connectionRef}. Follow the current discovery and schema procedure in your instructions, describe both scopes first, then call CANVA_GET_USERS_ME_CAPABILITIES with {} exactly once per scope. Do not run scripts or make any other business call. Report confirmed successful results only. This is run member-${actor.index}-${input.nonce}.`);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', /.+/u, { timeout: 30_000 });
    const sessionId = await page.getByTestId('chat-session-id').getAttribute('title');
    liveModelRequire(sessionId && sessionId.length <= 200, 'actual-session'); actor.sessions.add(sessionId);
    const route = `/api/sessions/messages?${new URLSearchParams({ agentId: agent.agentId, workspaceId: teamId, sessionId, limit: '200' })}`;
    await expect.poll(async () => (await liveModelApi<{ messages: LiveModelMessage[] }>(actor.context.request, 'GET', route, 'model-transcript', { envelope: 'top' }))
      .messages.some(message => message.role === 'assistant' && message.stopReason === 'stop'), { timeout: 300_000, intervals: [1000, 2000, 3000] }).toBe(true);
    const current = await liveModelApi<{ messages: LiveModelMessage[]; hasMoreBefore: boolean; hasMoreAfter: boolean }>(actor.context.request, 'GET', route, 'final-transcript', { envelope: 'top' });
    liveModelRequire(current.hasMoreBefore === false && current.hasMoreAfter === false, 'whole-transcript');
    const { protocol, ...verified } = verifyLiveModelTranscript(current.messages, input);
    const sessionModel = await assertNaturalWorkflowSessionModel(actor.context.request, { workspaceId: teamId, agentId: agent.agentId, sessionId,
      providerInstallationId: model.installationId, userId: actor.identity!.userId, organizationId: input.organizationId });
    await readLiveModelIdentity(actor.context.request, actor.identity);
    receipt.evidence.push(await writeLiveModelArtifact(input.root, `user-${actor.index}-session-model.json`, sessionModel));
    receipt.evidence.push(await writeLiveModelArtifact(input.root, `user-${actor.index}-protocol.json`, protocol));
    // Retain discovery/schema/request facts, not external Canva result bodies or raw model text.
    const proof = { actorId: actor.identity!.userId, authSessionHash: actor.identity!.authSessionHash, sessionId,
      agentId: agent.agentId, workspaceId: teamId, organizationId: input.organizationId, ...verified,
      runtimeHash: liveModelHash(JSON.stringify(sessionModel)), effectiveHash: liveModelHash(JSON.stringify(effective)),
      role: 'user', access: { canUse: true, canEdit: false, canManage: false }, businessCalls: 2 };
    receipt.evidence.push(await writeLiveModelArtifact(input.root, `user-${actor.index}-read-proof.json`, proof)); receipt.runs.push(proof);
    await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 30_000 });
    const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled' });
    liveModelRequire(screenshot.length <= 16 * 1024 * 1024 && screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'ui-png');
    const relative = `live-composio-model-evidence/user-${actor.index}-model-ui.png`;
    await fs.writeFile(path.join(input.root, relative), screenshot, { flag: 'wx', mode: 0o600 });
    receipt.evidence.push({ relative, sha256: liveModelHash(screenshot) });
  });
}

async function closeLiveModelAcceptance(): Promise<void> {
  const failures: string[] = [];
  for (const page of pages) try { await page.close(); } catch { failures.push('page-close'); }
  if (passed && receipt.outstanding === null) for (const actor of actors.filter(value => value.index > 0)) for (const sessionId of actor.sessions) {
    try {
      await readLiveModelIdentity(actor.context.request, actor.identity);
      const removed = await liveModelApi<{ deleted: string }>(actor.context.request, 'DELETE', `/api/sessions?${new URLSearchParams({
        agentId: agent.agentId, sessionId, workspaceId: input.targets[1].workspaceId })}`, 'own-chat-delete', { envelope: 'top' });
      liveModelRequire(removed.deleted === sessionId, 'own-chat-delete');
    } catch { failures.push('own-chat-delete'); }
  }
  // Restore only this run's explicitly added grants; an unrelated concurrent mutation fails closed.
  if (owner?.identity) for (let index = 0; index < currentConnections.length; index += 1) try {
    await readLiveModelIdentity(owner.context.request, owner.identity);
    const original = originalConnections[index], selected = currentConnections[index];
    const actual = (await liveModelApi<{ connection: IntegrationConnectionDescriptor }>(owner.context.request, 'GET',
      connectionPath(selected.resource.connectionRef), 'restore-current-grants')).connection;
    liveModelRequire(JSON.stringify(actual.resource) === JSON.stringify(selected.resource)
      && JSON.stringify(actual.grants) === JSON.stringify(selected.grants), 'restore-owned-cas');
    const restored = (await liveModelApi<{ connection: IntegrationConnectionDescriptor }>(owner.context.request, 'PATCH', connectionPath(selected.resource.connectionRef),
      'restore-grants', { data: { expectedMetadataRevision: actual.resource.metadataRevision, expectedGrantsRevision: actual.resource.grantsRevision,
        expectedBindingRevision: actual.resource.bindingRevision, grants: original.grants!.map(grant => ({ targetType: grant.targetType, targetId: grant.targetId,
          canUse: grant.canUse, canManage: grant.canManage, allowedToolNames: grant.allowedToolNames })) } })).connection;
    liveModelRequire(restored.resource.bindingRevision === original.resource.bindingRevision && restored.resource.metadataRevision === original.resource.metadataRevision
      && restored.resource.grantsRevision === actual.resource.grantsRevision + 1, 'restored-source-stable');
  } catch { failures.push('grant-restore'); }
  if (changedFlagRevision && originalFlag && owner?.identity) try {
    await readLiveModelIdentity(owner.context.request, owner.identity);
    const current = await liveModelApi<Flag>(owner.context.request, 'GET', '/api/admin/experimental-settings', 'flag-current');
    liveModelRequire(current.updatedAt === changedFlagRevision && current.integrationToolGatewayEnabled, 'flag-owned-revision');
    await liveModelApi(owner.context.request, 'PATCH', '/api/admin/experimental-settings', 'flag-restore', { data: { integrationToolGatewayEnabled: originalFlag.integrationToolGatewayEnabled } });
    liveModelRequire((await liveModelApi<Flag>(owner.context.request, 'GET', '/api/admin/experimental-settings', 'flag-restored')).integrationToolGatewayEnabled
      === originalFlag.integrationToolGatewayEnabled, 'flag-restored');
  } catch { failures.push('flag-restore'); }
  let signedOut = 0, disposed = 0;
  for (const actor of actors.slice().reverse()) {
    try {
      if (actor.identity) await readLiveModelIdentity(actor.context.request, actor.identity);
      await liveModelApi(actor.context.request, 'POST', '/api/auth/sign-out', 'normal-sign-out', { data: {}, envelope: 'nullable' });
      liveModelRequire(await liveModelApi(actor.context.request, 'GET', '/api/auth/get-session', 'normal-session-null', { envelope: 'nullable' }) === null, 'normal-session-null');
      signedOut += 1; receipt.normalSessionNull.push(actor.identity?.userId ?? `unresolved-${actor.index}`);
    } catch { failures.push('normal-auth-close'); }
    try { await actor.context.close(); disposed += 1; } catch { failures.push('context-close'); }
  }
  receipt.authClosed = signedOut === actors.length && actors.length === 3;
  receipt.closedContexts = disposed === actors.length && actors.length > 0;
  receipt.cleanupFailures = failures;
  receipt.phase = passed && receipt.runs.length === 2 && receipt.outstanding === null && failures.length === 0
    && receipt.authClosed && receipt.closedContexts ? 'verified_closed' : 'preserved';
  if (receipt.phase !== 'verified_closed') receipt.failure = { phase: receipt.outstanding ?? 'normal-closure', code: 'LIVE_COMPOSIO_MODEL_UNCONFIRMED' };
  await persistLiveModelReceipt(); liveModelRequire(failures.length === 0, 'normal-closure');
}

async function runComposioLiveModelAcceptance(browser: Browser): Promise<void> {
  input = await readComposioLiveModelHandoff();
  receiptPath = path.join(input.root, 'live-composio-model-receipt.json');
  receipt = { version: 1, nonce: input.nonce, actorId: input.actorId, actorIds: [], organizationId: input.organizationId,
    workspaceId: input.targets[1].workspaceId, phase: 'setup', outstanding: null, authClosed: false, closedContexts: false,
    normalSessionNull: [], memberships: [], agentId: null, targets: input.targets, inputSHA: input.inputSHA, recoverySHA: input.recoverySHA,
    sourceHashes: {}, runs: [], evidence: [], cleanupFailures: [],
    proofBoundary: 'Browser authenticated model transcript/current schema and session-model readback; independent Parent SQL audit required. No raw external response, private account or historical proof adoption.' };
  await fs.writeFile(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  await fs.mkdir(path.join(input.root, 'live-composio-model-evidence'), { mode: 0o700 });
  for (const relative of ['tests/composio-live-model.spec.ts', 'tests/helpers/composio-live-model-fixture.ts',
    'tests/helpers/natural-workflow-model-setup.ts', 'playwright.composio-live-model-production.config.ts']) {
    receipt.sourceHashes[relative] = liveModelHash(await fs.readFile(path.resolve(relative)));
  }
  await persistLiveModelReceipt();
  try {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL, password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    liveModelRequire(email && password, 'normal-owner-credentials');
    owner = await createLiveModelActor(browser, 0, email, password);
    liveModelRequire(owner.identity!.userId === input.actorId, 'original-owner');
    const health = await liveModelApi<{ deployment: { mode: string; teamFeaturesEnabled: boolean } }>(owner.context.request, 'GET', '/api/health', 'licensed-team', { envelope: 'nullable' });
    liveModelRequire(health.deployment.mode === 'team' && health.deployment.teamFeaturesEnabled, 'licensed-team');
    await setupLiveModelMembers(browser);
    originalFlag = await liveModelApi<Flag>(owner.context.request, 'GET', '/api/admin/experimental-settings', 'gateway-flag');
    if (!originalFlag.integrationToolGatewayEnabled) await performLiveModelMutation('gateway-enable', async () => {
      const saved = await liveModelApi<{ integrationToolGatewayEnabled: boolean; integrationToolGatewayUpdatedAt: string }>(owner.context.request,
        'PATCH', '/api/admin/experimental-settings', 'gateway-enable', { data: { integrationToolGatewayEnabled: true } });
      liveModelRequire(saved.integrationToolGatewayEnabled && typeof saved.integrationToolGatewayUpdatedAt === 'string', 'gateway-enabled');
      changedFlagRevision = saved.integrationToolGatewayUpdatedAt;
    });
    model = await performLiveModelMutation('real-central-model', () => provisionNaturalWorkflowModel(owner.context.request,
      { organizationId: input.organizationId, inputPath: input.modelInputPath }));
    receipt.model = { ...model }; await persistLiveModelReceipt(); await setupLiveModelRouting();
    receipt.phase = 'ready'; await persistLiveModelReceipt();
    for (const actor of actors.filter(value => value.index > 0)) await runLiveModelTurn(actor);
    passed = true;
  } catch {
    receipt.failure = { phase: receipt.outstanding ?? receipt.phase, code: 'LIVE_COMPOSIO_MODEL_UNCONFIRMED' };
    throw new Error('The real Composio model run is unconfirmed; preserve this attempt and inspect its bounded receipt before another run.');
  } finally { await closeLiveModelAcceptance(); }
}

test('two ordinary Use-only users read actual Canva capabilities through both fixed shared connections with the real model', async ({ browser }) => {
  await runComposioLiveModelAcceptance(browser);
});
