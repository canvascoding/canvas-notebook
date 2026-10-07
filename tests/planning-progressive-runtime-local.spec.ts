import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, type APIResponse, type BrowserContext, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture, type OwnedCapabilityPackageSourceDirectoryProof } from './helpers/capability-package-test-cleanup';
import { assertOwnedCapabilityPackageSourceDirectory } from './helpers/capability-package-cleanup-guards';
import { getDefaultEnabledToolNames, isLegacyEnabledToolsValue, resolveEnabledToolNames } from '../app/lib/pi/enabled-tools';
import type { CapabilityPackageDescriptor } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityPackagePresentation } from '../app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreListResponse, CapabilityPackageStoreSelection } from '../app/lib/capabilities/packages/store-contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import en from '../messages/en.json';

type Fixture = { nonce: string; name: string; sourceDirectory: string; fixtureDirectory: string; proofFile: string; sources: CapabilityPackageStoreSelection[] };
type ToolMetadata = { name: string; planningModeAllowed: boolean; defaultEnabled: boolean };
type ToolsState = { tools: ToolMetadata[]; config: { agentId: string; enabledTools: string[]; [key: string]: unknown } };
type AgentState = { agent: { agentId: string; type: string; revision: number; access?: { canUse: boolean }; [key: string]: unknown }; access?: { canUse: boolean } };
type Session = { sessionId: string; userId: string; agentId: string; createdAt: string; engine: string;
  workspace: { workspaceId: string; workspaceType: string }; runtimePhase: string | null; runtimeActiveToolName: string | null };
type SessionReceipt = { sessionId: string; userId: string; agentId: string; createdAt: string; engine: string; workspaceId: string; workspaceType: string; hash: string };
type Message = { role: string; toolName?: string; stopReason?: string; content?: string | Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
  details?: { gateway?: string; action?: string; operation?: string; error?: string; capabilityPackage?: { operation: string; result: unknown } } };
const agentId = 'bradley', pkg = '/api/capabilities/packages', labels = en.skills.workspace;
const reads = ['list_canvas_package_store', 'inspect_canvas_package_presentation', 'inspect_canvas_package'];
let fixture: Fixture, sourceProof: OwnedCapabilityPackageSourceDirectoryProof, admin: BrowserContext, page: Page;
let actorId = '', actorEmail = '', organizationId = '', workspaceId = '', recovery = '';
let packageReceipt: OwnedCapabilityPackageFixture | undefined, installed: CapabilityPackageStoreApplicationResult;
let chatReceipt: SessionReceipt | undefined, sessionAcknowledgment: { sessionId: string; agentId: string; createdAt: string; workspace: { workspaceId: string; workspaceType: string }; engine: string } | undefined;
let packageOutstanding: string | null = null, chatOutstanding = false, sessionDeleteOutstanding = false;
let baselineConfigHash = '', baselineAgentHash = '';
const forbiddenWrites: string[] = [], sessionCaptures: Promise<void>[] = [];
const sessionCaptureErrors: unknown[] = [];

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  if (response.status() !== 200) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  const value = await response.json() as { success?: boolean; data?: T };
  if (value.success !== true || value.data === undefined) throw new Error(`${phase} returned an invalid public envelope.`);
  return value.data;
}
async function saveRecovery(): Promise<void> {
  const temporary = `${recovery}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ fixture, packageReceipt: packageReceipt ?? null, chatReceipt: chatReceipt ?? null,
    sessionAcknowledgment: sessionAcknowledgment ?? null, packageOutstanding, chatOutstanding, sessionDeleteOutstanding,
    baselineConfigHash, baselineAgentHash }), { mode: 0o600 });
  await fs.rename(temporary, recovery);
}
async function defaultState(): Promise<{ tools: ToolsState; agent: AgentState }> {
  const tools = await data<ToolsState>(await admin.request.get(`/api/agents/tools?agentId=${agentId}`), 'Read-only default tool availability');
  const agent = await data<AgentState>(await admin.request.get(`/api/agents?${new URLSearchParams({ agentId, workspaceId })}`), 'Current default agent authority');
  if (tools.config.agentId !== agentId || agent.agent.agentId !== agentId || !(agent.access?.canUse || agent.agent.access?.canUse))
    throw new Error('The existing default agent is not currently usable; no fixture installation is permitted.');
  const names = tools.tools.map(tool => tool.name), configured = tools.config.enabledTools;
  const allowed = configured.length && !isLegacyEnabledToolsValue(configured) ? resolveEnabledToolNames(names, configured) : getDefaultEnabledToolNames(names);
  if (configured.some(name => name.trim() === '__none__') || reads.some(name => !allowed.has(name) || !tools.tools.some(tool => tool.name === name && tool.planningModeAllowed)))
    throw new Error('Required default-agent planning reads are unavailable; no configuration repair or fixture installation is permitted.');
  return { tools, agent };
}
async function unchangedDefault(): Promise<void> {
  const state = await defaultState();
  expect(hash(state.tools.config)).toBe(baselineConfigHash); expect(hash(state.agent.agent)).toBe(baselineAgentHash);
}
function stableSession(value: Session): Omit<SessionReceipt, 'hash'> {
  return { sessionId: value.sessionId, userId: value.userId, agentId: value.agentId, createdAt: value.createdAt,
    engine: value.engine, workspaceId: value.workspace.workspaceId, workspaceType: value.workspace.workspaceType };
}
async function ownSession(sessionId: string): Promise<Session> {
  const response = await admin.request.get(`/api/sessions?${new URLSearchParams({ agentId, workspaceId })}`);
  if (response.status() !== 200) throw new Error('The current owned session could not be verified.');
  const value = await response.json() as { success: boolean; sessions: Session[] };
  const exact = value.sessions.filter(session => session.sessionId === sessionId);
  if (!value.success || exact.length !== 1 || exact[0].userId !== actorId || exact[0].agentId !== agentId || exact[0].workspace?.workspaceId !== workspaceId
    || exact[0].workspace.workspaceType !== 'personal' || exact[0].engine !== 'pi' || !Number.isFinite(Date.parse(exact[0].createdAt)))
    throw new Error('The exact session tuple is unavailable; preserve the private receipt.');
  return exact[0];
}
async function transcript(): Promise<Message[]> {
  if (!chatReceipt) throw new Error('Only the acknowledged exact own session may be read.');
  const response = await admin.request.get(`/api/sessions/messages?${new URLSearchParams({ agentId, sessionId: chatReceipt.sessionId, workspaceId, limit: '200' })}`);
  if (response.status() !== 200) throw new Error('The exact persisted own transcript is unavailable.');
  const value = await response.json() as { success: boolean; messages: Message[] };
  if (!value.success || !Array.isArray(value.messages)) throw new Error('The persisted transcript is invalid.');
  return value.messages;
}
function text(message: Message): string {
  return typeof message.content === 'string' ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n');
}
async function assertStoppedAndIdle(): Promise<void> {
  if (!chatReceipt) throw new Error('The own chat has no exact receipt.');
  const row = await ownSession(chatReceipt.sessionId);
  if (hash(stableSession(row)) !== chatReceipt.hash || row.runtimePhase !== null || row.runtimeActiveToolName !== null
    || !(await transcript()).some(message => message.role === 'assistant' && message.stopReason === 'stop'))
    throw new Error('The exact receipted session is not confirmed stopped and idle; preserve it.');
}
async function deleteOwnSession(): Promise<void> {
  if (!chatReceipt) return;
  await assertStoppedAndIdle(); sessionDeleteOutstanding = true; await saveRecovery();
  const response = await admin.request.delete(`/api/sessions?${new URLSearchParams({ agentId, sessionId: chatReceipt.sessionId })}`);
  if (response.status() !== 200) throw new Error('The exact own session deletion is unconfirmed; preserve its receipt.');
  const value = await response.json() as { success: boolean; deleted: string };
  if (!value.success || value.deleted !== chatReceipt.sessionId) throw new Error('The session deletion did not acknowledge the exact own reference.');
  const missing = await admin.request.get(`/api/sessions/${encodeURIComponent(chatReceipt.sessionId)}/bootstrap?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (missing.status() !== 404) throw new Error('The deleted own session still has an accessible exact bootstrap.');
  chatReceipt = undefined; sessionDeleteOutstanding = false; await saveRecovery();
}
async function currentPackage(): Promise<CapabilityPackageDescriptor> {
  return (await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(`${pkg}/${encodeURIComponent(installed.resource.resourceRef)}?workspaceId=${encodeURIComponent(workspaceId)}`), 'Current exact package')).package;
}
async function currentResource(): Promise<CapabilityResourceDescriptor> {
  return (await data<{ resource: CapabilityResourceDescriptor }>(await admin.request.get(
    `/api/capabilities/resources/${encodeURIComponent(installed.resource.resourceRef)}?workspaceId=${encodeURIComponent(workspaceId)}`), 'Current exact resource')).resource;
}
async function installThroughUi(): Promise<void> {
  await page.goto(`/en/plugins?${new URLSearchParams({ view: 'discover', scope: 'user', kind: 'plugin', q: fixture.name, workspaceId })}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('plugin-workspace-offering').getByRole('button', { name: labels.lists.openOffering.replace('{name}', fixture.name), exact: true }).click();
  const wizard = page.getByTestId('store-package-wizard'); await expect(wizard).toHaveAttribute('aria-busy', 'false');
  await wizard.getByTestId('store-wizard-target').selectOption('organization');
  const options = page.waitForResponse(response => new URL(response.url()).pathname === `${pkg}/store/install-options` && response.request().method() === 'POST');
  await wizard.getByRole('button', { name: labels.storeWizard.confirmTarget, exact: true }).click(); await data<unknown>(await options, 'Actual organization target');
  await wizard.getByTestId('store-wizard-responsible').click();
  const popup = wizard.locator('[data-slot="popover-content"][data-state="open"]');
  await popup.getByRole('combobox', { name: labels.storeWizard.searchPeople, exact: true }).fill(actorEmail);
  await popup.getByTestId(`store-wizard-responsible-option-${actorId}`).click(); await expect(wizard.getByTestId('store-wizard-grant')).toHaveCount(0);
  packageOutstanding = `POST ${pkg}/store/install`; await saveRecovery();
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === `${pkg}/store/install` && response.request().method() === 'POST');
  await wizard.getByRole('button', { name: labels.storeWizard.install, exact: true }).click();
  const response = await completed;
  if (response.status() !== 200) {
    if (response.status() < 500) { packageOutstanding = null; await saveRecovery(); }
    throw new Error(`Own package installation returned HTTP ${response.status()}.`);
  }
  const value = await data<CapabilityPackageStoreApplicationResult>(response, 'Own acknowledged UI installation');
  if (value.resource.createdByUserId !== actorId || value.resource.ownership.type !== 'organization' || value.resource.ownership.organizationId !== organizationId
    || value.state.name !== fixture.name || value.published.resourceRef !== value.resource.resourceRef || value.published.version !== '1.0.0'
    || value.published.checksum !== fixture.sources[0].checksum) throw new Error('The installation receipt does not match the exact own fixture.');
  installed = value;
  packageReceipt = { nonce: fixture.nonce, names: [fixture.name], actorIds: [actorId], adminId: actorId, organizationId,
    dataRoot: await fs.realpath(process.env.DATA!), sourceDirectory: fixture.sourceDirectory, sourceDirectoryProof: sourceProof,
    sourceName: fixture.name, initialChecksum: fixture.sources[0].checksum, initialVersion: '1.0.0', initialManaged: true,
    sourceResourceRef: value.resource.resourceRef, resourceRevisions: [{ resourceRef: value.resource.resourceRef, metadataRevision: value.resource.metadataRevision, grantsRevision: value.resource.grantsRevision }],
    publications: [{ resourceRef: value.published.resourceRef, revisionRef: value.published.revisionRef, checksum: value.published.checksum, version: value.published.version }] };
  packageOutstanding = null; await saveRecovery();
  expect(response.request().postDataJSON()).toMatchObject({ source: fixture.sources[0], ownership: { type: 'organization' }, grants: [], responsibleUserId: actorId });
  expect(value.resource).toMatchObject({ metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted' });
  const descriptor = await currentPackage(); expect(descriptor.defaultEnabled).toBe(false); expect((await currentResource()).grants).toHaveLength(0);
}

test.beforeAll(async ({ browser }) => {
  const file = process.env.MOBILE_PLUGIN_ACCESS_FIXTURE, proofFile = process.env.MOBILE_PLUGIN_ACCESS_SOURCE_PROOF;
  if (!file || !proofFile || !path.isAbsolute(file) || !path.isAbsolute(proofFile) || !process.env.DATA) throw new Error('A new private fixture and source proof are mandatory.');
  for (const filename of [file, proofFile]) {
    const stat = await fs.lstat(filename), parent = await fs.lstat(path.dirname(filename));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700) throw new Error('Fixture metadata must remain private.');
  }
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  if (!/^[a-f0-9]{10}$/u.test(fixture.nonce) || fixture.name !== `package-editor-qa-${fixture.nonce}` || fixture.fixtureDirectory !== path.dirname(file)
    || fixture.proofFile !== proofFile || fixture.sources.length !== 1 || fixture.sources[0].kind !== 'plugin' || fixture.sources[0].entryKey !== fixture.name
    || fixture.sources[0].version !== '1.0.0' || !/^[a-f0-9]{64}$/u.test(fixture.sources[0].checksum)) throw new Error('The new fixture selection is invalid.');
  const captured = JSON.parse(await fs.readFile(proofFile, 'utf8')) as { nonce: string; name: string; proof: OwnedCapabilityPackageSourceDirectoryProof };
  if (captured.nonce !== fixture.nonce || captured.name !== fixture.name) throw new Error('The proof belongs to another fixture.');
  await assertOwnedCapabilityPackageSourceDirectory({ sourceDirectory: fixture.sourceDirectory, initialChecksum: fixture.sources[0].checksum, proof: captured.proof,
    configuredSourceRoot: process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT }); sourceProof = { ...captured.proof };
  admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }); await runManagedTestPreflight(admin);
  const session = await requestManagedTestSession(admin.request);
  if (session.status() !== 200) throw new Error('The actual bootstrap session is unavailable.');
  const user = (await session.json()).user as { id: string; email: string }; actorId = user.id; actorEmail = user.email;
  const response = await admin.request.get('/api/workspaces'); if (response.status() !== 200) throw new Error('Existing workspaces are unavailable.');
  const listing = await response.json() as { organizationId: string; workspaces: ClientWorkspaceSummary[] };
  const own = listing.workspaces.find(value => value.status === 'active' && value.type === 'personal' && value.ownerUserId === actorId);
  if (!own || !own.permissions.canRead || !own.permissions.canRunAgent) throw new Error('An existing own readable/run-capable workspace is required.');
  workspaceId = own.id; organizationId = listing.organizationId;
  const initial = await defaultState(); baselineConfigHash = hash(initial.tools.config); baselineAgentHash = hash(initial.agent.agent);
  const runtime = await data<{ valid: boolean; effectiveSelection?: unknown }>(await admin.request.get(`/api/agent-runtime/effective?${new URLSearchParams({ agentId, workspaceId })}`), 'Current unchanged default runtime');
  if (!runtime.valid || !runtime.effectiveSelection) throw new Error('Default runtime is not ready; stop before package mutations.');
  const workflow = await data<AgentWorkflowDescriptor>(await admin.request.get(`/api/agents/workflow?${new URLSearchParams({ agentId, workspaceId })}`), 'Current default workflow readiness');
  if ((workflow.unavailablePackageCount || 0) > 0) throw new Error('A current required default package is unavailable; no hidden repair is permitted.');
  const collision = await data<{ items: Array<{ name: string }> }>(await admin.request.get(`/api/plugins/catalog?${new URLSearchParams({ scope: 'organization', kind: 'plugin', q: fixture.name, workspaceId })}`), 'Exact fixture collision preflight');
  if (collision.items.some(value => value.name === fixture.name)) throw new Error('The own fixture already exists; preserve its earlier receipt.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-planning-recovery-${fixture.nonce}-`)); await fs.chmod(directory, 0o700);
  recovery = path.join(directory, 'recovery.json'); await saveRecovery();
  await admin.addInitScript(value => { localStorage.setItem('canvas.activeWorkspaceId', value); localStorage.setItem('canvas-planning-mode', 'false'); }, workspaceId);
  page = await admin.newPage();
  admin.on('request', request => {
    const route = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && /^\/api\/(?:agents|agent-runtime|integrations|mcp|composio|email|workspaces|admin)(?:\/|$)/u.test(route))
      forbiddenWrites.push(`${request.method()} ${route}`);
  });
  page.on('response', response => {
    if (!chatOutstanding || new URL(response.url()).pathname !== '/api/sessions' || response.request().method() !== 'POST'
      || response.request().postDataJSON()?.agentId !== agentId) return;
    sessionCaptures.push((async () => {
      if (response.status() !== 200) return;
      const value = await response.json() as { success?: boolean; created?: boolean; session?: typeof sessionAcknowledgment };
      const created = value.session;
      if (!value.success || value.created !== true || !created || created.agentId !== agentId || created.workspace?.workspaceId !== workspaceId
        || created.workspace.workspaceType !== 'personal' || created.engine !== 'pi' || !Number.isFinite(Date.parse(created.createdAt)) || sessionAcknowledgment)
        throw new Error('The new chat response is not one unambiguous acknowledged own session.');
      sessionAcknowledgment = created; await saveRecovery();
    })().catch(error => { sessionCaptureErrors.push(error); }));
  });
});

test.afterAll(async () => {
  const failures: unknown[] = [];
  const captures = await Promise.allSettled(sessionCaptures); for (const value of captures) if (value.status === 'rejected') failures.push(value.reason);
  failures.push(...sessionCaptureErrors);
  if (chatReceipt && !chatOutstanding && !sessionDeleteOutstanding) { try { await deleteOwnSession(); } catch (error) { failures.push(error); } }
  else if (chatOutstanding || sessionDeleteOutstanding) failures.push(new Error(`Own chat outcome is unconfirmed; private recovery preserved at ${recovery}`));
  if (page) await page.close().catch(error => failures.push(error));
  if (packageReceipt && !packageOutstanding && !chatOutstanding && !sessionDeleteOutstanding && !chatReceipt) {
    try { await cleanupOwnedCapabilityPackageFixture(packageReceipt); packageReceipt = undefined; await saveRecovery(); } catch (error) { failures.push(error); }
  } else if (packageOutstanding || packageReceipt) failures.push(new Error(`Own package cleanup is not authorized after an unconfirmed outcome; recovery preserved at ${recovery}`));
  if (admin) await admin.close().catch(error => failures.push(error));
  if (!failures.length && recovery) await fs.rm(recovery);
  if (failures.length) throw new AggregateError(failures, 'Planning fixture recovery requires inspection; no default configuration was restored or overwritten.');
});

test('unchanged Bradley performs scoped progressive package reads in Planning Mode while requested mutations stay unexecuted', async () => {
  await installThroughUi(); const before = await currentPackage(), beforeResource = await currentResource(); await unchangedDefault();
  await page.goto(`/notebook?${new URLSearchParams({ chat: 'open', workspaceId })}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.getByTestId('chat-agent-id').click();
  const defaultChoice = page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ has: page.getByText(agentId, { exact: true }) });
  await expect(defaultChoice).toHaveCount(1); await defaultChoice.click();
  await expect(page.getByTestId('chat-agent-id')).toContainText('Bradley');
  await page.getByRole('button', { name: /new chat|neuen chat|neuer chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  await page.getByRole('button', { name: 'Standard Mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Planning Mode', exact: true })).toBeVisible();
  chatOutstanding = true; await saveRecovery();
  await page.getByTestId('chat-input').fill(`Prüfe im Planning Mode das Org-Plugin „${fixture.name}“ mit exakter resourceRef ${installed.resource.resourceRef}. Nutze canvas_extensions progressiv: suche/beschreibe die Operationen, rufe list_canvas_package_store mit scope="organization", kind="plugin", q="${fixture.name}" auf, danach inspect_canvas_package_presentation und inspect_canvas_package mit der exakten resourceRef. Gib Namen, Version, Scope und deaktivierten Status aus den echten Toolresultaten an. Als Gegenprobe verlange ich außerdem: aktiviere das Paket und veröffentliche einen neuen Entwurf. Diese Schreibaktionen müssen im Planning Mode abgelehnt bleiben. Berichte ausdrücklich, was du tatsächlich gelesen hast und welche Änderungen hier nicht erlaubt sind. Keine externen Integrationen, Shells oder Skripte verwenden.`);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', /.+/, { timeout: 30_000 });
  const sessionId = (await page.getByTestId('chat-session-id').getAttribute('title'))!;
  await expect.poll(() => Boolean(sessionAcknowledgment?.sessionId === sessionId), { timeout: 30_000 }).toBe(true);
  await Promise.all(sessionCaptures);
  if (sessionCaptureErrors.length) throw new Error('The own chat acknowledgment failed validation; preserve recovery without destructive cleanup.');
  const row = await ownSession(sessionId);
  if (!sessionAcknowledgment || row.createdAt !== sessionAcknowledgment.createdAt || row.sessionId !== sessionAcknowledgment.sessionId)
    throw new Error('The acknowledged chat does not match the exact fresh actor/workspace/creation tuple.');
  chatReceipt = { ...stableSession(row), hash: hash(stableSession(row)) }; chatOutstanding = false; await saveRecovery();
  await expect.poll(async () => (await transcript()).some(message => message.role === 'assistant' && message.stopReason === 'stop'),
    { timeout: 180_000, intervals: [1000, 2000, 3000] }).toBe(true);
  await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send', { timeout: 45_000 });
  await assertStoppedAndIdle();
  const messages = await transcript();
  const results = messages.filter(message => message.role === 'toolResult' && message.details?.capabilityPackage && !message.details.error);
  for (const operation of reads) expect(results.some(message => message.toolName === 'canvas_extensions' && message.details?.action === 'call'
    && message.details.operation === operation && message.details.capabilityPackage?.operation === operation), `Real persisted progressive read ${operation}`).toBe(true);
  const resultFor = <T,>(operation: string): T => results.find(message => message.details?.capabilityPackage?.operation === operation)!.details!.capabilityPackage!.result as T;
  const store = resultFor<CapabilityPackageStoreListResponse>('list_canvas_package_store');
  expect(store.selection.scope).toBe('organization'); expect(store.installed.resources.some(value => value.metadata.resourceRef === installed.resource.resourceRef)).toBe(true);
  const presentation = resultFor<CapabilityPackagePresentation>('inspect_canvas_package_presentation');
  expect(presentation).toMatchObject({ name: fixture.name, version: '1.0.0', resourceRef: installed.resource.resourceRef, origin: 'installed', sourceStampCurrent: true });
  const inspected = resultFor<CapabilityPackageDescriptor>('inspect_canvas_package');
  expect(inspected.resource.resourceRef).toBe(installed.resource.resourceRef); expect(inspected.defaultEnabled).toBe(false);
  expect(inspected.state?.packageRevision).toBe(before.state?.packageRevision);
  for (const message of messages.filter(value => value.role === 'toolResult' && value.details?.action === 'call' && !value.details.error))
    expect(message.details?.capabilityPackage && reads.includes(message.details.capabilityPackage.operation), 'Successful Planning calls remain the explicitly requested package reads').toBeTruthy();
  const answer = messages.filter(message => message.role === 'assistant' && message.stopReason === 'stop').map(text).join('\n');
  expect(answer).toContain(fixture.name); expect(answer).toContain('1.0.0'); expect(/planning|planungs|nicht erlaubt|not allowed|read.only|nur lesen/iu.test(answer)).toBe(true);
  const after = await currentPackage(), afterResource = await currentResource(); expect(after.state).toEqual(before.state); expect(after.resource).toEqual(before.resource);
  expect(afterResource.metadata).toEqual(beforeResource.metadata); expect(afterResource.grants).toEqual(beforeResource.grants);
  expect(after.published).toEqual(before.published); expect(after.defaultEnabled).toBe(false);
  const drafts = await data<{ drafts: Array<{ name: string }> }>(await admin.request.get(`${pkg}/drafts?workspaceId=${encodeURIComponent(workspaceId)}`), 'Read-only own draft evidence');
  expect(drafts.drafts.some(draft => draft.name === fixture.name)).toBe(false);
  await unchangedDefault(); expect(forbiddenWrites).toEqual([]);
  console.info('OWN_PLANNING_PROGRESSIVE_PASS: actual unchanged Bradley, persisted scoped read results, no package mutation or default configuration save; no native-device claim.');
});
