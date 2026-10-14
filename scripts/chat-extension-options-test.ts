import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { ChatExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import type { SqlConnection } from '../app/lib/db';

/** Actual SQL, Actor/Workspace/Agent/Source ACLs, Store bytes, Admission and API.
 * Only owned metadata HTTP (Ollama catalogue/Composio SDK transport) is controlled.
 * No runtime/authority/registry/source policy is replaced; no model/business call. */
async function main() {
  const browser = await build({ stdin: { contents: `import {chatExtensionOptionsRequestSchema as s} from './app/lib/chat/extension-options-contracts';
    globalThis.checked = s.safeParse({operation:'search',target:{kind:'draft_turn',agentId:'a',workspaceId:'w'}}).success
      && !s.safeParse({operation:'search',target:{kind:'prospective',scopeType:'user'}}).success;`, resolveDir: process.cwd(), loader: 'ts' },
    platform: 'browser', bundle: true, format: 'iife', write: false });
  const sandbox = vm.createContext({ TextEncoder }); vm.runInContext(browser.outputFiles[0]!.text, sandbox); assert.equal(sandbox.checked, true);
  const fixture = await createDurableMessageExecutionFixture({ native: process.argv.includes('--native') }), app = fixture.application;
  const provider = await createComposioProviderFixture();
  const beforeFetch = globalThis.fetch, networkFetch = (await import('undici')).fetch;
  const env = { COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_LOGGING_LEVEL: 'silent' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  let forbidden = 0, stage = 'setup';
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== provider.baseUrl) {
      if (url.href === 'https://registry.npmjs.org/@composio/core/latest') return Response.json({ version: '0.0.0' });
      return beforeFetch(input, init);
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' || !/^\/api\/v3\.1\/(?:toolkits|connected_accounts)(?:\/[a-z0-9_-]+)?$/u.test(url.pathname)) { forbidden++; throw new Error('Only explicit owned metadata reads.'); }
    return networkFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof networkFetch>[1]) as unknown as Promise<Response>;
  };
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>) => {
    const database = await app.database.openDb(); try { return await operation(database); } finally { await database.close(); }
  };
  try {
    const { listChatExtensionOptions } = await import('../app/lib/chat/extension-options');
    const contexts = await import('../app/lib/chat/extension-options-context');
    const management = await import('../app/lib/agents/management-actions');
    const { listManagedAgentExtensionOptions } = await import('../app/lib/agents/extension-options');
    const { createSharedMcpConnection } = await import('../app/lib/mcp/shared-connections');
    const { POST } = await import('../app/api/chat/extension-options/route');
    const { NextRequest } = await import('next/server');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const owner = { ...app.owner, source: 'api' as const }, alice = { ...app.alice, source: 'api' as const };
    const name = `chat-options-${randomUUID().slice(0, 8)}`;
    const general = await management.createManagedAgent(owner, { name: `General ${name}`, scopeType: 'user', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } });
    const target = { kind: 'draft_turn' as const, agentId: general.agent.agentId, workspaceId: app.owner.workspaceId! };
    const count = async (table: string) => sql(async database => (await database.all(`SELECT id FROM ${table}`)).length);
    const before = { agents: await count('agents'), sessions: await count('pi_sessions'), receipts: await sql(async database => (await database.all('SELECT client_message_id FROM pi_message_delivery_receipts')).length) };
    const context = await contexts.resolveChatExtensionOptionsContext(owner, target);
    assert(Object.isFrozen(context) && Object.isFrozen(context.snapshot));
    await assert.rejects(contexts.revalidateChatExtensionOptionsContext({ ...context }), { code: 'CHAT_EXTENSION_CONTEXT_DENIED' });
    await assert.rejects(listChatExtensionOptions(owner, { operation: 'recents', target: { ...target, workspaceId: 'personal-alice' } }), { code: 'CHAT_EXTENSION_CONTEXT_DENIED' });
    const empty = await listChatExtensionOptions(owner, { operation: 'search', target, q: '', types: ['mcp'] });
    assert.equal(empty.operation, 'search'); assert.equal(empty.finalSendValidationRequired, true);
    assert.equal(await count('agents'), before.agents); assert.equal(await count('pi_sessions'), before.sessions);
    assert.equal(await sql(async database => (await database.all('SELECT client_message_id FROM pi_message_delivery_receipts')).length), before.receipts);

    stage = 'published parent, exact child, immutable logo and siteless API';
    const archive = await app.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', skills: './skills', description: 'Real Chat source',
        interface: { displayName: 'Chat exact source', logo: 'https://example.test/icon.svg?drop=1' },
        connectors: { mcp: [{ name: 'reader', required: false, configPath: 'reader.json' }] },
        workflow: { version: 1, integrationCapabilities: [{ id: 'read', application: 'design', required: false,
          alternatives: [{ source: 'mcp', connector: 'reader' }] }] } }),
      'reader.json': JSON.stringify({ mcpServers: { reader: { url: 'https://example.test/chat-reader', auth: 'none', transport: 'http' } } }),
      'skills/one/SKILL.md': '---\nname: one\ndescription: Exact child metadata\n---\nActual first source.\n',
      'skills/two/SKILL.md': '---\nname: two\ndescription: Another exact child\n---\nActual second source.\n',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await stores.installCapabilityPackageFromStoreAction(app.owner, { source: { kind: 'plugin', registryId: 'store-application', entryKey: name,
      version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' }, grants: [app.owner, app.alice].map(actor => ({ targetType: 'user',
        targetId: actor.userId, canUse: true, canEdit: false, canManage: false })) });
    const packageInspect = await packages.inspectCapabilityPackage(app.owner, installed.resource.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(app.owner, installed.resource.resourceRef, { expectedMetadataRevision: packageInspect.resource.metadataRevision,
      expectedGrantsRevision: packageInspect.resource.grantsRevision, expectedPackageRevision: packageInspect.state!.packageRevision,
      expectedPublishedRevisionRef: installed.published.revisionRef, expectedDefaultEnabled: false, enabled: true });
    const { setPersonalCapabilityActivation } = await import('../app/lib/capabilities/activation-actions');
    for (const actor of [app.owner, app.alice]) await setPersonalCapabilityActivation({ context: { userId: actor.userId, organizationId: app.organizationId,
      workspaceId: actor.workspaceId, role: actor.userId === 'owner' ? 'owner' : 'member' }, actorUserId: actor.userId, resourceId: packageInspect.sourceStamp.resourceId, enabled: true });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const detail = await listChatExtensionOptions(owner, { operation: 'package_version', target, ...pin });
    assert(detail.operation === 'package_version'); assert.deepEqual(detail.package.pin, pin); assert.equal(detail.package.children.length, 2);
    assert.equal(detail.package.icon?.url, 'https://example.test/icon.svg');
    const found = await listChatExtensionOptions(owner, { operation: 'search', target, q: name, types: ['plugin'] });
    assert(found.operation === 'search'); assert.equal(found.items.find(row => (row.item.kind === 'plugin' || row.item.kind === 'skill') && row.item.package?.resourceRef === pin.resourceRef)?.selection?.kind, 'plugin');
    const icon = await listChatExtensionOptions(owner, { operation: 'presentation', target, selections: [{ kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }] });
    assert(icon.operation === 'presentation'); assert.equal(icon.entries[0]?.publicIcon?.url, 'https://example.test/icon.svg');
    assert.match(icon.entries[0]?.publicIcon?.sourceKey ?? '', /^chat-icon:/u);
    const request = (user: string | null, body: unknown) => new NextRequest(`http://localhost:3001/api/chat/extension-options?workspaceId=${target.workspaceId}`,
      { method: 'POST', headers: user ? app.headers(user) : { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const route = await POST(request('owner', { operation: 'package_version', target, ...pin })); assert.equal(route.status, 200);
    assert.match(route.headers.get('cache-control') ?? '', /no-store/u); assert.deepEqual((await route.json()).data.package.pin, pin);
    assert.equal((await POST(request(null, { operation: 'recents', target }))).status, 401);
    assert.equal((await POST(request('bob', { operation: 'recents', target }))).status, 403);

    stage = 'Use-only shared agent and template match without Manage';
    const sharedAgent = await management.createManagedAgent(owner, { name: `Use only ${name}`, scopeType: 'organization', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    const targetOnly = await createSharedMcpConnection({ ...app.owner, organizationId: app.organizationId }, { ownership: { type: 'organization', organizationId: app.organizationId },
      displayName: 'Exact target-only reader', accessMode: 'restricted', allowedToolNames: ['read_fixture'],
      config: { url: 'https://example.test/chat-reader', transport: 'http', auth: 'none', enabled: true },
      grants: [{ targetType: 'agent', targetId: sharedAgent.agent.agentId, canUse: true, canManage: false, allowedToolNames: ['read_fixture'] }] });
    const aliceTarget = { kind: 'draft_turn' as const, agentId: sharedAgent.agent.agentId, workspaceId: app.alice.workspaceId! };
    const selector = { kind: 'package' as const, package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'read', alternativeKey: 'mcp:reader' };
    const chooser = await listChatExtensionOptions(alice, { operation: 'connection_choices', target: aliceTarget, selector });
    assert(chooser.operation === 'connection_choices');
    const chosen = chooser.connections.find(choice => choice.selection.target.kind === 'shared' && choice.selection.target.connectionRef === targetOnly.resource.connectionRef);
    assert(chosen); assert.equal(chosen.mappingRequired, false); assert.equal(chosen.eligibility.action, 'select');
    await assert.rejects(listManagedAgentExtensionOptions(alice, { operation: 'connection_choices', target: { kind: 'existing', agentId: sharedAgent.agent.agentId,
      expectedRevision: sharedAgent.agent.revision, expectedWorkflowRevision: sharedAgent.agent.workflowRevision }, selector }), { code: 'AGENT_ACCESS_DENIED' });
    const fixed = await management.createManagedAgent(owner, { name: `Empty fixed ${name}`, scopeType: 'organization', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] },
      grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
    await assert.rejects(listChatExtensionOptions(alice, { operation: 'connection_choices', target: { ...aliceTarget, agentId: fixed.agent.agentId },
      selector: { kind: 'standalone', source: 'mcp' } }), { code: 'CHAT_EXTENSION_AGENT_SCOPE' });

    stage = 'explicit profile then exact accounts; metadata and presentation never enumerate accounts';
    await (await import('../app/lib/integrations/env-config')).replaceScopedEnvEntries('integrations',
      [{ key: 'COMPOSIO_API_KEY', value: 'isolated-chat-options-key' }], { secretScope: 'user', userId: 'owner' });
    const composio = await (await import('../app/lib/composio/composio-context')).resolveComposioContext({ userId: 'owner', workspaceId: app.owner.workspaceId });
    provider.accounts.set(composio.composioUserId, [{ id: 'exact-a', toolkit: 'canva', status: 'ACTIVE' }, { id: 'exact-b', toolkit: 'canva', status: 'ACTIVE' }]);
    const accountReads = () => provider.calls.filter(call => call.path.startsWith('/api/v3.1/connected_accounts')).length;
    const beforeAccounts = accountReads();
    const profiles = await listChatExtensionOptions(owner, { operation: 'connection_choices', target, selector: { kind: 'standalone', source: 'composio', toolkit: 'canva' } });
    assert(profiles.operation === 'connection_choices'); assert.equal(profiles.accounts.length, 0); assert.equal(accountReads(), beforeAccounts);
    assert.equal(profiles.profiles[0]?.profileId, composio.profileId);
    const accounts = await listChatExtensionOptions(owner, { operation: 'connection_choices', target, selector: { kind: 'standalone', source: 'composio', toolkit: 'canva' }, profileId: composio.profileId });
    assert(accounts.operation === 'connection_choices'); assert.equal(accounts.accounts.length, 2);
    const b = accounts.accounts.find(account => account.selection.target.accountId === 'exact-b'); assert(b);
    const beforePresentationAccounts = accountReads();
    await listChatExtensionOptions(owner, { operation: 'presentation', target, selections: [b.selection] });
    assert.equal(accountReads(), beforePresentationAccounts);
    const accountBody: ChatBodyV1 = { version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'account-node', bundleId: 'account-b' }],
      bundles: [{ id: 'account-b', caption: 'Canva B', primary: { selection: b.selection, requirement: 'optional', toolCap: ['DESIGN_CREATE'] }, supporting: [], packageConnections: [] }] };
    const accountPreview = await listChatExtensionOptions(owner, { operation: 'preview', target, body: accountBody,
      intakeSelection: { version: 1, origin: 'turn_reference', selections: [{ ...accountBody.bundles[0]!.primary, accountSelectionRef: b.accountSelectionRef }] } });
    assert(accountPreview.operation === 'preview'); assert.equal(accountPreview.preview.contextValidation, 'unknown'); assert.equal(accountPreview.preview.budget, null);
    assert.equal(accountPreview.preview.issues.length, 0); assert.equal(accountReads(), beforePresentationAccounts);
    await assert.rejects(listChatExtensionOptions(owner, { operation: 'preview', target, body: accountBody,
      intakeSelection: { version: 1, origin: 'turn_reference', selections: [accountBody.bundles[0]!.primary] } }), { code: 'CHAT_EXTENSION_OPTIONS_INVALID' });

    stage = 'fixed personal account refresh remains exact, without opening other stored profiles or accounts';
    const fixedAccount = await management.createManagedAgent(owner, { name: `Fixed account ${name}`, scopeType: 'user', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [{ mode: 'fixed',
        entry: { selection: b.selection, requirement: 'optional', toolCap: ['DESIGN_CREATE'], accountSelectionRef: b.accountSelectionRef } }] } });
    const accountTarget = { ...target, agentId: fixedAccount.agent.agentId };
    const fixedProfiles = await listChatExtensionOptions(owner, { operation: 'connection_choices', target: accountTarget,
      selector: { kind: 'standalone', source: 'composio', toolkit: 'canva' } });
    assert(fixedProfiles.operation === 'connection_choices'); assert.deepEqual(fixedProfiles.profiles.map(value => value.profileId), [composio.profileId]);
    const fixedAccounts = await listChatExtensionOptions(owner, { operation: 'connection_choices', target: accountTarget,
      selector: { kind: 'standalone', source: 'composio', toolkit: 'canva' }, profileId: composio.profileId });
    assert(fixedAccounts.operation === 'connection_choices'); assert.deepEqual(fixedAccounts.accounts.map(value => value.selection.target.accountId), ['exact-b']);
    const selectedB = fixedAccounts.accounts[0]!;
    const fixedPreview = await listChatExtensionOptions(owner, { operation: 'preview', target: accountTarget, body: accountBody,
      intakeSelection: { version: 1, origin: 'turn_reference', selections: [{ ...accountBody.bundles[0]!.primary, accountSelectionRef: selectedB.accountSelectionRef }] } });
    assert(fixedPreview.operation === 'preview'); assert.equal(fixedPreview.preview.issues.length, 0);
    assert.deepEqual(fixedPreview.preview.effectiveToolCaps[0]?.toolCap, ['DESIGN_CREATE']);

    stage = 'one metadata search covers all four types without accounts; fixed masks cannot expand';
    const definition = await (await import('../app/lib/mcp/server-definitions')).publishMcpServerDefinition(app.organizationId, 'Own Chat metadata MCP',
      { url: 'https://203.0.113.74/mcp', transport: 'http', auth: 'none', enabled: true });
    await (await import('../app/lib/mcp/personal-connections')).createPersonalMcpConnection('owner', definition.id, 'Own exact Chat MCP');
    const beforeAllAccounts = accountReads();
    const all = await listChatExtensionOptions(owner, { operation: 'search', target, limit: 50 }); assert(all.operation === 'search');
    assert.deepEqual(new Set(all.items.map(value => value.item.kind)), new Set(['plugin', 'skill', 'integration', 'mcp']));
    assert.equal(accountReads(), beforeAllAccounts, 'One four-type search is metadata-only.');
    for (const q of ['Canva', 'can']) {
      const search = await listChatExtensionOptions(owner, { operation: 'search', target, q, limit: 50 });
      assert(search.operation === 'search');
      assert(search.items.some(row => row.item.kind === 'integration' && row.item.toolkit.slug === 'canva'
        && row.item.displayName === 'Canva'), 'Common search accepts the displayed app name and a partial query.');
      assert.equal(search.coverage.find(source => source.source === 'composio')?.status, 'complete');
    }
    const namedSearch = await POST(request('owner', { operation: 'search', target, q: 'Canva' }));
    assert.equal(namedSearch.status, 200);
    assert((await namedSearch.json()).data.items.some((row: { item: { kind: string; name: string } }) =>
      row.item.kind === 'integration' && row.item.name === 'canva'));
    assert.equal(accountReads(), beforeAllAccounts, 'Name and partial catalogue searches never enumerate accounts.');
    const maskedAgent = await management.createManagedAgent(owner, { name: `Fixed masked ${name}`, scopeType: 'user', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', standalone: [], selections: [{ selection: { kind: 'plugin', package: pin,
        skillSelection: { kind: 'subset', relativeRoots: ['skills/one'] } }, requirement: 'optional', toolCap: [] }], workflow: { version: 1, packages: [
        { ...pin, skillSelection: { kind: 'plugin' }, declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [
          { capabilityId: 'read', selection: { mode: 'selectable', allowedChoices: [] } }] }] }] } } });
    const maskedTarget = { ...target, agentId: maskedAgent.agent.agentId };
    const masked = await listChatExtensionOptions(owner, { operation: 'package_version', target: maskedTarget, ...pin }); assert(masked.operation === 'package_version');
    assert.deepEqual(masked.package.children.map(child => child.relativeRoot), ['skills/one']);
    const forbiddenChild: ChatBodyV1 = { version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'forbidden-child', bundleId: 'forbidden-child' }], bundles: [
      { id: 'forbidden-child', caption: 'Two', primary: { selection: { kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot: 'skills/two' },
        requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] };
    const forbiddenPreview = await listChatExtensionOptions(owner, { operation: 'preview', target: maskedTarget, body: forbiddenChild,
      intakeSelection: { version: 1, origin: 'turn_reference', selections: [forbiddenChild.bundles[0]!.primary] } });
    assert(forbiddenPreview.operation === 'preview'); assert.equal(forbiddenPreview.preview.configurationReadiness, 'blocked');

    stage = 'MRU derives real accepted receipt time and exact body, never replay/update time';
    const frame = await fixture.createSessionRuntime({ userId: 'owner', agentId: general.agent.agentId });
    const { prepareChatMessageAdmission, commitPreparedChatMessageAdmission } = await import('../app/lib/pi/durable-message-admission');
    const entry = { selection: { kind: 'plugin' as const, package: pin, skillSelection: { kind: 'subset' as const, relativeRoots: ['skills/one'] } }, requirement: 'optional' as const, toolCap: null };
    const body: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: 'Use ' }, { type: 'extension_reference', occurrenceId: 'one', bundleId: 'real-plugin' }],
      bundles: [{ id: 'real-plugin', caption: 'Saved immutable caption', primary: entry, supporting: [], packageConnections: [] }] };
    const selection: ChatExtensionSelectionInput = { version: 1, origin: 'turn_reference', selections: [entry] };
    const input = { userId: 'owner', sessionId: frame.sessionId, clientMessageId: `chat-options-${randomUUID()}`, message: { role: 'user' as const,
      content: 'Use Saved immutable caption', timestamp: Date.now() }, context: {}, body, selection };
    const prepared = await prepareChatMessageAdmission(input); assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') throw new Error('Fresh receipt expected'); await commitPreparedChatMessageAdmission(prepared.admission);
    const recent = await listChatExtensionOptions(owner, { operation: 'recents', target }); assert(recent.operation === 'recents');
    const accepted = recent.items.find(item => item.bodyBundle.primary.selection.kind === 'plugin' && item.bodyBundle.primary.selection.package.resourceRef === pin.resourceRef);
    assert(accepted); assert.equal(accepted.bodyBundle.caption, 'Saved immutable caption'); assert.deepEqual(accepted.bodyBundle.primary.selection, entry.selection);
    const replay = await prepareChatMessageAdmission(input); assert.equal(replay.kind, 'replay');
    await sql(database => database.run('UPDATE pi_message_delivery_receipts SET updated_at=updated_at+1000 WHERE client_message_id=$1', [input.clientMessageId]));
    const again = await listChatExtensionOptions(owner, { operation: 'recents', target }); assert(again.operation === 'recents');
    assert.equal(again.items.find(item => item.bodyBundle.id === accepted.bodyBundle.id)?.lastAcceptedAt, accepted.lastAcceptedAt);
    assert.doesNotMatch(JSON.stringify(again), /privateFixedBindings|bindingFingerprint|accountSelectionRef|runtime_token|rootPath|providerRef/u);
    const childEntry = { selection: { kind: 'skill' as const, origin: 'plugin_child' as const, relativeRoot: 'skills/two', package: pin },
      requirement: 'optional' as const, toolCap: null };
    const secondBody: ChatBodyV1 = { version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'both-plugin', bundleId: 'latest-parent' },
      { type: 'extension_reference', occurrenceId: 'both-child', bundleId: 'latest-child' }], bundles: [
      { ...body.bundles[0]!, id: 'latest-parent', caption: 'Newest exact parent' },
      { id: 'latest-child', caption: 'Exact child', primary: childEntry, supporting: [], packageConnections: [] }] };
    const nextIntent = { ...input, clientMessageId: `chat-options-${randomUUID()}`, body: secondBody,
      message: { ...input.message, content: 'Newest exact parentExact child' }, selection: { ...selection, selections: [entry, childEntry] } };
    const secondAdmission = await prepareChatMessageAdmission(nextIntent); assert(secondAdmission.kind === 'prepared');
    await commitPreparedChatMessageAdmission(secondAdmission.admission);
    const page1 = await listChatExtensionOptions(owner, { operation: 'recents', target, limit: 1 }); assert(page1.operation === 'recents');
    assert.equal(page1.items.length, 1); assert.equal(page1.items[0]?.bodyBundle.caption, 'Newest exact parent'); assert(page1.pagination.nextCursor);
    const page2 = await listChatExtensionOptions(owner, { operation: 'recents', target, limit: 1, cursor: page1.pagination.nextCursor }); assert(page2.operation === 'recents');
    assert.equal(page2.items.length, 1); assert.equal(page2.items[0]?.bodyBundle.primary.selection.kind, 'skill');
    if (page2.pagination.nextCursor) { const page3 = await listChatExtensionOptions(owner, { operation: 'recents', target, limit: 1, cursor: page2.pagination.nextCursor });
      assert(page3.operation === 'recents'); assert.equal(page3.items.length, 0, 'The older duplicate parent must not return on another page.'); }
    const filtered = await listChatExtensionOptions(owner, { operation: 'search', target, types: ['skill'], scope: 'organization' });
    assert(filtered.operation === 'search'); assert(filtered.recents.length > 0 && filtered.recents.every(item => item.bodyBundle.primary.selection.kind === 'skill'));
    const realTarget = { kind: 'turn' as const, sessionId: frame.sessionId, expectedAgentId: frame.agentId, expectedWorkspaceId: app.owner.workspaceId! };
    assert.equal((await listChatExtensionOptions(owner, { operation: 'recents', target: realTarget })).operation, 'recents');
    stage = 'actual stored Session full four-source search and historical presentation';
    const turnSearch = await listChatExtensionOptions(owner, { operation: 'search', target: realTarget, q: '',
      types: ['plugin', 'skill', 'integration', 'mcp'] });
    assert(turnSearch.operation === 'search'); assert(turnSearch.recents.some(item => item.bodyBundle.primary.selection.kind === 'plugin'
      && item.bodyBundle.primary.selection.package.resourceRef === pin.resourceRef));
    const turnPresentation = await listChatExtensionOptions(owner, { operation: 'presentation', target: realTarget, selections: [entry.selection] });
    assert(turnPresentation.operation === 'presentation'); assert.equal(turnPresentation.entries.length, 1);
    assert.deepEqual(turnPresentation.entries[0]!.selection, entry.selection); assert(turnPresentation.entries[0]!.publicIcon);
    await assert.rejects(listChatExtensionOptions(owner, { operation: 'recents', target: { ...realTarget, expectedAgentId: fixed.agent.agentId } }));
    const other = await fixture.createSessionRuntime({ userId: 'alice', agentId: sharedAgent.agent.agentId });
    const otherBody: ChatBodyV1 = { ...body, bundles: [{ ...body.bundles[0]!, caption: 'Alice-only accepted caption' }] };
    const otherPrepared = await prepareChatMessageAdmission({ ...input, userId: 'alice', sessionId: other.sessionId,
      clientMessageId: `chat-options-${randomUUID()}`, body: otherBody, message: { ...input.message, content: 'Use Alice-only accepted caption' } });
    assert(otherPrepared.kind === 'prepared'); await commitPreparedChatMessageAdmission(otherPrepared.admission);
    const isolated = await listChatExtensionOptions(owner, { operation: 'recents', target }); assert(isolated.operation === 'recents');
    assert(!isolated.items.some(item => item.bodyBundle.caption === 'Alice-only accepted caption'));
    const retained = await contexts.resolveChatExtensionOptionsContext(alice, aliceTarget);
    await sql(database => database.run("UPDATE agent_grants SET can_use=0 WHERE agent_id=$1 AND target_id='alice'", [sharedAgent.agent.agentId]));
    await assert.rejects(contexts.revalidateChatExtensionOptionsContext(retained), { code: 'AGENT_ACCESS_DENIED' });
    const fresh = await contexts.resolveChatExtensionOptionsContext(owner, target);
    await sql(database => database.run('UPDATE agents SET revision=revision+1 WHERE agent_id=$1', [general.agent.agentId]));
    await assert.rejects(contexts.revalidateChatExtensionOptionsContext(fresh), { code: 'CHAT_EXTENSION_CONTEXT_CHANGED' });
    assert.equal(forbidden, 0); assert.equal(fixture.counts().forbiddenModelRequests, 0);
    assert(provider.calls.every(call => /^\/api\/v3\.1\/(toolkits|connected_accounts)/u.test(call.path)));
    console.log('PASS Chat extension options: browser contract, actual SQL/API/Use, immutable packages/template, explicit accounts, no-probe presentation, Admission-derived MRU.');
  } catch (error) { console.error(`Chat options fixture failed during ${stage}`); throw error; }
  finally {
    globalThis.fetch = beforeFetch; for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await provider.close(); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
