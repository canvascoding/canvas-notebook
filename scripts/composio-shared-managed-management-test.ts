import assert from 'node:assert/strict';
import Module from 'node:module';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { createActualManagedProxy } from './helpers/actual-managed-composio-fixture';

async function main() {
  if (!process.env.CANVAS_CONTROL_PLANE_TEST_ROOT) throw new Error('CANVAS_CONTROL_PLANE_TEST_ROOT is required for shared Managed Composio acceptance.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-shared-managed-'));
  const provider = await createComposioProviderFixture();
  const keys = ['DATA', 'CANVAS_DATA_ROOT', 'INTEGRATIONS_ENV_MASTER_KEY', 'COMPOSIO_BASE_URL', 'CANVAS_INSTANCE_ID', 'BASE_URL',
    'CANVAS_MANAGED_SERVICES_ENABLED', 'CANVAS_CONTROL_PLANE_URL', 'CANVAS_INSTANCE_TOKEN'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATA: root, CANVAS_DATA_ROOT: root, INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), COMPOSIO_BASE_URL: provider.baseUrl,
    CANVAS_INSTANCE_ID: 'composio-runtime', BASE_URL: 'https://notebook.example.test', CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_INSTANCE_TOKEN: 'fixture-instance-token' });
  let managedKey = 'fixture-managed-profile-key';
  const managed = await createActualManagedProxy(() => managedKey);
  process.env.CANVAS_CONTROL_PLANE_URL = managed.baseUrl;
  const database = await createPiTestDatabase();
  const raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)
    ? database : original(name, parent, isMain);
  try {
    for (const id of ['managed-owner', 'managed-delegate']) await raw.run(
      'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@managed.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('notebook-managed-org','managed-owner','team',1,1000,1000)");
    for (const id of ['managed-owner', 'managed-delegate']) await raw.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('notebook-managed-org',$1,$2,'active',1000,1000)", [id, id === 'managed-owner' ? 'owner' : 'member']);
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'fixture-org-local-not-selected' }], { secretScope: 'organization', organizationId: 'notebook-managed-org' });
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'fixture-system-local-not-selected' }], { secretScope: 'legacy' });
    const profiles = await import('../app/lib/composio/composio-shared-profiles');
    const backend = await import('../app/lib/composio/composio-shared-backend');
    const store = await import('../app/lib/integration-tools/connections/store');
    const actions = await import('../app/lib/composio/composio-shared-connections');
    const callback = await import('../app/api/composio/shared/callback/route');
    const owner = { userId: 'managed-owner', workspaceId: null };
    const delegate = { userId: 'managed-delegate', workspaceId: null };
    const ownership = { type: 'organization' as const, organizationId: 'notebook-managed-org' };
    const profile = await profiles.createSharedComposioProfile({ actor: owner, ownership, name: 'Managed marketing', providerMode: 'managed' });
    const connection = await store.createSharedIntegrationConnection(owner, { ownership, displayName: 'Managed Canva', grants: [
      { targetType: 'user', targetId: delegate.userId, canUse: false, canManage: true, allowedToolNames: null },
    ], backend: await backend.prepareSharedComposioConnectionBackend(owner, { profileId: profile.id, ownership, toolkit: 'canva' }) });
    const ref = connection.resource.connectionRef;
    provider.accounts.set(profile.composioUserId, [{ id: 'managed-canva-first', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'managed-canva-selected', toolkit: 'canva', status: 'ACTIVE' }, { id: 'managed-slack-private', toolkit: 'slack', status: 'ACTIVE' }]);
    const revs = async () => { const record = (await store.getIntegrationConnectionRecord(ref))!; return {
      metadataRevision: record.resource.metadataRevision, grantsRevision: record.resource.grantsRevision, bindingRevision: record.resource.bindingRevision }; };
    const accountId = async () => { const record = (await store.getIntegrationConnectionRecord(ref))!; return record.backend.source === 'composio' ? record.backend.connectedAccountId : null; };
    const accounts = await actions.listSharedComposioConnectionAccounts(delegate, ref);
    assert.equal(accounts.accounts.length, 2);
    await actions.bindSharedComposioConnectionAccount(delegate, ref, { accountRef: accounts.accounts[1].accountRef, revisions: accounts.revisions });
    assert.equal(await accountId(), 'managed-canva-selected');
    const connected = await actions.connectSharedComposioConnection(delegate, ref, { revisions: await revs() });
    assert(connected.flowId);
    const initiated = provider.accounts.get(profile.composioUserId)!.find(account => account.status === 'INITIATED')!;
    const controlPlaneCallback = provider.completeOAuth(initiated.id)!;
    const brokerResponse = await fetch(controlPlaneCallback, { redirect: 'manual' });
    assert.equal(brokerResponse.status, 302);
    const notebookCallback = brokerResponse.headers.get('location')!;
    const finished = await callback.GET(new Request(notebookCallback));
    assert.equal(finished.status, 307);
    assert.equal(await accountId(), initiated.id);
    assert.equal((await actions.getSharedComposioConnectionStatus(delegate, ref)).state, 'ready');
    assert.equal((await callback.GET(new Request(notebookCallback))).status, 409);
    const reconnect = await actions.connectSharedComposioConnection(delegate, ref, { revisions: await revs() });
    assert(reconnect.flowId);
    const pending = provider.accounts.get(profile.composioUserId)!.find(account => account.status === 'INITIATED')!;
    const rotatedBroker = provider.completeOAuth(pending.id)!;
    const rotatedNotebook = (await fetch(rotatedBroker, { redirect: 'manual' })).headers.get('location')!;
    managedKey = 'fixture-rotated-managed-profile-key';
    assert.equal((await callback.GET(new Request(rotatedNotebook))).status, 409);
    assert.equal(await accountId(), initiated.id);
    managedKey = 'fixture-managed-profile-key';
    await actions.disconnectSharedComposioConnection(delegate, ref, await revs());
    assert.equal(await accountId(), null);
    assert(provider.accounts.get(profile.composioUserId)!.some(account => account.id === 'managed-canva-first'));
    assert(!provider.accounts.get(profile.composioUserId)!.some(account => account.id === initiated.id));
    assert(provider.calls.every(call => call.apiKey === 'fixture-managed-profile-key' || call.apiKey === 'fixture-rotated-managed-profile-key'), 'Explicit Managed never switches to existing local keys');
    assert(provider.calls.filter(call => call.path === '/api/v3.1/tool_router/session').every(call => call.body.user_id === profile.composioUserId));
    console.log('PASS cross-repository actual Notebook SQL → Managed CP router → Composio SDK: pinned mode, scoped account selection, OAuth broker/callback, credential rotation and exact disconnect');
  } finally {
    loader._load = original; await database.close(); await managed.close(); await provider.close(); await fs.rm(root, { recursive: true, force: true });
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
