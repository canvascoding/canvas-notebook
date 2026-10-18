import assert from 'node:assert/strict';
import Module from 'node:module';
import { parseChatBody, type ChatReferenceBundleV1 } from '../app/lib/chat/chat-body-contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import type { ChatExtensionOptionsTarget, ChatExtensionSearchRequest } from '../app/lib/chat/extension-options-contracts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

/** Actual request parser/dispatch, Recent serializer, canonical body codec, connection validation and icon presentation.
 * SQL/source/ACL boundaries are controlled fixtures; the provider catalogue is held unresolved. No server, provider or database starts. */
async function main() {
  const target: ChatExtensionOptionsTarget = { kind: 'draft_turn', workspaceId: 'local-workspace', agentId: 'local-agent' };
  const actor = { userId: 'local-owner', workspaceId: target.workspaceId, source: 'api' as const };
  const context = { actor, target, contextKey: 'local-recents-context', organizationId: null, allowPersonal: true };
  const header = { schemaVersion: 1, target, contextKey: context.contextKey, coverage: [], limits: EXTENSION_SELECTION_LIMITS,
    agentRevision: 1, workflowRevision: 0, preferenceRevision: 0, finalSendValidationRequired: true };
  const core = { kind: 'core_skill' as const, coreSource: { resourceRef: 'canvas-capability:v1:skill:system:core:skill-creator' as const, coreRevision: '1.0.0', checksum: 'a'.repeat(64) } };
  const account = { kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva', target: { kind: 'personal' as const,
    profileId: 'own-profile', accountBinding: 'account' as const, accountId: 'own-account', connectionRef: 'composio-personal:own-profile:own-account' } };
  const noAuth = { kind: 'composio' as const, source: 'composio' as const, toolkit: 'public-app', target: { kind: 'personal' as const,
    profileId: 'own-profile', accountBinding: 'no_auth' as const } };
  const mcp = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'personal' as const,
    connectionRef: 'mcp-personal:00000000-0000-4000-8000-000000000001' } };
  const pin = { resourceRef: 'canvas-resource:00000000-0000-4000-8000-000000000002',
    publishedRevisionRef: 'canvas-package-revision:00000000-0000-4000-8000-000000000002', checksum: 'b'.repeat(64) };
  const noAuthPin = { ...pin, resourceRef: 'canvas-resource:00000000-0000-4000-8000-000000000003' };
  const bundle = (id: string, selection: ChatReferenceBundleV1['primary']['selection']): ChatReferenceBundleV1 => ({ id, caption: id,
    primary: { selection, requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] });
  const packageNoAuth: ChatReferenceBundleV1 = { ...bundle('package-with-no-auth', { kind: 'plugin', package: noAuthPin, skillSelection: { kind: 'all' } }),
    supporting: [{ selection: noAuth, requirement: 'optional', toolCap: null }], packageConnections: [{ package: noAuthPin,
      declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'public', alternativeKey: 'composio:public-app', connectionSelection: noAuth }] };
  const localPackage = bundle('local-package', { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } });
  const bundles = [bundle('local-core', core), localPackage, bundle('exact-account', account), bundle('local-mcp', mcp), bundle('unverified-no-auth', noAuth), packageNoAuth];
  const rows = bundles.map((value, index) => ({ created_at: 100 - index, session_id: `prior-session-${index}`, client_message_id: `prior-message-${index}`,
    actor: actor.userId, workspace: actor.workspaceId, agent: target.agentId, actual_agent: target.agentId, stored_session: `prior-session-${index}`,
    body: parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: `occurrence-${index}`, bundleId: value.id }], bundles: [value] }) }));
  let catalogue = deferred<{ items: unknown[] }>(), catalogueCalls = 0, revalidations = 0, coreChecks = 0, packageChecks = 0, packageSourceReads = 0, mcpChecks = 0, coreAllowed = true;
  const providerItems = (allowsNoAuth: boolean) => ({ items: [{ kind: 'integration', toolkit: { slug: 'canva', noAuth: false }, icon: { url: 'https://logos.example.test/canva.svg', sourceKey: 'canva' } },
    { kind: 'integration', toolkit: { slug: 'public-app', noAuth: allowsNoAuth }, icon: { url: 'https://logos.example.test/public-app.svg', sourceKey: 'public-app' } }] });
  const forbidden = () => { throw new Error('An unrelated source/authority boundary must not run.'); };
  const contextBoundary = { resolveChatExtensionOptionsContext: async () => context, chatExtensionOptionsHeader: () => header,
    revalidateChatExtensionOptionsContext: async () => { revalidations++; }, authorizeChatExtensionSharedOption: forbidden };
  const eligibilityBoundary = { chatCorePluginSelectionEligibility: async () => { coreChecks++; return { action: coreAllowed ? 'select' : 'unavailable' }; },
    chatPackageSelectionEligibility: async () => { packageChecks++; return { action: 'select' }; }, chatPackageBinding: forbidden, chatPermittedPackageRoots: forbidden,
    chatStandaloneEligibility: () => ({ action: 'select' }), chatStandaloneToolCap: () => null, intersectChatCaps: (_allowed: unknown, requested: unknown) => requested,
    resolveChatConnectionScope: async () => ({ allowed: null, personal: [{}], alternatives: [], toolCap: null }) };
  const inventoryBoundary = { readAgentComposioOptionsCatalogue: async () => { catalogueCalls++; return catalogue.promise; },
    readAgentOwnMcpOptionMetadata: async () => { mcpChecks++; return { serverName: 'local-mcp', connection: { enabled: true } }; }, readAgentSharedMcpOptionMetadata: forbidden };
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    const filename = parent?.filename ?? '';
    if (/\/app\/lib\/chat\/(?:extension-options|extension-options-recents|extension-options-presentation|extension-options-validation)\.ts$/u.test(filename)) {
      if (name === './extension-options-context') return contextBoundary;
      if (name === './extension-options-eligibility') return eligibilityBoundary;
      if (name === '@/app/lib/db') return { openDb: async () => ({ all: async () => rows, close: async () => undefined }) };
      if (name === '@/app/lib/agents/extension-options-inventory') return inventoryBoundary;
      if (name === '@/app/lib/composio/composio-profiles') return { listExistingComposioProfiles: async () => [{ id: 'own-profile', ownerUserId: actor.userId, status: 'active' }] };
      if (name === '@/app/lib/integration-tools/adapters/composio') return { isComposioIntegrationApplicationVisible: () => true };
      if (name === '@/app/lib/capabilities/extensions/core-source') return { withAuthorizedCoreSkillSource: async (_actor: unknown, _source: unknown, callback: (skill: object) => unknown) => callback({}), withAuthorizedCorePluginSource: forbidden };
      if (name === '@/app/lib/capabilities/resources/actions') return { listCapabilityResources: forbidden, inspectCapabilityResource: forbidden };
      if (name === '@/app/lib/capabilities/resources/store') return { findCapabilityResourceRecord: forbidden };
      if (name === '@/app/lib/agents/extension-package-options') return { readAgentExtensionPackageVersion: async (_actor: unknown, exact: unknown) => {
        assert.ok(JSON.stringify(exact) === JSON.stringify(pin) || JSON.stringify(exact) === JSON.stringify(noAuthPin));
        packageSourceReads++; return { metadata: { kind: 'plugin' }, source: { manifest: { interface: { logo: 'assets/logo.svg' } } } };
      } };
      if (name === '@/app/lib/integration-tools/connections/store') return { authorizeIntegrationConnection: forbidden };
      if (name === '@/app/lib/composio/composio-shared-account-reference') return { readPersonalComposioAccountReference: forbidden };
      if (name === '@/app/lib/mcp/icon-source') return { mcpIconSourceBinding: forbidden };
      if (name === '@/app/lib/capabilities/packages/mcp-template-matches') return { capabilityPackageMcpConfigCompatibility: forbidden };
      if (name === '@/app/lib/agents/extension-options-connections') return { listChatExtensionConnectionChoices: forbidden };
      if (name === './extension-options-preview') return { previewChatExtensionSelection: forbidden };
      if (name === './extension-options-connection-inventory') return { isChatStandaloneSelectionReady: () => false };
      if (name === '@/app/lib/agents/extension-options-search') return { searchChatExtensionOptions: async (_context: unknown, request: ChatExtensionSearchRequest) => ({ ...header,
        operation: 'search', query: request, selectedItem: null, scopes: { choices: ['all'], teams: [] }, pagination: { nextCursor: null, hasNextPage: false, loadedItems: 1 },
        items: [{ item: { id: 'core-result', kind: 'skill', source: 'local', stock: 'installed', name: 'Skill Creator', displayName: 'Skill Creator' },
          selection: core, eligibility: { action: 'select' }, chatAvailability: 'ready' }] }), getChatExtensionSearchConnections: () => [] };
    }
    return originalLoad(name, parent, isMain);
  };
  const pending: Promise<unknown>[] = [];
  const abort = new AbortController();
  try {
    const { listChatExtensionOptions } = await import('../app/lib/chat/extension-options');
    const input = { operation: 'search' as const, target, q: '', phase: 'local' as const, limit: 50 };
    let settled = false;
    const local = listChatExtensionOptions(actor, input, { signal: abort.signal }).then(result => { settled = true; return result; }); pending.push(local.catch(() => undefined));
    for (let step = 0; step < 10 && !settled; step++) await flush();
    assert.equal(settled, true, 'The real local request/Recent serializer must return without releasing the blocked provider catalogue.');
    const result = await local; assert.equal(result.operation, 'search'); if (result.operation !== 'search') throw new Error('Expected search');
    assert.equal(result.items[0]?.chatAvailability, 'ready');
    assert.deepEqual(result.recents.map(recent => recent.bodyBundle.id), ['local-core', 'local-package', 'exact-account', 'local-mcp']);
    assert.deepEqual(result.recents.find(recent => recent.bodyBundle.id === 'local-package')?.bodyBundle.primary.selection, localPackage.primary.selection);
    assert.ok(result.recents.find(recent => recent.bodyBundle.id === 'local-package')?.publicIcon && packageSourceReads > 0, 'Local published package presentation retains its exact local source/pin path.');
    assert.equal(result.recents.find(recent => recent.bodyBundle.id === 'exact-account')?.eligibility.action, 'choose_connection', 'A public historical account never bypasses current explicit confirmation.');
    assert.equal(result.recents.find(recent => recent.bodyBundle.id === 'exact-account')?.publicIcon, undefined, 'Initials replace optional remote logo I/O in the local phase.');
    assert.equal(catalogueCalls, 0); assert.ok(revalidations > 0 && coreChecks > 0 && mcpChecks > 0, 'Local source/actor revalidation remains mandatory.');
    coreAllowed = false;
    const denied = await listChatExtensionOptions(actor, input); assert(denied.operation === 'search');
    assert.equal(denied.recents.some(recent => recent.bodyBundle.id === 'local-core'), false, 'A revoked exact Core recent cannot bypass fresh source eligibility.');
    coreAllowed = true;
    let connectedSettled = false;
    const connected = listChatExtensionOptions(actor, { ...input, phase: 'connected' }).then(value => { connectedSettled = true; return value; }); pending.push(connected.catch(() => undefined));
    for (let step = 0; step < 10 && catalogueCalls === 0; step++) await flush();
    assert.ok(catalogueCalls > 0); assert.equal(connectedSettled, false, 'Connected keeps the existing fresh provider-metadata validation.');
    catalogue.resolve(providerItems(false));
    const checked = await connected; assert(checked.operation === 'search');
    assert.equal(checked.recents.some(recent => recent.bodyBundle.id === 'unverified-no-auth' || recent.bodyBundle.id === 'package-with-no-auth'), false, 'Provider metadata rejecting no-auth cannot become selectable through Local deferral.');
    assert.ok(checked.recents.find(recent => recent.bodyBundle.id === 'exact-account')?.publicIcon, 'The connected phase can enrich the same exact account with its authorized provider logo.');
    catalogue = deferred(); catalogue.resolve(providerItems(true));
    const verifiedNoAuth = await listChatExtensionOptions(actor, { ...input, phase: 'connected' }); assert(verifiedNoAuth.operation === 'search');
    assert.ok(verifiedNoAuth.recents.some(recent => recent.bodyBundle.id === 'unverified-no-auth'), 'A real later no-auth declaration is checked before the recent can return.');
    assert.ok(verifiedNoAuth.recents.some(recent => recent.bodyBundle.id === 'package-with-no-auth'), 'A deferred package retains its complete mapped dependency when Connected verifies no-auth.');
    assert.ok(packageChecks > 0, 'Packages with no-auth dependencies still pass their package policy check in the connected phase.');
    const before = catalogueCalls;
    await listChatExtensionOptions(actor, input); assert.equal(catalogueCalls, before, 'A warmed catalogue never reintroduces provider I/O into Local.');
    console.log('PASS actual empty Local Chat request + Recent serializer: local rows and locally verified recents return while provider catalogue is blocked; account confirmation, revoked source and no-auth validation remain strict; connected-only logo enrichment. Controlled metadata/SQL/ACL boundaries, no server or live provider.');
  } finally {
    abort.abort(); catalogue.resolve(providerItems(false)); await Promise.all(pending); loader._load = originalLoad;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
