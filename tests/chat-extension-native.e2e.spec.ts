import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type BrowserContext, type APIResponse } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedSummary } from '../app/lib/capabilities/packages/contracts';
import type { PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import type { AgentExtensionOptionsResponse } from '../app/lib/agents/extension-options-contracts';
import type { ChatExtensionOptionsResponse } from '../app/lib/chat/extension-options-contracts';
import type { ExtensionPackagePin } from '../app/lib/capabilities/extensions/contracts';
import { nativeExtensionPluginFiles, nativeExtensionStandaloneSkillContent, nativePreparationFailureDiagnostic, nativeExtensionSkillCaption } from '../scripts/helpers/chat-extension-native-fixture';
import { assertNativePreparedSessionIdentity } from '../scripts/helpers/chat-extension-native-proof';
import { assertNativeCentralAgentUnchanged, captureNativeCentralAgentSnapshot } from '../scripts/helpers/chat-extension-native-agent-snapshot';

test.describe.configure({ retries: 0, timeout: 40 * 60_000 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
type Fixture = { version: number; nonce: string; repo: string; root: string; dataRoot: string; databaseName: string; actorId: string; baseURL: string; buildId: string;
  mcpUrl: string; composioOrigin: string; model: { providerInstallationId: string; providerId: string; modelId: string; thinkingLevel: string; expectedCatalogRevision: number } };
async function privateJson(filename: string) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 4 * 1024 * 1024);
    const content = await handle.readFile('utf8'); const current = await fs.lstat(filename); assert.equal(current.ino, stat.ino); assert.equal(current.dev, stat.dev); return JSON.parse(content); }
  finally { await handle.close(); }
}
async function json<T>(response: APIResponse, phase: string, status = 200): Promise<T> {
  if (response.status() !== status) {
    const fixture = await privateJson(process.env.PLUGIN_EXTENSION_E2E_FIXTURE!);
    const root = await fs.lstat(fixture.root);
    assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
    const diagnostic = nativePreparationFailureDiagnostic({ phase, pathname: new URL(response.url()).pathname,
      status: response.status(), expectedStatus: status, bytes: await response.body() });
    await fs.writeFile(path.join(fixture.root, `native-preparation-failure-${randomUUID()}.json`), JSON.stringify(diagnostic), { mode: 0o600, flag: 'wx' });
  }
  expect(response.status(), phase).toBe(status); return response.json();
}
async function data<T>(response: APIResponse, phase: string): Promise<T> { const result = await json<{ success: boolean; data: T }>(response, phase); expect(result.success, phase).toBe(true); return result.data; }
async function publish(owner: BrowserContext, workspaceId: string, name: string, kind: 'skill' | 'plugin'): Promise<ExtensionPackagePin> {
  const scope = (url: string) => `${url}?${new URLSearchParams({ workspaceId })}`;
  const listing = await data<PluginExtensionSearchResponse>(await owner.request.get(`${scope('/api/plugins/search')}&${new URLSearchParams({ q: name, types: kind })}`), 'Installed actual package');
  const item = listing.items.find(row => row.kind === kind && row.name === name && (row.kind === 'skill' || row.kind === 'plugin') && row.package);
  assert(item && (item.kind === 'skill' || item.kind === 'plugin') && item.package);
  const read = async (ref: string) => (await data<{ package: CapabilityPackageDescriptor }>(await owner.request.get(scope(`/api/capabilities/packages/${encodeURIComponent(ref)}`)), 'Actual source revisions')).package;
  const current = await read(item.package.resourceRef);
  const draft = (await data<{ draft: CapabilityPackageDraft }>(await owner.request.post(scope('/api/capabilities/packages/drafts'), { data: { operation: 'edit', resourceRef: current.resource.resourceRef,
    expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision, expectedPackageRevision: current.state?.packageRevision ?? 0,
    expectedPublishedRevisionRef: current.state?.currentPublishedRevisionRef ?? null } }), 'Actual publication draft')).draft;
  const fresh = await read(draft.resourceRef);
  const published = (await data<{ published: CapabilityPackagePublishedSummary }>(await owner.request.post(scope(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish`), { data: {
    draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: fresh.resource.metadataRevision, expectedGrantsRevision: fresh.resource.grantsRevision,
    expectedPackageRevision: fresh.state?.packageRevision ?? 0, expectedPublishedRevisionRef: fresh.state?.currentPublishedRevisionRef ?? null } }), 'Publish immutable source')).published;
  return { resourceRef: draft.resourceRef, publishedRevisionRef: published.revisionRef, checksum: published.checksum };
}
async function runNative(mobileRepo: string, inputPath: string, fixture: Fixture) {
  const log = await fs.open(`${inputPath}.log`, 'wx', 0o600);
  const child = spawn(process.execPath, [path.join(mobileRepo, 'scripts/chat-extension-native-e2e.mjs'), '--execute'], { cwd: mobileRepo, detached: true,
    stdio: ['ignore', log.fd, log.fd], env: { NODE_ENV: 'test', ...Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
      JAVA_HOME: process.env.JAVA_HOME, ANDROID_HOME: process.env.ANDROID_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
      CANVAS_CHAT_NATIVE_E2E: '1', CANVAS_NATIVE_EXTENSION_DEVICE_CONFIG: process.env.CANVAS_NATIVE_EXTENSION_DEVICE_CONFIG,
      CANVAS_NATIVE_EXTENSION_INPUT: inputPath, CANVAS_NATIVE_EXTENSION_ROOT: fixture.root }).filter((row): row is [string, string] => typeof row[1] === 'string')) } });
  await log.close(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { const result = await Promise.race([new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGTERM'); } catch {} reject(new Error('The owned native phase exceeded its deadline.')); }, 12 * 60_000); })]);
    assert.equal(result, 0, 'The actual native phase must pass. Inspect the private native artifacts.'); }
  finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
    await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 4_000))]);
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
  } }
  return privateJson(`${inputPath}.receipt.json`);
}

test('real native clients retain exact extension references and agent choices across editing, send and reload', async ({ browser }) => {
  expect(process.env.CANVAS_CHAT_NATIVE_E2E).toBe('1'); expect(process.env.CANVAS_PLUGIN_EXTENSION_E2E).toBe('1');
  const fixture = await privateJson(process.env.PLUGIN_EXTENSION_E2E_FIXTURE!) as Fixture;
  assert.equal(fixture.repo, await fs.realpath(process.cwd())); assert.equal(fixture.root, path.dirname(process.env.PLUGIN_EXTENSION_E2E_FIXTURE!));
  assert.equal(fixture.buildId, (await fs.readFile('.next/BUILD_ID', 'utf8')).trim()); assert.match(fixture.nonce, /^[a-f0-9]{32}$/u);
  const devices = await privateJson(process.env.CANVAS_NATIVE_EXTENSION_DEVICE_CONFIG!);
  const mobileRepo = await fs.realpath(devices.mobileRepo); assert.equal(mobileRepo, devices.mobileRepo);
  const owner = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, extraHTTPHeaders: { Origin: fixture.baseURL } });
  const receipts: unknown[] = [], platforms: Record<string, unknown>[] = [];
  try {
    await runManagedTestPreflight(owner, { baseURL: fixture.baseURL });
    const actor = await json<{ user: { id: string } }>(await requestManagedTestSession(owner.request), 'Actual owner'); assert.equal(actor.user.id, fixture.actorId);
    const workspaces = await json<{ workspaces: Array<{ id: string; type: string; ownerUserId: string; status: string }> }>(await owner.request.get('/api/workspaces'), 'Actual workspaces');
    const workspaceId = workspaces.workspaces.find(row => row.ownerUserId === fixture.actorId && row.type === 'personal' && row.status === 'active')!.id;
    const suffix = fixture.nonce.slice(0, 10), pluginName = `native-plugin-${suffix}`, skillName = `native-skill-${suffix}`, standaloneMcpName = `Native solo MCP ${suffix}`;
    const connector = `native-mcp-${suffix}`, mcpName = connector, childRoot = `skills/native-child-${suffix}`, declarationPath = `${childRoot}/agents/canvas.yaml`;
    const source = path.join(fixture.dataRoot, 'intake', pluginName);
    const mcpConfiguration = { url: fixture.mcpUrl, transport: 'http', auth: 'oauth' };
    for (const [relative, content] of Object.entries(nativeExtensionPluginFiles({ name: pluginName, childRoot, connector, mcpConfiguration }))) {
      const filename = path.join(source, relative); await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(filename, content, { mode: 0o600, flag: 'wx' });
    }
    await json(await owner.request.post('/api/plugins/install', { data: { sourcePath: source, scope: 'user', enable: true } }), 'Normal plugin import');
    await json(await owner.request.post('/api/skills/upload', { data: { content: nativeExtensionStandaloneSkillContent(skillName) } }), 'Normal skill import');
    const pluginPin = await publish(owner, workspaceId, pluginName, 'plugin'), skillPin = await publish(owner, workspaceId, skillName, 'skill');
    const current = await data<{ rawContent: string }>(await owner.request.get('/api/integrations/mcp-config'), 'Current MCP configuration');
    const definitionScope = await data<{ organizationId: string | null }>(await owner.request.get('/api/integrations/mcp-definitions'), 'Actual MCP definition organization');
    assert(typeof definitionScope.organizationId === 'string' && definitionScope.organizationId);
    const configuration = JSON.parse(current.rawContent);
    const saved = await data<{ rawContent: string }>(await owner.request.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify({ ...configuration, mcpServers: { ...configuration.mcpServers,
      [mcpName]: { ...mcpConfiguration, organizationId: definitionScope.organizationId }, [standaloneMcpName]: mcpConfiguration } }) } }), 'Create exact own MCP');
    const mcpRef = `mcp-personal:${JSON.parse(saved.rawContent).mcpServers[mcpName].connectionId}`;
    const standaloneMcpRef = `mcp-personal:${JSON.parse(saved.rawContent).mcpServers[standaloneMcpName].connectionId}`; assert.notEqual(standaloneMcpRef, mcpRef);
    const approved = await data<{ id: string }>(await owner.request.post('/api/integrations/mcp-definitions', { data: {
      action: 'publish', server: mcpName, name: `Native approved MCP ${suffix}` } }), 'Approve exact package MCP definition');
    const approvedConfig = JSON.parse(saved.rawContent); approvedConfig.mcpServers[mcpName].serverDefinitionId = approved.id;
    const assigned = await data<{ rawContent: string }>(await owner.request.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify(approvedConfig) } }), 'Assign actual approved MCP definition');
    assert.equal(`mcp-personal:${JSON.parse(assigned.rawContent).mcpServers[mcpName].connectionId}`, mcpRef);
    assert.equal(`mcp-personal:${JSON.parse(assigned.rawContent).mcpServers[standaloneMcpName].connectionId}`, standaloneMcpRef);
    const consentPage = await owner.newPage();
    for (const server of [mcpName, standaloneMcpName]) {
      const authorization = await data<{ authorizationUrl: string }>(await owner.request.post('/api/integrations/mcp-status', { data: { action: 'authorize', server } }), 'Actual exact MCP authorization');
      assert.equal(new URL(authorization.authorizationUrl).origin, new URL(fixture.mcpUrl).origin);
      await owner.setExtraHTTPHeaders({});
      try { await consentPage.goto(authorization.authorizationUrl); const callback = consentPage.waitForResponse(response => new URL(response.url()).pathname === '/api/mcp/oauth/callback');
        await consentPage.getByRole('button', { name: 'Approve', exact: true }).click(); expect((await callback).status()).toBe(200); }
      finally { await owner.setExtraHTTPHeaders({ Origin: fixture.baseURL }); }
    }
    const headers = { 'x-canvas-workspace-id': workspaceId };
    await json(await owner.request.get('/api/composio/profiles', { headers }), 'Default profile initialization');
    const profileId = (await json<{ profile: { id: string } }>(await owner.request.post('/api/composio/profiles', { headers, data: { name: `Native exact profile ${suffix}` } }), 'Create own profile', 201)).profile.id;
    for (let index = 0; index < 2; index++) {
      const auth = await json<{ redirectUrl: string }>(await owner.request.post('/api/composio/connect/canva', { headers, data: { profileId, returnPath: `/en/settings?${new URLSearchParams({ workspaceId })}` } }), 'Actual Composio authorization');
      assert.equal(new URL(auth.redirectUrl).origin, fixture.composioOrigin); await owner.setExtraHTTPHeaders({});
      try { await consentPage.goto(auth.redirectUrl); const callback = consentPage.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/callback');
        await consentPage.getByRole('button', { name: 'Approve', exact: true }).click(); expect((await callback).status()).toBe(307); await consentPage.waitForURL(url => url.pathname === '/en/settings'); }
      finally { await owner.setExtraHTTPHeaders({ Origin: fixture.baseURL }); }
    }
    await consentPage.close();
    const agentId = (await data<{ agent: { agentId: string } }>(await owner.request.post(`/api/agents?${new URLSearchParams({ workspaceId })}`, { data: { name: `Native specialist ${suffix}`, scopeType: 'user',
      relevantSkills: [`native-child-${suffix}`, skillName], relevantConnections: null, enabledTools: ['read', 'mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'],
      defaultProviderInstallationId: fixture.model.providerInstallationId, defaultProvider: fixture.model.providerId, defaultModel: fixture.model.modelId,
      defaultThinking: fixture.model.thinkingLevel, expectedCatalogRevision: fixture.model.expectedCatalogRevision } }), 'Actual model-backed native agent')).agent.agentId;
    const target = { kind: 'draft_turn', workspaceId, agentId };
    const options = async (request: Record<string, unknown>) => (await json<{ data: ChatExtensionOptionsResponse }>(await owner.request.post('/api/mobile/v1/chat/extension-options', {
      headers, data: { contractVersion: 2, target, ...request } }), 'Native versioned metadata')).data;
    const item = async (q: string, kind: string) => { const response = await options({ operation: 'search', q, types: [kind] }); assert.equal(response.operation, 'search');
      if (response.operation !== 'search') throw new Error('Search response required.'); const exact = response.items.filter(row => row.item.kind === kind && (kind === 'integration' || row.item.name === q)); assert.equal(exact.length, 1); return exact[0]; };
    const skillItem = await item(skillName, 'skill'); assert(skillItem.selection?.kind === 'skill'); assert.deepEqual(skillItem.selection.package, skillPin);
    const skillVersion = await options({ operation: 'package_version', ...skillPin }); assert(skillVersion.operation === 'package_version');
    const skillCaption = nativeExtensionSkillCaption(skillVersion.package, skillItem.selection);
    const ids = { plugin: (await item(pluginName, 'plugin')).item.id, skill: skillItem.item.id,
      mcp: (await item(standaloneMcpName, 'mcp')).item.id, integration: (await item('canva', 'integration')).item.id };
    const choices = await options({ operation: 'connection_choices', selector: { kind: 'package', package: pluginPin, declarationPath, capabilityId: 'native-connection', alternativeKey: `mcp:${connector}` } });
    assert.equal(choices.operation, 'connection_choices'); if (choices.operation !== 'connection_choices') throw new Error('Connection choices required.');
    const standaloneChoices = await options({ operation: 'connection_choices', selector: { kind: 'standalone', source: 'mcp' } });
    assert.equal(standaloneChoices.operation, 'connection_choices'); if (standaloneChoices.operation !== 'connection_choices') throw new Error('Standalone choices required.');
    const standaloneMcpRow = standaloneChoices.connections.find(row => row.selection.kind === 'mcp' && row.selection.target.connectionRef === standaloneMcpRef); assert(standaloneMcpRow);
    const mcpRow = choices.connections.find(row => row.selection.kind === 'mcp' && row.selection.target.connectionRef === mcpRef); assert(mcpRow);
    const accounts = await options({ operation: 'connection_choices', selector: { kind: 'standalone', source: 'composio', toolkit: 'canva' }, profileId });
    assert.equal(accounts.operation, 'connection_choices'); if (accounts.operation !== 'connection_choices') throw new Error('Account choices required.'); assert.equal(accounts.accounts.length, 2);
    const selectedAccount = accounts.accounts[1]; assert(selectedAccount.selection.kind === 'composio' && selectedAccount.selection.target.kind === 'personal' && selectedAccount.selection.target.accountBinding === 'account');
    const accountId = selectedAccount.selection.target.accountId;
    const savedAccountLabel = `canva · Native exact profile ${suffix} · Account ${createHash('sha256').update(accountId).digest('hex').slice(0, 10)}`;
    const credentialsPath = path.join(fixture.root, 'native-credentials.json'); await fs.writeFile(credentialsPath, JSON.stringify({ email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD }), { mode: 0o600, flag: 'wx' });
    // Android has passed all phases; exercise the remaining iOS form paths first, then require Android again.
    for (const platform of ['ios', 'android'] as const) {
      const session = (await json<{ session: { id: string; agentId: string } }>(await owner.request.post('/api/mobile/v1/sessions', { headers, data: { agentId, title: `Native ${platform} ${suffix}` } }), 'Create real native session', 201)).session;
      assert.equal(session.agentId, agentId);
      await assertNativePreparedSessionIdentity(fixture, { sessionId: session.id, agentId, workspaceId });
      const marker: string = `NATIVE-${fixture.nonce}-${platform}`, newAgentName: string = `Native UI ${platform === 'android' ? 'Android' : 'iOS'} ${suffix}`;
      const common: Record<string, unknown> = { version: 1, nonce: fixture.nonce, root: fixture.root, actorId: fixture.actorId, workspaceId, agentId, sessionId: session.id,
        baseURL: fixture.baseURL, credentialsPath, platform, pluginName, skillName, skillCaption, mcpName: standaloneMcpName, pluginPin, skillPin, mcpRef, standaloneMcpRef, mcpRowId: mcpRow.id, standaloneMcpRowId: standaloneMcpRow.id, connector,
        ids, profileId, accountId, accountLabel: savedAccountLabel, accountSelection: selectedAccount.selection,
        marker, newAgentName };
      const execute = async (phase: string, extra: Record<string, unknown> = {}) => {
        const inputPath = path.join(fixture.root, `native-${platform}-${phase}.json`); await fs.writeFile(inputPath, JSON.stringify({ ...common, ...extra, phase }), { mode: 0o600, flag: 'wx' });
        receipts.push(await runNative(mobileRepo, inputPath, fixture));
      };
      await execute('chat'); await execute('agent-create');
      const agents = await json<{ data: { agents: Array<{ agentId: string; name: string }> } }>(await owner.request.get(`/api/agents?${new URLSearchParams({ workspaceId })}`), 'Actual UI-created agent lookup');
      const created: Array<{ agentId: string; name: string }> = agents.data.agents.filter(row => row.name === newAgentName);
      if (created.length !== 1) {
        // Preserve the mismatch before normal fixture cleanup, without changing the Use assertion.
        // This rechecks the exact private nonce database/owner/session boundary before SQL reads.
        await assertNativePreparedSessionIdentity(fixture, { sessionId: session.id, agentId, workspaceId });
        const configured = await owner.request.get(`/api/agents?${new URLSearchParams({ workspaceId, purpose: 'configure' })}`);
        const currentActor = await json<{ user: { id: string } }>(await requestManagedTestSession(owner.request), 'Actual lookup actor');
        const { openDb } = await import('../app/lib/db'); const database = await openDb();
        try {
          const profiles = await database.all(`SELECT agent_id,name,scope_type,owner_user_id,organization_id,created_by_user_id,access_policy,revision
            FROM agents ORDER BY agent_id LIMIT 129`);
          const memberships = await database.all(`SELECT agent_id,user_id,status,can_use,can_edit,can_manage FROM agent_members WHERE user_id=$1 ORDER BY agent_id LIMIT 129`, [fixture.actorId]);
          const organizationSettings = await database.all('SELECT organization_id,created_at FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 129');
          const workspace = await database.get('SELECT id,organization_id,type,project_id,owner_user_id,status FROM canvas_workspaces WHERE id=$1', [workspaceId]);
          const organizationMemberships = await database.all('SELECT organization_id,user_id,role,status FROM organization_user_permissions WHERE user_id=$1 ORDER BY organization_id LIMIT 129', [fixture.actorId]);
          await fs.writeFile(path.join(fixture.root, `native-${platform}-agent-created-lookup-diagnostic.json`), JSON.stringify({
            version: 1, platform, expectedName: newAgentName, expectedActorId: fixture.actorId, actualActorId: currentActor.user.id,
            workspaceId, runtimeUseListing: agents, configureStatus: configured.status(),
            configureListing: await configured.json().catch(() => null), profiles, memberships, organizationSettings, workspace, organizationMemberships,
          }), { mode: 0o600, flag: 'wx' });
        } finally { await database.close(); }
      }
      assert.equal(created.length, 1);
      await execute('agent-edit', { createdAgentId: created[0].agentId });
      const configured = await data<{ agent: { revision: number }; extensions: { workflowRevision: number } }>(await owner.request.get(
        `/api/mobile/v1/agents/configuration?${new URLSearchParams({ agentId: created[0].agentId })}`, { headers }), 'Actual Agent policy target');
      const existing = { kind: 'existing', agentId: created[0].agentId, expectedRevision: configured.agent.revision, expectedWorkflowRevision: configured.extensions.workflowRevision };
      const agentOptions = async (request: Record<string, unknown>) => data<AgentExtensionOptionsResponse>(await owner.request.post('/api/mobile/v1/agents/extension-options', {
        headers, data: { contractVersion: 2, target: existing, ...request } }), 'Actual Agent-scoped package options');
      const agentSearch = await agentOptions({ operation: 'search', q: pluginName, types: ['plugin'] }); assert(agentSearch.operation === 'search');
      const agentPlugin = agentSearch.items.find(row => row.item.kind === 'plugin' && row.item.name === pluginName); assert(agentPlugin);
      const agentConnections = await agentOptions({ operation: 'connection_choices', selector: { kind: 'package', package: pluginPin,
        declarationPath, capabilityId: 'native-connection', alternativeKey: `mcp:${connector}` } }); assert(agentConnections.operation === 'connection_choices');
      const agentMcpRow = agentConnections.connections.find(row => row.selection.kind === 'mcp' && row.selection.target.connectionRef === mcpRef); assert(agentMcpRow);
      assert.equal(agentMcpRow.definitionId, approved.id);
      await execute('agent-package-policy', { createdAgentId: created[0].agentId, agentPluginItemId: agentPlugin.item.id, agentPluginMcpRowId: agentMcpRow.id });
      const workflow = await json<{ data: { workflow: { standalone: Array<{ capabilityKey: string; source: string; toolkit: string }> } } }>(await owner.request.get(`/api/mobile/v1/agents/${created[0].agentId}/workflow?view=options`, { headers }), 'Actual UI-created selectable slot');
      const slot = workflow.data.workflow.standalone.find(row => row.source === 'composio' && row.toolkit === 'canva'); assert(slot);
      const centralAgent = async () => captureNativeCentralAgentSnapshot(await json(await owner.request.get(
        `/api/mobile/v1/agents/configuration?${new URLSearchParams({ agentId: created[0].agentId })}`, { headers }), 'Actual central Agent snapshot'),
      { agentId: created[0].agentId, workspaceId });
      const centralAgentBefore = await centralAgent();
      await execute('my-connection', { createdAgentId: created[0].agentId, capabilityKey: slot.capabilityKey });
      const centralAgentAfter = await centralAgent(); assertNativeCentralAgentUnchanged(centralAgentBefore, centralAgentAfter);
      platforms.push({ platform, sessionId: session.id, agentId, workspaceId, marker, createdAgentId: created[0].agentId,
        selectedAccount: selectedAccount.selection, pluginPin, skillPin, skillCaption, mcpRef, standaloneMcpRef, packageMcpToolCap: agentMcpRow.allowedToolNames, capabilityKey: slot.capabilityKey,
        centralAgentSnapshots: { before: centralAgentBefore, after: centralAgentAfter } });
    }
    await fs.writeFile(path.join(fixture.root, 'chat-extension-native-ui-proof.json'), JSON.stringify({ version: 1, nonce: fixture.nonce, actorId: fixture.actorId,
      platforms, receipts, controlledSdkTransport: true, externalLlm: false, actualNativeCompletion: true }), { mode: 0o600, flag: 'wx' });
  } finally { await owner.close(); }
});
