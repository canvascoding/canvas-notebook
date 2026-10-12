import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationConnectionActor, IntegrationConnectionGrantInput } from '../app/lib/integration-tools/connections/contracts';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-connection-store-'));
  const keys = ['DATA', 'CANVAS_ORGANIZATION_ID', 'BASE_URL'], previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { DATA: root, CANVAS_ORGANIZATION_ID: 'org-a', BASE_URL: 'http://localhost:3000' });
  const database = await createSharedConnectionTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = internals._load;
  let actorUserId: string | null = 'admin';
  internals._load = (name, parent, mainModule) => {
    if (name === 'server-only' || name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false };
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async () => ({ mode: 'team', organizationId: 'org-a' }) };
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async () => actorUserId ? { user: { id: actorUserId } } : null } } };
    return original(name, parent, mainModule);
  };
  const raw = await database.openDb();
  const owner = { type: 'team' as const, organizationId: 'org-a', workspaceId: 'team-a' };
  const admin: IntegrationConnectionActor = { userId: 'admin', workspaceId: 'personal-admin', organizationId: 'org-a' };
  const grant = (targetId: string, extra: Partial<IntegrationConnectionGrantInput> = {}): IntegrationConnectionGrantInput =>
    ({ targetType: 'user', targetId, canUse: false, canManage: false, allowedToolNames: null, ...extra });
  try {
    for (const id of ['admin', 'alice', 'manager', 'team-manager', 'member', 'external', 'creator', 'foreign']) {
      await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [id, `${id}@fixture.example.test`]);
    }
    for (const [org, ownerId] of [['org-a', 'admin'], ['org-b', 'foreign']]) await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ($1,$2,'team',1,1,1)", [org, ownerId]);
    for (const id of ['admin', 'alice', 'manager', 'team-manager', 'member', 'external', 'creator', 'foreign']) {
      const org = id === 'foreign' ? 'org-b' : 'org-a';
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ($1,$2,$3,'active',0,1,1)", [org, id, ['admin', 'creator', 'foreign'].includes(id) ? 'admin' : id === 'external' ? 'external' : 'member']);
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,$2,'personal',$3,$1,$3,'active',1,1)", [`personal-${id}`, org, id]);
    }
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-a','org-a','team','team-a','Marketing','active',1,1)");
    for (const id of ['team-manager', 'member']) await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ('org-a','team-a',$1,'member','active',1,$2,1,1)", [id, Number(id === 'team-manager')]);
    const store = await import('../app/lib/integration-tools/connections/store');
    const backend = { source: 'mcp' as const, connectionId: randomUUID() };
    const record = await store.createSharedIntegrationConnection(admin, { ownership: owner, displayName: 'Marketing design', backend,
      allowedToolNames: ['create', 'read'], grants: [grant('alice', { canUse: true, allowedToolNames: ['create'] }),
        grant('manager', { canManage: true }), { ...grant('member', { canUse: true, allowedToolNames: ['read', 'foreign_tool'] }), targetType: 'workspace', targetId: 'personal-alice' }] });
    const ref = record.resource.connectionRef;
    const expected = async () => (await store.getIntegrationConnectionRecord(ref))!.resource;
    const mutate = async (value: object, actor = admin) => {
      const r = await expected();
      return store.mutateSharedIntegrationConnection(actor, ref, { expectedMetadataRevision: r.metadataRevision, expectedGrantsRevision: r.grantsRevision, expectedBindingRevision: r.bindingRevision, ...value });
    };
    assert.equal((await store.inspectSharedIntegrationConnection(admin, ref)).access.canUse, false, 'Org administration remains independent of use and the plugin sharing bit.');
    const alice = { userId: 'alice', workspaceId: 'personal-alice' };
    await raw.run("INSERT INTO canvas_projects (id,organization_id,name,slug,status,created_at,updated_at) VALUES ('project-a','org-a','Project A','project-a','active',1,1)");
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,project_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ('project-workspace','org-a','project','project-a','project-workspace','Project A','active',1,1)");
    await raw.run("INSERT INTO canvas_project_members (organization_id,project_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('org-a','project-a','alice','member','active',0,1,0,1,1)");
    assert.equal((await store.authorizeIntegrationConnection({ userId: 'alice', workspaceId: 'project-workspace' }, ref, 'use')).access.canUse, true,
      'Existing workspace policy treats project write permission as read/run permission; shared connections must use the same authority.');
    assert.deepEqual((await store.authorizeIntegrationConnection(alice, ref, 'use')).allowedToolNames, ['create', 'read'], 'Matching grant bounds are unioned then intersected with the resource set.');
    await assert.rejects(() => store.authorizeIntegrationConnection(alice, ref, 'use', 'foreign_tool'), { code: 'CONNECTION_ACCESS_DENIED' });
    assert.equal((await store.inspectSharedIntegrationConnection({ userId: 'manager' }, ref)).access.canManage, true);
    await assert.rejects(() => store.authorizeIntegrationConnection({ userId: 'manager' }, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    assert.equal((await store.inspectSharedIntegrationConnection(alice, ref)).grants, undefined);
    assert(!(JSON.stringify(await store.listSharedIntegrationConnections(admin))).includes(backend.connectionId));
    const targets = await store.listSharedIntegrationConnectionTargets({ userId: 'manager' }, ref);
    assert(!targets.users.some(value => value.userId === 'foreign'));
    assert(!targets.workspaces.some(value => value.workspaceId === 'personal-alice'));
    await assert.rejects(() => store.listSharedIntegrationConnectionTargets(alice, ref), { code: 'CONNECTION_ACCESS_DENIED' });
    const choices = await store.listManageableSharedIntegrationScopes({ userId: 'team-manager' });
    assert.deepEqual(choices.map(value => value.ownership), [owner]);
    assert.deepEqual(await store.listManageableSharedIntegrationScopes(alice), []);
    await assert.rejects(() => store.createSharedIntegrationConnection({ userId: 'team-manager' }, { ownership: { type: 'organization', organizationId: 'org-a' }, displayName: 'No', backend: { source: 'mcp', connectionId: randomUUID() } }), { code: 'CONNECTION_MANAGEMENT_REQUIRED' });
    await assert.rejects(() => store.authorizeIntegrationConnection({ userId: 'foreign' }, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    await assert.rejects(() => store.authorizeIntegrationConnection({ ...alice, organizationId: 'org-b' }, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    await assert.rejects(() => store.authorizeIntegrationConnection({ ...alice, workspaceId: 'personal-foreign' }, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    const old = await expected();
    await mutate({ metadata: { description: 'a'.repeat(4096) } });
    const beforeInvalid = await expected();
    await assert.rejects(() => mutate({ metadata: { description: 'a'.repeat(4097) } }), { code: 'CONNECTION_REQUEST_INVALID' });
    assert.deepEqual(await expected(), beforeInvalid);
    await assert.rejects(() => store.mutateSharedIntegrationConnection(admin, ref, { expectedMetadataRevision: old.metadataRevision, expectedGrantsRevision: old.grantsRevision, expectedBindingRevision: old.bindingRevision, metadata: { displayName: 'stale' } }), { code: 'CONNECTION_REVISION_CONFLICT' });
    const current = await expected();
    await store.withAuthorizedIntegrationConnection(admin, ref, 'manage', current, async auth => {
      await store.publishIntegrationConnectionBinding(admin, ref, current, auth.backend);
    });
    const bound = await expected(); assert.equal(bound.bindingRevision, current.bindingRevision + 1);
    assert.equal(await store.getPublishedIntegrationConnectionBindingRevision(await store.authorizeIntegrationConnection(admin, ref, 'manage')), bound.bindingRevision);
    const require = createRequire(import.meta.url), modulePath = require.resolve('../app/lib/integration-tools/connections/store');
    const originalModule = require.cache[modulePath];
    delete require.cache[modulePath];
    try {
      const second = require(modulePath) as typeof store;
      assert.notEqual(second.isAuthorizedIntegrationConnection, store.isAuthorizedIntegrationConnection, 'Two actual server module instances are required.');
      const crossChunkProof = await store.authorizeIntegrationConnection(admin, ref, 'manage');
      assert.equal(second.isAuthorizedIntegrationConnection(crossChunkProof), true);
      assert.equal(second.isAuthorizedIntegrationConnection(structuredClone(crossChunkProof)), false);
      await store.withAuthorizedIntegrationConnection(admin, ref, 'manage', crossChunkProof.resource, async auth => {
        await second.publishIntegrationConnectionBinding(admin, ref, auth.resource, auth.backend);
      });
    } finally { if (originalModule) require.cache[modulePath] = originalModule; else delete require.cache[modulePath]; }
    const published = await expected();
    await mutate({ status: 'archived' }); await assert.rejects(() => store.authorizeIntegrationConnection(alice, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    await mutate({ status: 'active' });
    assert.equal(await store.getPublishedIntegrationConnectionBindingRevision(await store.authorizeIntegrationConnection(admin, ref, 'manage')), published.bindingRevision, 'Status revisions are not provider publication.');
    await assert.rejects(async () => store.publishIntegrationConnectionBinding(admin, ref, await expected(), { source: 'mcp', connectionId: randomUUID() }), { code: 'CONNECTION_BINDING_INVALID' });
    await mutate({ grants: [grant('manager', { canManage: true })] });
    const selfRevoke = await mutate({ grants: [] }, { userId: 'manager' });
    assert.deepEqual(selfRevoke.access, { canRead: false, canUse: false, canManage: false });
    await assert.rejects(() => store.inspectSharedIntegrationConnection({ userId: 'manager' }, ref), { code: 'CONNECTION_ACCESS_DENIED' });
    await mutate({ accessMode: 'inherit' });
    await assert.rejects(() => store.authorizeIntegrationConnection(alice, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    assert.equal((await store.authorizeIntegrationConnection({ userId: 'member' }, ref, 'use')).access.canUse, true);
    await assert.rejects(() => store.authorizeIntegrationConnection({ userId: 'external' }, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    await mutate({ grants: [grant('external', { canUse: true })] });
    assert.equal((await store.authorizeIntegrationConnection({ userId: 'external' }, ref, 'use')).access.canUse, true);
    await raw.run("UPDATE canvas_workspaces SET status='archived' WHERE id='team-a'");
    await assert.rejects(() => store.authorizeIntegrationConnection({ userId: 'external' }, ref, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    await raw.run("UPDATE canvas_workspaces SET status='active' WHERE id='team-a'");
    const creatorRecord = await store.createSharedIntegrationConnection({ userId: 'creator' }, { ownership: owner, displayName: 'Survives creator', backend: { source: 'mcp', connectionId: randomUUID() } });
    await raw.run("DELETE FROM canvas_workspaces WHERE id='personal-creator'");
    await raw.run("DELETE FROM organization_user_permissions WHERE user_id='creator'");
    await raw.run("DELETE FROM \"user\" WHERE id='creator'");
    assert.equal((await store.getIntegrationConnectionRecord(creatorRecord.resource.connectionRef))!.resource.createdByUserId, null);
    assert.equal((await store.inspectSharedIntegrationConnection(admin, creatorRecord.resource.connectionRef)).access.canManage, true);

    const endpoint = await import('../app/api/integrations/shared-connections/[connectionRef]/route');
    const params = { params: Promise.resolve({ connectionRef: ref }) };
    const request = (body: object) => new Request(`http://localhost:3000/api/integrations/shared-connections/${encodeURIComponent(ref)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    actorUserId = null; assert.equal((await endpoint.GET(new Request('http://localhost:3000/'), params)).status, 401);
    actorUserId = 'admin';
    const r = await expected(), publicRevisions = { expectedMetadataRevision: r.metadataRevision, expectedGrantsRevision: r.grantsRevision, expectedBindingRevision: r.bindingRevision };
    for (const injected of [{ userId: 'alice' }, { ownership: { type: 'organization' } }, { backend: { source: 'mcp', connectionId: 'foreign' } }, { providerMode: 'managed' }]) {
      assert.equal((await endpoint.PATCH(request({ ...publicRevisions, metadata: { displayName: 'injected' }, ...injected }), params)).status, 400);
    }
    actorUserId = 'alice'; assert.equal((await endpoint.PATCH(request({ ...publicRevisions, metadata: { displayName: 'denied' } }), params)).status, 403);
    actorUserId = 'admin'; const response = await endpoint.GET(new Request('http://localhost:3000/'), params);
    assert.equal(response.status, 200); assert(!JSON.stringify(await response.json()).includes(backend.connectionId));

    if (database.native) {
      const writer = await database.openDb();
      let inspection: Promise<unknown> | undefined;
      let write: Promise<unknown> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await writer.run('BEGIN');
        await writer.run("SET LOCAL statement_timeout='5s'");
        await writer.get('SELECT organization_id FROM canvas_organization_settings WHERE organization_id=$1 FOR UPDATE', ['org-a']);
        const identity = await writer.get('SELECT pg_backend_pid() AS pid') as { pid: number };
        inspection = store.inspectSharedIntegrationConnection(admin, ref);
        void inspection.catch(() => undefined);
        let blockedOrganization = false;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const state = await raw.get(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid() AND pid<>$1
              AND query LIKE '%canvas_organization_settings%' AND query LIKE '%FOR SHARE%'`, [identity.pid]) as { count: number };
          if (state.count > 0) { blockedOrganization = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert(blockedOrganization, 'Inspect must be observed waiting on the canonical organization lock before its user write starts.');
        write = (async () => {
          try {
            await writer.run('UPDATE "user" SET role=role WHERE id=$1', ['admin']);
            await writer.run('COMMIT');
          } catch (error) {
            await writer.run('ROLLBACK');
            throw error;
          }
        })();
        const settled = await Promise.race([
          Promise.allSettled([write, inspection]),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Canonical organization/user race exceeded its bounded wait.')), 8_000); }),
        ]);
        const codes = settled.filter(value => value.status === 'rejected').map(value => {
          const code = (value as PromiseRejectedResult).reason?.code;
          return typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code) ? code : 'unexpected_failure';
        });
        assert(settled.every(value => value.status === 'fulfilled'), `Canonical Org→User writer and connection inspection must both succeed; database codes: ${codes.join(',')}.`);
      } finally {
        if (timeout) clearTimeout(timeout);
        try { await writer.run('ROLLBACK'); } finally { await writer.close(); }
        await Promise.allSettled([...(write ? [write] : []), ...(inspection ? [inspection] : [])]);
      }
      const lock = await database.openDb();
      await lock.run('BEGIN'); await lock.get('SELECT connection_ref FROM integration_connection_resources WHERE connection_ref=$1 FOR UPDATE', [ref]);
      const start = await expected();
      const delayed = store.mutateSharedIntegrationConnection({ userId: 'team-manager' }, ref, { expectedMetadataRevision: start.metadataRevision, expectedGrantsRevision: start.grantsRevision, expectedBindingRevision: start.bindingRevision, metadata: { displayName: 'late unauthorized' } });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await raw.get("SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%integration_connection_resources%' AND pid<>pg_backend_pid()") as { count: number };
        if (state.count > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(waiting, 'The real mutation must be observed waiting on the resource lock before management is revoked.');
      await raw.run("UPDATE canvas_workspace_members SET can_manage=0 WHERE user_id='team-manager' AND workspace_id='team-a'");
      await lock.run('COMMIT'); await lock.close();
      await assert.rejects(() => delayed, { code: 'CONNECTION_ACCESS_DENIED' });
      assert.equal((await expected()).displayName, start.displayName);
      const snapshot = await expected();
      const updates = await Promise.allSettled(['first', 'second'].map(displayName => store.mutateSharedIntegrationConnection(admin, ref, {
        expectedMetadataRevision: snapshot.metadataRevision, expectedGrantsRevision: snapshot.grantsRevision, expectedBindingRevision: snapshot.bindingRevision, metadata: { displayName } })));
      assert.equal(updates.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(updates.filter(value => value.status === 'rejected' && value.reason.code === 'CONNECTION_REVISION_CONFLICT').length, 1);
    }
    console.log(`PASS common connection store/API (${database.native ? 'native PostgreSQL with row-lock races' : 'actual PostgreSQL engine'}): independent rights, immutable ownership/backend, bounds, exact CAS, current targets, self-revocation, committed publication, creator lifecycle and authenticated strict public boundary.`);
  } finally {
    await raw.close(); internals._load = original; await database.close();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
