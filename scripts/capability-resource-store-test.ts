import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../app/lib/db/schema';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { SqlConnection } from '../app/lib/db';
import type { CapabilityResourceStorageBinding, CapabilityResourceGrantInput } from '../app/lib/capabilities/resources/contracts';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function fixtureDatabase() {
  if (process.env.CANVAS_CAPABILITY_RESOURCE_POSTGRES_TEST !== '1') return { ...await createPiTestDatabase(), native: false };
  assert.equal(process.env.NODE_ENV, 'test');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55433');
  assert.match(url.pathname, /^\/canvas_editor_test_[a-f0-9]{16}$/u);
  assert.equal(url.search, '');
  assert.ok(process.env.DATA && path.isAbsolute(process.env.DATA));
  const data = await fs.realpath(process.env.DATA);
  assert.match(path.basename(data), /^canvas-yjs-pg-[A-Za-z0-9]{6}$/u);
  assert.equal((await fs.stat(data)).mode & 0o777, 0o700);
  const pool = new Pool({ connectionString: url.toString(), max: 8 });
  try {
    const identity = (await pool.query('SELECT current_database() AS name,current_user AS role,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0];
    assert.equal(identity.name, url.pathname.slice(1));
    assert.equal(identity.owner, identity.role);
    assert.equal(identity.role, decodeURIComponent(url.username));
    await runPostgresMigrations(pool as unknown as Parameters<typeof runPostgresMigrations>[0]);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM "user"')).rows[0].count, 0, 'A fresh disposable test database is required.');
  } catch (failure) { await pool.end(); throw failure; }
  return { native: true, db: drizzle(pool, { schema }), getDatabaseProvider: () => 'postgres',
    getPostgresRuntimeQueryable: () => pool, getDatabaseInitializationError: () => null, ensureDatabaseReady: async () => {}, assertDatabaseAvailable: () => {},
    openDb: async (): Promise<SqlConnection> => {
      const client = await pool.connect();
      return { get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
        all: async (sql, params = []) => (await client.query(sql, params)).rows,
        run: async (sql, params = []) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }), close: () => client.release() };
    }, close: () => pool.end() };
}

async function main() {
  process.env.BASE_URL ??= 'http://localhost:3001';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  const database = await fixtureDatabase();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, parent, mainModule) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    return originalLoad(name, parent, mainModule);
  };
  const raw = await database.openDb();
  const now = 1000;
  const no = { canRead: false, canUse: false, canEdit: false, canManage: false };
  const grant = (targetId: string, rights: Partial<CapabilityResourceGrantInput> = {}): CapabilityResourceGrantInput =>
    ({ targetType: 'user', targetId, canUse: false, canEdit: false, canManage: false, ...rights });
  const binding = (name: string, scopeType: 'user' | 'organization' = 'organization', extra: Partial<CapabilityResourceStorageBinding> = {}): CapabilityResourceStorageBinding =>
    ({ resourceType: 'skill', resourceId: `fixture:${scopeType}:${name}`, scopeType, name, sourceType: 'standalone',
      organizationId: scopeType === 'organization' ? 'org-a' : null, ownerUserId: scopeType === 'user' ? 'owner-a' : null, sourcePluginId: null, ...extra });
  try {
    for (const id of ['owner-a', 'owner-b', 'editor', 'manager', 'runner', 'team-member', 'outsider', 'disabled', 'banned', 'creator', 'no-share-admin']) {
      await raw.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',$3,$4,$4)',
        [id, `${id}@resource.example.test`, Number(id === 'banned'), now]);
    }
    for (const suffix of ['a', 'b']) {
      await raw.run('INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ($1,$2,\'team\',1,$3,$3)', [`org-${suffix}`, `owner-${suffix}`, now]);
    }
    for (const id of ['owner-a', 'editor', 'manager', 'runner', 'team-member', 'disabled', 'banned', 'creator', 'no-share-admin']) {
      const role = id === 'owner-a' ? 'owner' : ['creator', 'no-share-admin'].includes(id) ? 'admin' : 'member';
      await raw.run(`INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at)
        VALUES ('org-a',$1,$2,$3,$4,$5,$5)`, [id, role, id === 'disabled' ? 'disabled' : 'active', Number(['owner-a', 'creator'].includes(id)), now]);
    }
    for (const id of ['owner-b', 'outsider']) await raw.run(`INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at)
      VALUES ('org-b',$1,$2,'active',$3,$3)`, [id, id === 'owner-b' ? 'owner' : 'member', now]);
    for (const [id, org, type, owner] of [['team-a', 'org-a', 'team', null], ['team-b', 'org-b', 'team', null], ['personal-a', 'org-a', 'personal', 'owner-a']]) {
      await raw.run(`INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$1,$1,'active',$5,$5)`, [id, org, type, owner, now]);
    }
    for (const id of ['manager', 'team-member']) await raw.run(`INSERT INTO canvas_workspace_members
      (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ('org-a','team-a',$1,'member','active',1,$2,$3,$3)`, [id, Number(id === 'manager'), now]);
    await raw.run(`INSERT INTO canvas_projects (id,organization_id,name,slug,status,created_at,updated_at) VALUES ('project-a','org-a','Project A','project-a','active',$1,$1)`, [now]);
    const service = await import('../app/lib/capabilities/resources/store');

    // Unmanaged baseline preserves current scope behavior without adopting on read.
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner' }, binding('baseline'))).access,
      { canRead: true, canUse: true, canEdit: false, canManage: false });
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'outsider' }, binding('baseline'))).access, no);
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'owner-a' }, binding('personal', 'user'))).access,
      { canRead: true, canUse: true, canEdit: true, canManage: true });
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'no-share-admin' }, binding('baseline'))).access,
      { canRead: true, canUse: true, canEdit: false, canManage: false });
    assert.equal((await raw.all('SELECT * FROM capability_resources')).length, 0);
    await assert.rejects(service.adoptCapabilityResource({ userId: 'runner' }, binding('unapproved'), { expectedMetadataRevision: 0, expectedGrantsRevision: 0 }), /management permission/);
    await assert.rejects(service.adoptCapabilityResource({ userId: 'owner-a' }, binding('core', 'user', { sourceType: 'core' }), { expectedMetadataRevision: 0, expectedGrantsRevision: 0 }), /parent plugin/);

    const resource = binding('independent');
    const unmanagedTargets = await service.listCapabilityResourceGrantTargets({ userId: 'owner-a' }, resource.resourceId, resource);
    assert(unmanagedTargets.users.some((target) => target.userId === 'runner'));
    assert.equal((await raw.all('SELECT * FROM capability_resources')).length, 0, 'Target selection never implicitly adopts.');
    const adopted = await service.adoptCapabilityResource({ userId: 'owner-a' }, resource, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted', metadata: { displayName: 'Shared skill', responsibleUserId: 'runner' },
      grants: [grant('editor', { canEdit: true }), grant('manager', { canManage: true }), grant('runner', { canUse: true })],
    });
    assert.match(adopted.metadata.resourceRef, /^canvas-resource:[a-f0-9-]{36}$/u);
    assert.deepEqual(adopted.access, { canRead: true, canUse: false, canEdit: true, canManage: true }, 'Admin management is not implicit runtime use.');
    assert.equal(adopted.metadata.metadataRevision, 1);
    assert.equal(adopted.metadata.grantsRevision, 1);
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'editor' }, resource)).access, { canRead: true, canUse: false, canEdit: true, canManage: false });
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'manager' }, resource)).access, { canRead: true, canUse: false, canEdit: false, canManage: true });
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner' }, resource)).access, { canRead: true, canUse: true, canEdit: false, canManage: false });
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'team-member' }, resource)).access, no);
    assert.equal((await service.listCapabilityResourceRecordsForActor({ userId: 'outsider' })).length, 0);
    assert.equal((await service.listCapabilityResourceRecordsForActor({ userId: 'editor' })).length, 1);
    assert.equal((await service.findCapabilityResourceRecord(resource.resourceId))?.metadata.resourceRef, adopted.metadata.resourceRef);
    const targets = await service.listCapabilityResourceGrantTargets({ userId: 'manager' }, adopted.metadata.resourceRef);
    assert(targets.users.some((candidate) => candidate.userId === 'editor'));
    assert(!targets.users.some((candidate) => ['outsider', 'banned', 'disabled'].includes(candidate.userId)));
    assert(!targets.workspaces.some((candidate) => candidate.workspaceId === 'team-b'));
    await assert.rejects(service.listCapabilityResourceGrantTargets({ userId: 'editor' }, adopted.metadata.resourceRef), /management permission/);
    await assert.rejects(service.listCapabilityResourceGrants({ userId: 'runner' }, adopted.metadata.resourceRef), /management permission/);

    const edited = await service.mutateCapabilityResource({ userId: 'editor' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { description: 'Updated by editor' } });
    assert.equal(edited.metadata.metadataRevision, 2);
    assert.equal(edited.metadata.grantsRevision, 1);
    const beforeResponsibleDenial = await raw.get('SELECT * FROM capability_resources WHERE resource_ref=$1', [adopted.metadata.resourceRef]);
    const historyBeforeResponsibleDenial = await raw.all('SELECT * FROM capability_resource_history WHERE resource_ref=$1 ORDER BY id', [adopted.metadata.resourceRef]);
    for (const responsibleUserId of ['editor', null]) {
      await assert.rejects(service.mutateCapabilityResource({ userId: 'editor' }, adopted.metadata.resourceRef,
        { expectedMetadataRevision: 2, expectedGrantsRevision: 1, metadata: { responsibleUserId } }), /mutation permission/);
      assert.deepEqual(await raw.get('SELECT * FROM capability_resources WHERE resource_ref=$1', [adopted.metadata.resourceRef]), beforeResponsibleDenial);
      assert.deepEqual(await raw.all('SELECT * FROM capability_resource_history WHERE resource_ref=$1 ORDER BY id', [adopted.metadata.resourceRef]), historyBeforeResponsibleDenial);
    }
    await assert.rejects(service.mutateCapabilityResource({ userId: 'manager' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 2, expectedGrantsRevision: 1, metadata: { description: 'Manager cannot edit' } }), /mutation permission/);
    await assert.rejects(service.mutateCapabilityResource({ userId: 'editor' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 2, expectedGrantsRevision: 1, grants: [] }), /mutation permission/);
    await assert.rejects(service.mutateCapabilityResource({ userId: 'owner-a' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { description: 'stale' } }), /changed/);
    const audience = await service.mutateCapabilityResource({ userId: 'manager' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 2, expectedGrantsRevision: 1, grants: [grant('runner', { canUse: true })] });
    assert.equal(audience.metadata.metadataRevision, 2);
    assert.equal(audience.metadata.grantsRevision, 2);
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'editor' }, resource)).access, no);
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'manager' }, resource)).access, no, 'Self-removal is effective immediately.');
    for (const target of ['outsider', 'disabled', 'banned', 'missing-user']) {
      await assert.rejects(service.mutateCapabilityResource({ userId: 'owner-a' }, adopted.metadata.resourceRef,
        { expectedMetadataRevision: 2, expectedGrantsRevision: 2, metadata: { description: 'must rollback' }, grants: [grant(target, { canUse: true })] }), /not active/);
    }
    await assert.rejects(service.mutateCapabilityResource({ userId: 'owner-a' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 2, expectedGrantsRevision: 2, grants: [grant('team-b', { targetType: 'workspace', canUse: true })] }), /not active/);
    await assert.rejects(service.getCapabilityResourceAccess({ userId: 'owner-a' }, { ...resource, ownerUserId: 'runner', scopeType: 'user', organizationId: null }), /binding changed/);
    await assert.rejects(service.mutateCapabilityResource({ userId: 'owner-a' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 2, expectedGrantsRevision: 2, ownership: { type: 'user', ownerUserId: 'runner' } } as never), /unsupported fields/);
    assert.equal((await service.findCapabilityResourceRecord(resource.resourceId))?.metadata.metadataRevision, 2);
    const responsibility = binding('responsibility-management');
    const responsibleEntry = await service.adoptCapabilityResource({ userId: 'owner-a' }, responsibility, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      accessMode: 'restricted', grants: [grant('manager', { canManage: true })] });
    const assigned = await service.mutateCapabilityResource({ userId: 'manager' }, responsibleEntry.metadata.resourceRef,
      { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { responsibleUserId: 'editor' } });
    assert.equal(assigned.metadata.responsibleUserId, 'editor', 'Managing grants allows responsible assignment without granting content edit or runtime use.');
    assert.equal(assigned.metadata.metadataRevision, 2);
    assert.equal(assigned.metadata.grantsRevision, 1);
    assert.deepEqual(assigned.access, { canRead: true, canUse: false, canEdit: false, canManage: true });

    // A failure after both writes rolls back metadata, audience and durable history together.
    await raw.run(`CREATE FUNCTION resource_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture atomic failure'; END $$`);
    await raw.run('CREATE TRIGGER resource_history_failure BEFORE INSERT ON capability_resource_history FOR EACH ROW EXECUTE FUNCTION resource_history_failure()');
    const before = await raw.get('SELECT * FROM capability_resources WHERE resource_ref=$1', [adopted.metadata.resourceRef]);
    const grantsBefore = await service.listCapabilityResourceGrants({ userId: 'owner-a' }, adopted.metadata.resourceRef);
    await assert.rejects(service.mutateCapabilityResource({ userId: 'owner-a' }, adopted.metadata.resourceRef,
      { expectedMetadataRevision: 2, expectedGrantsRevision: 2, metadata: { displayName: 'rollback' }, grants: [] }), /fixture atomic failure/);
    assert.deepEqual(await raw.get('SELECT * FROM capability_resources WHERE resource_ref=$1', [adopted.metadata.resourceRef]), before);
    assert.deepEqual(await service.listCapabilityResourceGrants({ userId: 'owner-a' }, adopted.metadata.resourceRef), grantsBefore);
    await raw.run('DROP TRIGGER resource_history_failure ON capability_resource_history');
    await raw.run('DROP FUNCTION resource_history_failure()');

    const teamResource = binding('team-owned');
    await assert.rejects(service.adoptCapabilityResource({ userId: 'no-share-admin' }, teamResource, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'team', organizationId: 'org-a', workspaceId: 'team-a' } }), /management permission/, 'Admin without sharing authority cannot gain team-wide management through the workspace admin shortcut.');
    const teamEntry = await service.adoptCapabilityResource({ userId: 'manager', workspaceId: 'team-a' }, teamResource, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'team', organizationId: 'org-a', workspaceId: 'team-a' }, accessMode: 'restricted', grants: [grant('runner', { canUse: true })] });
    const opaqueTargets = await service.listCapabilityResourceGrantTargets({ userId: 'manager' }, teamEntry.metadata.resourceRef, teamResource);
    const legacyTargets = await service.listCapabilityResourceGrantTargets({ userId: 'manager' }, teamResource.resourceId, teamResource);
    assert.deepEqual(opaqueTargets, legacyTargets, 'Both managed references accept the canonical binding passed by API/agent actions.');
    assert(opaqueTargets.users.some((target) => target.userId === 'runner'));
    await assert.rejects(service.listCapabilityResourceGrantTargets({ userId: 'manager' }, teamEntry.metadata.resourceRef,
      { ...teamResource, name: 'foreign-binding' }), /binding changed/);
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'runner' }, teamResource)).access.canUse, true, 'An explicit same-org user can be outside the owning team.');
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'team-member' }, teamResource)).access.canUse, false);
    const teamInherited = binding('team-inherit');
    await service.adoptCapabilityResource({ userId: 'manager' }, teamInherited, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      ownership: { type: 'team', organizationId: 'org-a', workspaceId: 'team-a' } });
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'team-member' }, teamInherited)).access.canUse, true);
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'runner' }, teamInherited)).access.canUse, false);
    const scopedGrants = binding('scoped-grants');
    await service.adoptCapabilityResource({ userId: 'owner-a' }, scopedGrants, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      accessMode: 'restricted', grants: [grant('team-a', { targetType: 'workspace', canUse: true })] });
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'team-member', workspaceId: 'team-a' }, scopedGrants)).access.canUse, true);
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner', workspaceId: 'team-a' }, scopedGrants)).access, no, 'Unvalidated requested team IDs never grant access.');
    const roleResource = binding('role-grants');
    await service.adoptCapabilityResource({ userId: 'owner-a' }, roleResource, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      accessMode: 'restricted', grants: [grant('member', { targetType: 'role', canUse: true })] });
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'runner' }, roleResource)).access.canUse, true);
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'no-share-admin' }, roleResource)).access.canUse, false);
    await raw.run("UPDATE canvas_workspace_members SET can_manage=0 WHERE workspace_id='team-a' AND user_id='manager'");
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'manager' }, teamResource)).access.canManage, false);
    await raw.run("UPDATE canvas_workspaces SET status='disabled' WHERE id='team-a'");
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner' }, teamResource)).access, no);
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner', workspaceId: 'team-b' }, resource)).access, no);
    await raw.run("UPDATE \"user\" SET banned=1 WHERE id='runner'");
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner' }, resource)).access, no);
    await raw.run("UPDATE \"user\" SET banned=0 WHERE id='runner'");
    await raw.run("UPDATE organization_user_permissions SET status='archived' WHERE user_id='runner'");
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner' }, resource)).access, no);
    await raw.run("UPDATE organization_user_permissions SET status='active' WHERE user_id='runner'");

    const privatePersonal = binding('member-private', 'user', { ownerUserId: 'editor' });
    const privateEntry = await service.adoptCapabilityResource({ userId: 'editor' }, privatePersonal,
      { expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'user', ownerUserId: 'editor', organizationId: 'org-a' }, grants: [] });
    assert.deepEqual(privateEntry.access, { canRead: true, canUse: true, canEdit: true, canManage: true });
    for (const userId of ['owner-a', 'creator']) {
      assert.deepEqual((await service.getCapabilityResourceAccess({ userId }, privatePersonal)).access, no,
        'An organization owner/admin has no automatic rights to an adopted personal resource.');
      assert(!(await service.listCapabilityResourceRecordsForActor({ userId })).some((entry) => entry.metadata.resourceRef === privateEntry.metadata.resourceRef));
      await assert.rejects(service.listCapabilityResourceGrants({ userId }, privateEntry.metadata.resourceRef), /management permission/);
    }
    const personallyManaged = await service.mutateCapabilityResource({ userId: 'editor' }, privateEntry.metadata.resourceRef,
      { expectedMetadataRevision: 1, expectedGrantsRevision: 1, grants: [grant('owner-a', { canManage: true })] });
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'owner-a' }, privatePersonal)).access,
      { canRead: true, canUse: false, canEdit: false, canManage: true }, 'Explicit personal management grants do not imply use or content edit.');
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'creator' }, privatePersonal)).access, no);
    const personallyRevoked = await service.mutateCapabilityResource({ userId: 'owner-a' }, privateEntry.metadata.resourceRef,
      { expectedMetadataRevision: personallyManaged.metadata.metadataRevision, expectedGrantsRevision: personallyManaged.metadata.grantsRevision, grants: [] });
    assert.equal(personallyRevoked.metadata.grantsRevision, 3);
    assert.deepEqual(personallyRevoked.access, no, 'Revoking the explicit grant removes all personal resource rights immediately.');
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'editor' }, privatePersonal)).access, privateEntry.access);

    const created = await service.adoptCapabilityResource({ userId: 'creator' }, binding('creator-lifecycle'), { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      metadata: { responsibleUserId: 'creator' }, grants: [grant('creator', { canUse: true })] });
    const creatorPersonal = await service.adoptCapabilityResource({ userId: 'creator' }, binding('creator-personal', 'user', { ownerUserId: 'creator' }),
      { expectedMetadataRevision: 0, expectedGrantsRevision: 0 });
    await raw.run("DELETE FROM organization_user_permissions WHERE user_id='creator'");
    await raw.run("DELETE FROM \"user\" WHERE id='creator'");
    const survives = await service.findCapabilityResourceRecord(created.metadata.resourceRef);
    assert.equal(survives?.metadata.ownership.type, 'organization');
    assert.equal(survives?.metadata.createdByUserId, null);
    assert.equal(survives?.metadata.updatedByUserId, null);
    assert.equal(survives?.metadata.responsibleUserId, null);
    assert.equal((await service.listCapabilityResourceGrants({ userId: 'owner-a' }, created.metadata.resourceRef)).length, 0);
    assert.equal(await service.findCapabilityResourceRecord(creatorPersonal.metadata.resourceRef), null, 'Personal owner deletion cascades its metadata without deleting organization-owned resources.');

    // A personal owner's ban blocks existing shared recipients without copying the artifact.
    const personal = binding('shared-personal', 'user');
    const personalEntry = await service.adoptCapabilityResource({ userId: 'owner-a' }, personal, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
      accessMode: 'restricted', grants: [grant('runner', { canUse: true })] });
    assert.deepEqual(personalEntry.metadata.ownership, { type: 'user', ownerUserId: 'owner-a', organizationId: 'org-a' });
    assert.equal((await service.getCapabilityResourceAccess({ userId: 'runner' }, personal)).access.canUse, true);
    await raw.run("UPDATE \"user\" SET banned=1 WHERE id='owner-a'");
    assert.deepEqual((await service.getCapabilityResourceAccess({ userId: 'runner' }, personal)).access, no);
    await raw.run("UPDATE \"user\" SET banned=0 WHERE id='owner-a'");

    const maximumDescription = 'd'.repeat(4096);
    const descriptionEntry = await service.adoptCapabilityResource({ userId: 'owner-a' }, binding('description-limit'),
      { expectedMetadataRevision: 0, expectedGrantsRevision: 0, metadata: { description: maximumDescription } });
    assert.equal(descriptionEntry.metadata.description, maximumDescription);
    const descriptionHistory = await raw.all('SELECT * FROM capability_resource_history WHERE resource_ref=$1 ORDER BY id', [descriptionEntry.metadata.resourceRef]);
    await assert.rejects(service.mutateCapabilityResource({ userId: 'owner-a' }, descriptionEntry.metadata.resourceRef,
      { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { description: `${maximumDescription}d` } }), /Description is invalid/);
    assert.deepEqual((await service.findCapabilityResourceRecord(descriptionEntry.metadata.resourceRef))?.metadata, descriptionEntry.metadata);
    assert.deepEqual(await raw.all('SELECT * FROM capability_resource_history WHERE resource_ref=$1 ORDER BY id', [descriptionEntry.metadata.resourceRef]), descriptionHistory);

    if (database.native) {
      const concurrent = binding('concurrent');
      const results = await Promise.allSettled([1, 2].map(() => service.adoptCapabilityResource({ userId: 'owner-a' }, concurrent,
        { expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted', grants: [] })));
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const item = (await service.findCapabilityResourceRecord(concurrent.resourceId))!;
      const edits = await Promise.allSettled([1, 2].map((index) => service.mutateCapabilityResource({ userId: 'owner-a' }, item.metadata.resourceRef,
        { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { description: `concurrent-${index}` } })));
      assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(edits.filter((result) => result.status === 'rejected').length, 1);
      assert.equal((await service.findCapabilityResourceRecord(concurrent.resourceId))?.metadata.metadataRevision, 2);
      // Target membership can be revoked after the request starts. The row lock
      // waits for the winning revocation and rechecks eligibility before writing.
      const revocation = await database.openDb();
      try {
        await revocation.run('BEGIN');
        await revocation.run("UPDATE organization_user_permissions SET status='archived' WHERE organization_id='org-a' AND user_id='runner'");
        const pending = service.mutateCapabilityResource({ userId: 'owner-a' }, item.metadata.resourceRef,
          { expectedMetadataRevision: 2, expectedGrantsRevision: 1, grants: [grant('runner', { canUse: true })] })
          .then((value) => ({ value, failure: undefined }), (failure: unknown) => ({ value: undefined, failure }));
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = await raw.get(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF u, p%'`) as { count: number };
          if (state.count > 0) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert(waiting, 'The mutation must wait on the target membership row, not write from a stale eligibility snapshot.');
        await revocation.run('COMMIT');
        const denied = await pending;
        assert.equal(denied.value, undefined);
        assert.match(String(denied.failure), /not active/);
        assert.equal((await service.findCapabilityResourceRecord(concurrent.resourceId))?.metadata.grantsRevision, 1);
      } finally { await revocation.run('ROLLBACK'); await revocation.close(); }
    }
    console.log(`PASS capability resource store (${database.native ? 'native PostgreSQL concurrent transactions' : 'PGlite full reflected PostgreSQL schema'}): independent rights, exact actor/scope/targets, atomic revisions/grants/history, revocations, lifecycle`);
  } finally {
    loader._load = originalLoad;
    await raw.close();
    await database.close();
  }
}

void main().catch((failure) => { console.error(failure); process.exitCode = 1; });
