import assert from 'node:assert/strict';
import Module from 'node:module';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

const hasCode = (code: string) => (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === code;

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-management-'));
  const provider = await createComposioProviderFixture();
  const keys = ['DATA', 'CANVAS_DATA_ROOT', 'INTEGRATIONS_ENV_MASTER_KEY', 'COMPOSIO_BASE_URL', 'COMPOSIO_API_KEY', 'CANVAS_INSTANCE_ID', 'BASE_URL', 'CANVAS_MANAGED_SERVICES_ENABLED'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'),
    COMPOSIO_BASE_URL: provider.baseUrl, CANVAS_INSTANCE_ID: 'shared-management', BASE_URL: 'http://localhost:3000', CANVAS_MANAGED_SERVICES_ENABLED: 'false' });
  delete process.env.COMPOSIO_API_KEY;
  const database = await createPiTestDatabase();
  const raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (name === '@/app/lib/auth' || /\/app\/lib\/auth(?:\.ts)?$/u.test(name)) return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const userId = headers.get('x-fixture-user'); return userId ? { user: { id: userId }, session: { id: `fixture-${userId}` } } : null;
    } } } };
    return original(name, parent, isMain);
  };
  try {
    for (const id of ['owner', 'creator', 'delegate', 'reader', 'unassigned']) await raw.run(
      'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@management.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org-management','owner','team',1,1000,1000)");
    for (const id of ['owner', 'creator', 'delegate', 'reader', 'unassigned']) await raw.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-management',$1,$2,'active',0,1000,1000)",
      [id, id === 'owner' ? 'owner' : id === 'creator' ? 'admin' : 'member']);
    const actor = (userId: string) => ({ userId, workspaceId: null });
    const ownership = { type: 'organization' as const, organizationId: 'org-management' };
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const orgScope = { secretScope: 'organization' as const, organizationId: ownership.organizationId };
    const setKey = (value: string | null) => replaceScopedEnvEntries('integrations', value ? [{ key: 'COMPOSIO_API_KEY', value }] : [], orgScope);
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'fixture-system-not-selected' }], { secretScope: 'legacy' });
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'fixture-user-not-selected' }], { secretScope: 'user', userId: 'creator' });
    const profiles = await import('../app/lib/composio/composio-shared-profiles');
    const backend = await import('../app/lib/composio/composio-shared-backend');
    const store = await import('../app/lib/integration-tools/connections/store');
    const actions = await import('../app/lib/composio/composio-shared-connections');
    const callback = await import('../app/api/composio/shared/callback/route');
    const profileRoutes = await import('../app/api/composio/shared-profiles/route');
    const accountRoutes = await import('../app/api/composio/shared-connections/[connectionRef]/accounts/route');
    const profile = await profiles.createSharedComposioProfile({ actor: actor('creator'), ownership, name: 'Shared designs', providerMode: 'local' });
    await assert.rejects(backend.prepareSharedComposioConnectionBackend(actor('creator'), { profileId: profile.id, ownership, toolkit: 'canva' }), hasCode('setup_required'));
    assert.equal(provider.calls.length, 0, 'An absent org key must not use existing system or user keys');
    await setKey('fixture-organization-key');
    const grants = [
      { targetType: 'user' as const, targetId: 'delegate', canUse: false, canManage: true, allowedToolNames: null },
      { targetType: 'user' as const, targetId: 'reader', canUse: true, canManage: false, allowedToolNames: ['DESIGN_CREATE'] },
    ];
    const created = await store.createSharedIntegrationConnection(actor('creator'), { ownership, displayName: 'Marketing Canva', grants,
      backend: await backend.prepareSharedComposioConnectionBackend(actor('creator'), { profileId: profile.id, ownership, toolkit: 'canva' }) });
    const ref = created.resource.connectionRef;
    provider.accounts.set(profile.composioUserId, [{ id: 'canva-account-first', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'canva-account-selected', toolkit: 'canva', status: 'ACTIVE' }, { id: 'slack-not-shared', toolkit: 'slack', status: 'ACTIVE' }]);
    const revisions = async () => {
      const record = (await store.getIntegrationConnectionRecord(ref))!;
      return { metadataRevision: record.resource.metadataRevision, grantsRevision: record.resource.grantsRevision, bindingRevision: record.resource.bindingRevision };
    };
    const selectedAccount = async () => { const record = (await store.getIntegrationConnectionRecord(ref))!; return record.backend.source === 'composio' ? record.backend.connectedAccountId : null; };
    await assert.rejects(profiles.inspectSharedComposioProfile(actor('delegate'), profile.id));
    await assert.rejects(actions.listSharedComposioConnectionAccounts(actor('reader'), ref));
    const selection = await actions.listSharedComposioConnectionAccounts(actor('delegate'), ref);
    assert.equal(selection.accounts.length, 2);
    assert(selection.accounts.every(account => account.selectable));
    assert(!JSON.stringify(selection).includes('canva-account-selected'));
    assert(!JSON.stringify(selection).includes(profile.composioUserId));
    assert.equal(provider.calls.filter(call => call.path === '/api/v3.1/connected_accounts').at(-1)?.toolkitSlugs, 'canva');
    await assert.rejects(actions.bindSharedComposioConnectionAccount(actor('creator'), ref, { accountRef: selection.accounts[1].accountRef, revisions: selection.revisions }), hasCode('binding_changed'));
    await actions.bindSharedComposioConnectionAccount(actor('delegate'), ref, { accountRef: selection.accounts[1].accountRef, revisions: selection.revisions });
    assert.equal(await selectedAccount(), 'canva-account-selected');
    await assert.rejects(actions.bindSharedComposioConnectionAccount(actor('delegate'), ref, { accountRef: selection.accounts[0].accountRef, revisions: selection.revisions }));
    assert.equal((await actions.getSharedComposioConnectionStatus(actor('reader'), ref)).state, 'ready');
    await assert.rejects(profiles.mutateSharedComposioProfile({ actor: actor('creator'), profileId: profile.id, expectedProfileRevision: 1, status: 'archived' }), hasCode('profile_in_use'));
    const start = () => revisions().then(value => actions.connectSharedComposioConnection(actor('delegate'), ref, { revisions: value }));
    const sessionCalls = () => provider.calls.filter(call => call.path === '/api/v3.1/tool_router/session').length;
    const linkCalls = () => provider.calls.filter(call => /\/session\/[^/]+\/link$/u.test(call.path)).length;
    let sessionsBefore = sessionCalls();
    provider.rotateOnEndpoint('/api/v3.1/toolkits', async () => { await setKey('fixture-rotated-organization-key'); });
    await assert.rejects(start(), hasCode('binding_changed'));
    assert.equal(sessionCalls(), sessionsBefore, 'Credential rotation during app verification must prevent creating an OAuth session');
    await setKey('fixture-organization-key');
    sessionsBefore = sessionCalls();
    const linksBefore = linkCalls();
    provider.rotateOnEndpoint('/api/v3.1/tool_router/session', async () => { await setKey('fixture-rotated-organization-key'); });
    await assert.rejects(start(), hasCode('binding_changed'));
    assert.equal(sessionCalls(), sessionsBefore + 1);
    assert.equal(linkCalls(), linksBefore, 'Credential rotation during session creation must prevent linking under another project');
    await setKey('fixture-organization-key');
    const firstFlow = await start();
    assert(firstFlow.flowId);
    const initiated = provider.accounts.get(profile.composioUserId)!.find(account => account.status === 'INITIATED')!;
    const returnUrl = provider.completeOAuth(initiated.id)!;
    const completed = await callback.GET(new Request(returnUrl));
    assert.equal(completed.status, 307);
    assert.match(completed.headers.get('location')!, /composio=connected/u);
    assert.equal(await selectedAccount(), initiated.id, 'OAuth binds the exact initiated account among multiple ACTIVE accounts');
    assert.equal((await callback.GET(new Request(returnUrl))).status, 409, 'Consumed callback cannot be replayed');
    const staleFlow = await start();
    const stalePending = provider.accounts.get(profile.composioUserId)!.find(account => account.status === 'INITIATED')!;
    const staleReturn = provider.completeOAuth(stalePending.id)!;
    const before = await revisions();
    await store.mutateSharedIntegrationConnection(actor('creator'), ref, { expectedMetadataRevision: before.metadataRevision,
      expectedGrantsRevision: before.grantsRevision, expectedBindingRevision: before.bindingRevision, metadata: { description: 'Changed during consent' } });
    assert.equal((await callback.GET(new Request(staleReturn))).status, 409);
    assert.equal(await selectedAccount(), initiated.id);
    assert(staleFlow.flowId);
    const rotatedFlow = await start();
    const rotatedPending = provider.accounts.get(profile.composioUserId)!.find(account => account.status === 'INITIATED')!;
    const rotatedReturn = provider.completeOAuth(rotatedPending.id)!;
    await setKey('fixture-rotated-organization-key');
    assert.equal((await callback.GET(new Request(rotatedReturn))).status, 409);
    assert.equal(await selectedAccount(), initiated.id);
    assert(rotatedFlow.flowId);
    await setKey('fixture-organization-key');
    const revokedFlow = await start();
    const revokedPending = provider.accounts.get(profile.composioUserId)!.find(account => account.status === 'INITIATED')!;
    const revokedReturn = provider.completeOAuth(revokedPending.id)!;
    const priorRevoke = await revisions();
    await store.mutateSharedIntegrationConnection(actor('creator'), ref, { expectedMetadataRevision: priorRevoke.metadataRevision,
      expectedGrantsRevision: priorRevoke.grantsRevision, expectedBindingRevision: priorRevoke.bindingRevision, grants: [grants[1]] });
    assert.equal((await callback.GET(new Request(revokedReturn))).status, 403);
    assert.equal(await selectedAccount(), initiated.id);
    assert(revokedFlow.flowId);
    const restore = await revisions();
    await store.mutateSharedIntegrationConnection(actor('creator'), ref, { expectedMetadataRevision: restore.metadataRevision,
      expectedGrantsRevision: restore.grantsRevision, expectedBindingRevision: restore.bindingRevision, grants });
    const request = (userId: string | null, method = 'GET', body?: unknown) => new Request('http://localhost/api/composio/shared-profiles?ownershipType=organization', {
      method, headers: { ...(userId ? { 'x-fixture-user': userId } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await profileRoutes.POST(request(null, 'POST', {}))).status, 401);
    assert.equal((await profileRoutes.POST(request('creator', 'POST', { name: 'Injected', providerMode: 'local', ownership: { type: 'organization', organizationId: 'foreign' } }))).status, 400);
    assert.equal((await profileRoutes.GET(request('delegate'))).status, 403, 'A delegated app manager cannot list the shared profile container');
    const apiAccounts = await accountRoutes.GET(request('delegate'), { params: Promise.resolve({ connectionRef: ref }) });
    assert.equal(apiAccounts.status, 200);
    assert(!JSON.stringify(await apiAccounts.json()).includes(initiated.id));
    const currentApiRevision = await revisions();
    assert.equal((await accountRoutes.PATCH(request('delegate', 'PATCH', { expectedMetadataRevision: currentApiRevision.metadataRevision,
      expectedGrantsRevision: currentApiRevision.grantsRevision, expectedBindingRevision: currentApiRevision.bindingRevision,
      accountRef: selection.accounts[1].accountRef, connectedAccountId: initiated.id }), { params: Promise.resolve({ connectionRef: ref }) })).status, 400);
    const deletesBeforeRotation = provider.calls.filter(call => call.path.endsWith(`/connected_accounts/${initiated.id}`)).length;
    provider.rotateOnEndpoint('/api/v3.1/connected_accounts', async () => { await setKey('fixture-rotated-organization-key'); });
    await assert.rejects(actions.disconnectSharedComposioConnection(actor('delegate'), ref, await revisions()), hasCode('binding_changed'));
    assert.equal(provider.calls.filter(call => call.path.endsWith(`/connected_accounts/${initiated.id}`)).length, deletesBeforeRotation,
      'Credential rotation during account verification must prevent deleting with an unbound project key');
    assert.equal(await selectedAccount(), initiated.id);
    await setKey('fixture-organization-key');
    provider.setUnknownManagement(true);
    const beforeUnknown = provider.calls.filter(call => call.path.endsWith(`/connected_accounts/${initiated.id}`)).length;
    await assert.rejects(actions.disconnectSharedComposioConnection(actor('delegate'), ref, await revisions()), hasCode('outcome_unknown'));
    assert.equal(provider.calls.filter(call => call.path.endsWith(`/connected_accounts/${initiated.id}`)).length, beforeUnknown + 1);
    assert.equal(await selectedAccount(), initiated.id);
    provider.setUnknownManagement(false);
    await actions.disconnectSharedComposioConnection(actor('delegate'), ref, await revisions());
    assert.equal(await selectedAccount(), null);
    assert(provider.accounts.get(profile.composioUserId)!.some(account => account.id === 'canva-account-first'));
    assert(!provider.accounts.get(profile.composioUserId)!.some(account => account.id === initiated.id));
    const noAuth = await backend.prepareSharedComposioConnectionBackend(actor('creator'), { profileId: profile.id, ownership, toolkit: 'duckduckgo' });
    assert.equal(noAuth.accountBinding, 'no_auth');
    assert(provider.calls.every(call => call.apiKey === 'fixture-organization-key' || call.apiKey === 'fixture-rotated-organization-key'), 'Shared local uses only the owning organization key');
    console.log('PASS actual SQL/API/Composio SDK: opaque exact account selection, scoped OAuth callback CAS/replay/revoke/key change, delegated app management, no fallback, one unknown mutation and exact disconnect');
  } finally {
    loader._load = original; await database.close(); await provider.close(); await fs.rm(dataRoot, { recursive: true, force: true });
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
