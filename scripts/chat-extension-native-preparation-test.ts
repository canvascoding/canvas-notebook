import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { nativeExtensionPluginFiles, nativeExtensionStandaloneSkillContent, nativePreparationFailureDiagnostic, nativeExtensionSkillCaption, assertNativeRetypedSkillCaption } from './helpers/chat-extension-native-fixture';
import type { PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedSummary } from '../app/lib/capabilities/packages/contracts';
import type { ChatExtensionOptionsResponse } from '../app/lib/chat/extension-options-contracts';
import type { AgentExtensionOptionsResponse } from '../app/lib/agents/extension-options-contracts';
import { extensionPackagePinSchema, type ExtensionPackagePin, type ExtensionSelection } from '../app/lib/capabilities/extensions/contracts';

/** Actual authenticated preparation routes and SQL. Owned HTTP metadata/OAuth only; no production build, Native UI or model/business execution. */
async function main() {
  const fixture = await createDurableMessageExecutionFixture({ native: process.argv.includes('--native') }), app = fixture.application;
  const identityConnection = await app.database.openDb();
  try {
    const identity = await identityConnection.get('SELECT current_database() AS name,current_user AS owner') as { name: string; owner: string };
    await fs.writeFile(path.join(app.root, 'native-preparation-database.json'), JSON.stringify({ version: 1, ...identity, root: app.root,
      instanceId: process.env.CANVAS_INSTANCE_ID, processId: process.pid, native: app.native }), { flag: 'wx', mode: 0o600 });
  } finally { await identityConnection.close(); }
  const provider = await createComposioProviderFixture();
  const { startMcpOAuthProvider } = await import('../tests/fixtures/mcp-oauth-provider.mjs');
  const mcp = await startMcpOAuthProvider({ allowedRedirectOrigins: ['http://localhost:3001'], passiveLogo: true });
  const beforeFetch = globalThis.fetch, networkFetch = (await import('undici')).fetch;
  const environment = { COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_LOGGING_LEVEL: 'silent',
    CANVAS_PLUGIN_LOCAL_SOURCE_ROOT: path.join(app.root, 'intake'), MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true' };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  let forbidden = 0, stage = 'initialize';
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.origin === provider.baseUrl) {
      const allowed = method === 'GET' && /^\/api\/v3\.1\/(?:toolkits|auth_configs|connected_accounts|tools)(?:\/[A-Za-z0-9_-]+)?$/u.test(url.pathname)
        || method === 'POST' && /^\/api\/v3\.1\/tool_router\/session(?:\/fixture-session-[1-9]\d*\/link)?$/u.test(url.pathname);
      if (!allowed) { forbidden++; throw new Error('Only owned Composio metadata and connection setup are allowed.'); }
      return networkFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof networkFetch>[1]) as unknown as Promise<Response>;
    }
    if (url.origin === mcp.origin) return networkFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof networkFetch>[1]) as unknown as Promise<Response>;
    if (url.href === 'https://registry.npmjs.org/@composio/core/latest') return Response.json({ version: '0.0.0' });
    return beforeFetch(input, init);
  };
  const request = (route: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') => {
    const headers = app.headers('owner'); headers.set('origin', 'http://localhost:3001');
    return new NextRequest(`http://localhost:3001${route}`, { method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  };
  const context = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
  async function json<T>(response: Response, label: string, status = 200): Promise<T> {
    const bytes = Buffer.from(await response.arrayBuffer());
    const diagnostic = nativePreparationFailureDiagnostic({ phase: label, pathname: '/', status: response.status, expectedStatus: status, bytes });
    assert.equal(response.status, status, `${label}: ${diagnostic.code ?? 'no public error code'}`);
    console.log(`Native preparation API contract: ${label} ${status}`);
    return JSON.parse(bytes.toString('utf8')) as T;
  }
  async function data<T>(response: Response, label: string): Promise<T> {
    const result = await json<{ success: boolean; data: T }>(response, label); assert.equal(result.success, true, label); return result.data;
  }
  try {
    const install = await import('../app/api/plugins/install/route'), upload = await import('../app/api/skills/upload/route');
    const search = await import('../app/api/plugins/search/route'), packageRead = await import('../app/api/capabilities/packages/[resourceRef]/route');
    const drafts = await import('../app/api/capabilities/packages/drafts/route'), publishRoute = await import('../app/api/capabilities/packages/drafts/[draftRef]/publish/route');
    const mcpRoute = await import('../app/api/integrations/mcp-config/route'), mcpStatus = await import('../app/api/integrations/mcp-status/route');
    const mcpDefinitions = await import('../app/api/integrations/mcp-definitions/route');
    const mcpCallback = await import('../app/api/mcp/oauth/callback/route'), profiles = await import('../app/api/composio/profiles/route');
    const connect = await import('../app/api/composio/connect/[toolkit]/route'), composioCallback = await import('../app/api/composio/callback/route');
    const agents = await import('../app/api/agents/route'), options = await import('../app/api/mobile/v1/chat/extension-options/route');
    const agentOptions = await import('../app/api/mobile/v1/agents/extension-options/route'), configuration = await import('../app/api/mobile/v1/agents/configuration/route');
    const sessions = await import('../app/api/mobile/v1/sessions/route');
    const suffix = '0123456789', name = `native-plugin-${suffix}`, skillName = `native-skill-${suffix}`, childName = `native-child-${suffix}`;
    const childRoot = `skills/${childName}`, declarationPath = `${childRoot}/agents/canvas.yaml`, connector = `native-mcp-${suffix}`;
    const mcpConfiguration = { url: mcp.url, transport: 'http', auth: 'oauth' }, source = path.join(environment.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT, name);
    stage = 'normal Plugin/Skill import';
    for (const [relative, content] of Object.entries(nativeExtensionPluginFiles({ name, childRoot, connector, mcpConfiguration }))) {
      const target = path.join(source, relative); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, content, { mode: 0o600, flag: 'wx' });
    }
    await json(await install.POST(request('/api/plugins/install', { sourcePath: source, scope: 'user', enable: true })), stage);
    await json(await upload.POST(request('/api/skills/upload', { content: nativeExtensionStandaloneSkillContent(skillName) })), stage);
    async function publication(selectedName: string, kind: 'skill' | 'plugin', expectedPublishStatus = 200): Promise<ExtensionPackagePin | null> {
      const listing = await data<PluginExtensionSearchResponse>(await search.GET(request(`/api/plugins/search?q=${selectedName}&types=${kind}&workspaceId=personal-owner`)), `Search ${kind}`);
      const item = listing.items.find(row => row.kind === kind && row.name === selectedName && (row.kind === 'plugin' || row.kind === 'skill') && row.package);
      assert(item && (item.kind === 'plugin' || item.kind === 'skill') && item.package);
      const read = async (resourceRef: string) => (await data<{ package: CapabilityPackageDescriptor }>(await packageRead.GET(request(`/api/capabilities/packages/${encodeURIComponent(resourceRef)}?workspaceId=personal-owner`), context({ resourceRef })), `Read ${kind}`)).package;
      const current = await read(item.package.resourceRef);
      const draft = (await data<{ draft: CapabilityPackageDraft }>(await drafts.POST(request('/api/capabilities/packages/drafts?workspaceId=personal-owner', { operation: 'edit', resourceRef: current.resource.resourceRef,
        expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision, expectedPackageRevision: current.state?.packageRevision ?? 0,
        expectedPublishedRevisionRef: current.state?.currentPublishedRevisionRef ?? null }), context()), `Draft ${kind}`)).draft;
      const fresh = await read(draft.resourceRef);
      const response = await publishRoute.POST(request(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish?workspaceId=personal-owner`, {
        draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: fresh.resource.metadataRevision, expectedGrantsRevision: fresh.resource.grantsRevision,
        expectedPackageRevision: fresh.state?.packageRevision ?? 0, expectedPublishedRevisionRef: fresh.state?.currentPublishedRevisionRef ?? null }), context({ draftRef: draft.draftRef }));
      if (expectedPublishStatus !== 200) { const rejected = await json<{ code: string }>(response, `Missing-version ${kind} publication`, expectedPublishStatus); assert.equal(rejected.code, 'PACKAGE_INVALID'); return null; }
      const published = (await data<{ published: CapabilityPackagePublishedSummary }>(response, `Publish ${kind}`)).published;
      assert.equal(published.version, '1.0.0'); return extensionPackagePinSchema.parse({ resourceRef: draft.resourceRef, publishedRevisionRef: published.revisionRef, checksum: published.checksum });
    }
    stage = 'real immutable Plugin and standalone Skill publication';
    const pluginPin = await publication(name, 'plugin'), skillPin = await publication(skillName, 'skill'); assert(pluginPin && skillPin);
    await json(await upload.POST(request('/api/skills/upload', { content: nativeExtensionStandaloneSkillContent('native-old-missing-version').replace('metadata:\n  version: "1.0.0"\n', '') })), 'Legacy unversioned import');
    await publication('native-old-missing-version', 'skill', 400);

    stage = 'normal two exact MCP configurations and real OAuth';
    const currentMcp = await data<{ rawContent: string }>(await mcpRoute.GET(request('/api/integrations/mcp-config')), stage);
    const definitionScope = await data<{ organizationId: string | null }>(await mcpDefinitions.GET(request('/api/integrations/mcp-definitions')), stage);
    assert.equal(definitionScope.organizationId, app.organizationId);
    const original = JSON.parse(currentMcp.rawContent), names = [connector, 'Native solo MCP exact'];
    const saved = await data<{ rawContent: string }>(await mcpRoute.PUT(request('/api/integrations/mcp-config', { rawContent: JSON.stringify({ ...original, mcpServers: { ...original.mcpServers,
      [names[0]]: { ...mcpConfiguration, organizationId: definitionScope.organizationId }, [names[1]]: mcpConfiguration } }) }, 'PUT')), stage);
    const stored = JSON.parse(saved.rawContent), refs = names.map(selected => `mcp-personal:${stored.mcpServers[selected].connectionId}`); assert.notEqual(refs[0], refs[1]);
    const approvedDefinition = await data<{ id: string }>(await mcpDefinitions.POST(request('/api/integrations/mcp-definitions', { action: 'publish', server: names[0], name: 'Native approved MCP 0123456789' })), stage);
    stored.mcpServers[names[0]].serverDefinitionId = approvedDefinition.id;
    const assigned = await data<{ rawContent: string }>(await mcpRoute.PUT(request('/api/integrations/mcp-config', { rawContent: JSON.stringify(stored) }, 'PUT')), stage);
    assert.deepEqual(names.map(selected => `mcp-personal:${JSON.parse(assigned.rawContent).mcpServers[selected].connectionId}`), refs);
    for (const selected of names) {
      const started = await data<{ authorizationUrl: string }>(await mcpStatus.POST(request('/api/integrations/mcp-status', { action: 'authorize', server: selected })), stage);
      assert.equal(new URL(started.authorizationUrl).origin, mcp.origin);
      const consent = await networkFetch(started.authorizationUrl, { redirect: 'manual' }); assert.equal(consent.status, 200);
      const token = /name="consent" value="([A-Za-z0-9_-]+)"/u.exec(await consent.text())?.[1]; assert(token);
      const approved = await networkFetch(`${mcp.origin}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ consent: token, decision: 'approve' }).toString(), redirect: 'manual' }); assert.equal(approved.status, 303);
      const callback = new URL(approved.headers.get('location')!); assert.equal(callback.origin, 'http://localhost:3001');
      assert.equal((await mcpCallback.GET(request(callback.pathname + callback.search))).status, 200);
    }
    assert.equal(mcp.stats.approvals, 2); assert.equal(mcp.stats.toolCalls, 0);

    stage = 'normal own Composio profile and connection routes';
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'owned-native-preparation-test-key' }], { secretScope: 'user', userId: 'owner' });
    await json(await profiles.GET(request('/api/composio/profiles')), stage);
    const profileId = (await json<{ profile: { id: string } }>(await profiles.POST(request('/api/composio/profiles', { name: 'Native exact profile 0123456789' })), stage, 201)).profile.id;
    for (let index = 0; index < 2; index++) {
      const started = await json<{ redirectUrl: string }>(await connect.POST(request('/api/composio/connect/canva', { profileId, returnPath: '/en/settings?workspaceId=personal-owner' }), { params: Promise.resolve({ toolkit: 'canva' }) }), stage);
      const id = new URL(started.redirectUrl).pathname.split('/').at(-1)!;
      const callback = new URL(provider.completeOAuth(id)!); assert.equal(callback.origin, 'http://localhost:3001');
      assert.equal((await composioCallback.GET(request(callback.pathname + callback.search))).status, 307);
    }

    stage = 'exact legacy Agent writer, versioned options and real session creation';
    const agent = await data<{ agent: { agentId: string } }>(await agents.POST(request('/api/agents?workspaceId=personal-owner', { name: 'Native specialist 0123456789', scopeType: 'user',
      relevantSkills: [childName, skillName], relevantConnections: null, enabledTools: ['read', 'mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'],
      defaultProviderInstallationId: fixture.model.providerInstallationId, defaultProvider: fixture.model.providerId, defaultModel: fixture.model.modelId,
      defaultThinking: fixture.model.thinkingLevel, expectedCatalogRevision: fixture.model.expectedCatalogRevision })), stage);
    const target = { kind: 'draft_turn', workspaceId: 'personal-owner', agentId: agent.agent.agentId };
    const chatOptions = async (value: Record<string, unknown>) => data<ChatExtensionOptionsResponse>(await options.POST(request('/api/mobile/v1/chat/extension-options', { contractVersion: 2, target, ...value })), stage);
    for (const [q, kind] of [[name, 'plugin'], [skillName, 'skill'], [names[1], 'mcp'], ['canva', 'integration']]) {
      const found = await chatOptions({ operation: 'search', q, types: [kind] }); assert(found.operation === 'search');
      assert.equal(found.items.filter(row => row.item.kind === kind && (kind === 'integration' || row.item.name === q)).length, 1, `${kind} exact search`);
    }
    const selectedSkill = await chatOptions({ operation: 'search', q: skillName, types: ['skill'] }); assert(selectedSkill.operation === 'search');
    const exactSkill = selectedSkill.items.find(row => row.item.kind === 'skill' && row.item.name === skillName); assert(exactSkill?.selection?.kind === 'skill');
    const skillVersion = await chatOptions({ operation: 'package_version', ...skillPin }); assert(skillVersion.operation === 'package_version');
    const skillCaption = nativeExtensionSkillCaption(skillVersion.package, exactSkill.selection);
    assert.equal(skillCaption, `Native Skill ${suffix}`); assert.notEqual(skillCaption, skillName);
    assertNativeRetypedSkillCaption(`PLAIN-marker ${skillCaption}`, 'marker', skillCaption);
    assert.throws(() => assertNativeRetypedSkillCaption(`PLAIN-marker ${skillName}`, 'marker', skillCaption));
    const selector = { kind: 'package', package: pluginPin, declarationPath, capabilityId: 'native-connection', alternativeKey: `mcp:${connector}` };
    const packageChoices = await chatOptions({ operation: 'connection_choices', selector }); assert(packageChoices.operation === 'connection_choices');
    assert(packageChoices.connections.some(row => row.selection.kind === 'mcp' && row.selection.target.connectionRef === refs[0]));
    const standaloneChoices = await chatOptions({ operation: 'connection_choices', selector: { kind: 'standalone', source: 'mcp' } }); assert(standaloneChoices.operation === 'connection_choices');
    assert(standaloneChoices.connections.some(row => row.selection.kind === 'mcp' && row.selection.target.connectionRef === refs[1]));
    const accounts = await chatOptions({ operation: 'connection_choices', selector: { kind: 'standalone', source: 'composio', toolkit: 'canva' }, profileId });
    assert(accounts.operation === 'connection_choices'); assert.equal(accounts.accounts.length, 2);
    const configured = await data<{ agent: { revision: number }; extensions: { workflowRevision: number } }>(await configuration.GET(request(`/api/mobile/v1/agents/configuration?agentId=${agent.agent.agentId}`)), stage);
    const existing = { kind: 'existing', agentId: agent.agent.agentId, expectedRevision: configured.agent.revision, expectedWorkflowRevision: configured.extensions.workflowRevision };
    const agentConnections = await data<AgentExtensionOptionsResponse>(await agentOptions.POST(request('/api/mobile/v1/agents/extension-options', { contractVersion: 2, target: existing, operation: 'connection_choices', selector })), stage);
    assert(agentConnections.operation === 'connection_choices'); const agentMcp = agentConnections.connections.find(row => row.selection.kind === 'mcp' && row.selection.target.connectionRef === refs[0]);
    assert(agentMcp); assert.equal(agentMcp.definitionId, approvedDefinition.id);
    const session = await json<{ success: boolean; session: { id: string; agentId: string } }>(await sessions.POST(request('/api/mobile/v1/sessions', { agentId: agent.agent.agentId, title: 'Native actual preparation' })), stage, 201);
    assert(session.success && session.session.id); assert.equal(session.session.agentId, agent.agent.agentId);
    const sessionDatabase = await app.database.openDb();
    try {
      const storedSession = await sessionDatabase.get('SELECT session_id,agent_id,user_id,workspace_id FROM pi_sessions WHERE session_id=$1 AND user_id=$2', [session.session.id, 'owner']) as Record<string, unknown>;
      assert.deepEqual(storedSession, { session_id: session.session.id, agent_id: agent.agent.agentId, user_id: 'owner', workspace_id: 'personal-owner' });
    } finally { await sessionDatabase.close(); }
    stage = 'real Session-scoped presentation and exact published/connection icon metadata';
    const sessionTarget = { kind: 'turn' as const, sessionId: session.session.id, expectedAgentId: agent.agent.agentId, expectedWorkspaceId: 'personal-owner' };
    const sessionOptions = async (value: Record<string, unknown>) => data<ChatExtensionOptionsResponse>(await options.POST(request('/api/mobile/v1/chat/extension-options', {
      contractVersion: 2, target: sessionTarget, ...value })), stage);
    const pluginVersion = await sessionOptions({ operation: 'package_version', ...pluginPin }); assert(pluginVersion.operation === 'package_version');
    const sessionSkillVersion = await sessionOptions({ operation: 'package_version', ...skillPin }); assert(sessionSkillVersion.operation === 'package_version');
    const sessionMcpChoices = await sessionOptions({ operation: 'connection_choices', selector: { kind: 'standalone', source: 'mcp' } });
    assert(sessionMcpChoices.operation === 'connection_choices');
    const mcpRows = refs.map(ref => { const row = sessionMcpChoices.connections.find(value => value.selection.kind === 'mcp' && value.selection.target.connectionRef === ref); assert(row?.icon); return row; });
    assert(pluginVersion.package.icon);
    const skillSelection = exactSkill.selection; assert(skillSelection.kind === 'skill');
    const selections: ExtensionSelection[] = [{ kind: 'plugin', package: pluginPin, skillSelection: { kind: 'all' } }, skillSelection,
      ...mcpRows.map(row => row.selection), accounts.accounts[1].selection];
    const expectedIcons = [pluginVersion.package.icon, sessionSkillVersion.package.children.find(child => child.relativeRoot === skillSelection.relativeRoot)?.icon,
      ...mcpRows.map(row => row.icon), undefined];
    const accountReadsBefore = provider.calls.filter(call => call.path === '/api/v3.1/connected_accounts').length;
    const presentationRequest = { contractVersion: 2, target: sessionTarget, operation: 'presentation', selections };
    const presentationResponse = await json<{ success: boolean; contractVersion: number; workspaceId: string; data: ChatExtensionOptionsResponse }>(
      await options.POST(request('/api/mobile/v1/chat/extension-options', presentationRequest)), stage);
    const accountReadsAfter = provider.calls.filter(call => call.path === '/api/v3.1/connected_accounts').length;
    const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-presentation-probe-')); await fs.chmod(probeRoot, 0o700);
    const probePath = path.join(probeRoot, 'scoped-presentation.json');
    await fs.writeFile(probePath, JSON.stringify({ version: 1, engine: app.native ? 'guarded PostgreSQL' : 'PGlite', workspaceId: 'personal-owner',
      request: presentationRequest, response: presentationResponse,
      expected: selections.map((selection, index) => ({ selection, icon: expectedIcons[index] ?? null })),
      observed: { accountReadsBefore, accountReadsAfter, modelRequests: app.providerRequests(), mcpToolCalls: mcp.stats.toolCalls } }), { mode: 0o600, flag: 'wx' });
    console.log(`Native presentation private response: ${probePath}`);
    assert(presentationResponse.success && presentationResponse.contractVersion === 2 && presentationResponse.workspaceId === 'personal-owner');
    assert(presentationResponse.data.operation === 'presentation'); const entries = presentationResponse.data.entries;
    assert.deepEqual(entries.map(entry => entry.selection), selections); assert.equal(entries.length, 5);
    for (const [index, expected] of expectedIcons.entries()) {
      if (expected) {
        assert(entries[index].publicIcon, `Presentation must retain the available ${selections[index].kind} icon.`);
        assert.equal(entries[index].publicIcon.url, expected.url, 'Presentation must preserve the exact normal-metadata image URL.');
        assert.match(entries[index].publicIcon.sourceKey, /^chat-icon:[A-Za-z0-9_-]+$/u);
      } else assert.equal(entries[index].publicIcon, undefined, 'An exact source without an icon must retain the initials fallback.');
    }
    assert.equal(accountReadsAfter, accountReadsBefore, 'Presentation must not enumerate accounts.');
    stage = 'actual scoped icon bytes, source identity and access rejection';
    const images = await import('../app/api/mobile/v1/extensions/icon/route');
    const expectedMcpImage = await networkFetch(`${mcp.origin}/logo.svg`, { redirect: 'error' });
    assert.equal(expectedMcpImage.status, 200); assert.equal(expectedMcpImage.headers.get('content-type'), 'image/svg+xml');
    const expectedMcpBytes = Buffer.from(await expectedMcpImage.arrayBuffer());
    const expectedPluginBytes = await fs.readFile(path.join(source, 'logo.svg'));
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const byteReads: Array<{ kind: string; url: string; status: number; contentType: string | null; byteLength: number; sha256: string;
      expectedSha256: string; location: string | null; cacheControl: string | null; vary: string | null; nosniff: string | null; bodyPath: string }> = [];
    const deniedReads: Array<{ actor: string; status: number; code: string | null }> = [];
    const imageRequest = (url: string, actor = 'owner') => {
      assert(url.startsWith('/api/mobile/v1/extensions/icon?'));
      const headers = app.headers(actor); headers.set('origin', 'http://localhost:3001');
      return new NextRequest(`http://localhost:3001${url}`, { headers });
    };
    for (const entry of entries.filter(value => value.publicIcon !== undefined)) {
      const url = entry.publicIcon!.url, image = await images.GET(imageRequest(url)), imageBytes = Buffer.from(await image.arrayBuffer());
      const expectedBytes = entry.selection.kind === 'plugin' ? expectedPluginBytes : expectedMcpBytes;
      const bodyPath = path.join(probeRoot, `scoped-image-${byteReads.length}.svg`);
      const observed = { kind: entry.selection.kind, url, status: image.status, contentType: image.headers.get('content-type'), byteLength: imageBytes.length,
        sha256: digest(imageBytes), expectedSha256: digest(expectedBytes), location: image.headers.get('location'), cacheControl: image.headers.get('cache-control'),
        vary: image.headers.get('vary'), nosniff: image.headers.get('x-content-type-options'), bodyPath };
      byteReads.push(observed);
      await fs.writeFile(path.join(probeRoot, `scoped-image-${byteReads.length - 1}.json`), JSON.stringify(observed), { mode: 0o600, flag: 'wx' });
      assert.equal(image.status, 200, 'A present exact source image must return actual bytes, rather than an empty 204.');
      assert.equal(observed.contentType, 'image/svg+xml'); assert(imageBytes.length > 0 && imageBytes.length <= 256 * 1024);
      assert.deepEqual(imageBytes, expectedBytes); assert.equal(observed.location, null);
      assert.match(observed.cacheControl ?? '', /\bprivate\b/u); assert.match(observed.cacheControl ?? '', /\bno-store\b/u);
      for (const name of ['authorization', 'cookie', 'x-canvas-workspace-id']) assert((observed.vary ?? '').toLowerCase().split(',').map(value => value.trim()).includes(name));
      assert.equal(observed.nosniff, 'nosniff');
      await fs.writeFile(bodyPath, imageBytes, { mode: 0o600, flag: 'wx' });
      const denied = await images.GET(imageRequest(url, 'bob'));
      const diagnostic = nativePreparationFailureDiagnostic({ phase: stage, pathname: '/api/mobile/v1/extensions/icon', status: denied.status, expectedStatus: 403,
        bytes: Buffer.from(await denied.arrayBuffer()) });
      deniedReads.push({ actor: 'other-user', status: denied.status, code: diagnostic.code });
      assert([403, 404].includes(denied.status), 'Another actor must not receive the original private icon bytes.');
    }
    assert.equal(byteReads.length, 3); assert.deepEqual(byteReads.map(value => value.kind), ['plugin', 'mcp', 'mcp']);
    const originalMcpIcon = byteReads.find(value => value.kind === 'mcp')!;
    const wrongBinding = new URL(originalMcpIcon.url, 'http://localhost:3001'), binding = wrongBinding.searchParams.get('binding')!;
    assert.match(binding, /^[a-f0-9]{64}$/u);
    wrongBinding.searchParams.set('binding', (binding[0] === 'a' ? 'b' : 'a') + binding.slice(1));
    const beforeRejectedIconReads = mcp.stats.iconReads;
    const stale = await images.GET(imageRequest(wrongBinding.pathname + wrongBinding.search));
    const staleDiagnostic = nativePreparationFailureDiagnostic({ phase: stage, pathname: '/api/mobile/v1/extensions/icon', status: stale.status, expectedStatus: 409,
      bytes: Buffer.from(await stale.arrayBuffer()) });
    deniedReads.push({ actor: 'owner-wrong-binding', status: stale.status, code: staleDiagnostic.code });
    assert.equal(stale.status, 409); assert.equal(staleDiagnostic.code, 'MCP_ICON_SOURCE_CHANGED'); assert.equal(mcp.stats.iconReads, beforeRejectedIconReads);
    assert.equal(provider.calls.filter(call => call.path === '/api/v3.1/connected_accounts').length, accountReadsBefore);
    const byteProbePath = path.join(probeRoot, 'scoped-icon-bytes.json');
    await fs.writeFile(byteProbePath, JSON.stringify({ version: 1, engine: app.native ? 'guarded PostgreSQL' : 'PGlite', workspaceId: 'personal-owner',
      presentationPath: probePath, reads: byteReads, rejected: deniedReads,
      observed: { iconReads: mcp.stats.iconReads, iconDiscoveryReads: mcp.stats.iconDiscoveryReads, accountEnumerationDelta: 0, modelRequests: app.providerRequests(), mcpToolCalls: mcp.stats.toolCalls } }), { mode: 0o600, flag: 'wx' });
    console.log(`Native icon bytes private proof: ${byteProbePath}`);
    assert.equal(forbidden, 0); assert.equal(app.providerRequests(), 0); assert.equal(mcp.stats.toolCalls, 0);
    assert(!provider.calls.some(call => /\/tools\/execute|\/execute$/u.test(call.path)));
    console.log(`PASS ${app.native ? 'guarded PostgreSQL' : 'PGlite'} real Native preparation: normal Plugin/Skill imports + both immutable publishes, missing-version400, actual package-version caption distinct from slug, two MCP OAuth callbacks, own Composio profile/two callbacks, exact Agent/model selection, four searches, scoped package/standalone/account choices, Agent target/revisions, Session201, exact Session-scoped presentation and all three authorized SVG byte reads with headers/source hashes/other-actor and binding denial; account enumeration during presentation/images0, model/business execution0.`);
  } catch (error) { console.error(`Native preparation stage: ${stage}`); throw error; }
  finally {
    globalThis.fetch = beforeFetch; await mcp.close(); await provider.close();
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fixture.close();
  }
}
// Keep the full asynchronous assertion/cleanup chain alive if only unreferenced resources remain.
const pendingTest = setInterval(() => undefined, 1_000);
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(pendingTest));
