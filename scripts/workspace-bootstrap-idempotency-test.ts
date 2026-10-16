import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };

/** Normal bootstrap against real schema/actor rows. --native uses two real
 * PostgreSQL clients for the snapshot/bootstrap/FOR SHARE race; no authority,
 * bootstrap service, SQL statement, model or provider result is substituted. */
async function runWorkspaceBootstrapIdempotencyRegression(): Promise<void> {
  const maintenanceUrl = process.env.DATABASE_URL;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const databaseName = fixture.native ? String(row(await fixture.sql.get('SELECT current_database() AS name')).name) : '';
  let groups = 0;
  const sql = async <T>(callback: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await fixture.openObserverConnection();
    try { return await callback(database); } finally { await database.close(); }
  };
  try {
    const bootstrap = await import('../app/lib/workspaces/postgres-runtime');
    const { resolveVerifiedAgentActorContextOnConnection } = await import('../app/lib/agents/actor-context');
    const { getDeploymentMode, areTeamFeaturesEnabled } = await import('../app/lib/organization/config');
    const { personalWorkspaceRootRelativePath } = await import('../app/lib/workspaces/contracts');
    const { organizationId, owner, alice } = fixture;
    await fixture.releaseSetupConnection();
    const normalBootstrap = () => bootstrap.getPostgresWorkspaceState({ userId: alice.userId, role: 'member' });
    const repeatOwner = () => sql(async database => {
      await database.run('BEGIN');
      try { const value = await bootstrap.ensurePostgresOrganizationBootstrapForUser(database, owner.userId); await database.run('COMMIT'); return value; }
      catch (error) { await database.run('ROLLBACK'); throw error; }
    });
    const stamps = () => sql(async database => ({
      organization: row(await database.get('SELECT xmin::text AS row_version,updated_at FROM canvas_organization_settings WHERE organization_id=$1', [organizationId])),
      owner: row(await database.get('SELECT xmin::text AS row_version,updated_at FROM "user" WHERE id=$1', [owner.userId])),
      permission: row(await database.get('SELECT xmin::text AS row_version,updated_at FROM organization_user_permissions WHERE organization_id=$1 AND user_id=$2', [organizationId, owner.userId])),
      ownerWorkspace: row(await database.get("SELECT xmin::text AS row_version,updated_at FROM canvas_workspaces WHERE type='personal' AND owner_user_id=$1", [owner.userId])),
      targetWorkspace: row(await database.get("SELECT xmin::text AS row_version,updated_at FROM canvas_workspaces WHERE type='personal' AND owner_user_id=$1", [alice.userId])),
    }));
    const unchanged = async (label: string) => {
      const before = await stamps(); await normalBootstrap(); await repeatOwner(); const after = await stamps();
      const changed = Object.keys(before).filter(key => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(after[key as keyof typeof after]));
      assert.deepEqual(changed, [], `${label}: unchanged normal bootstrap must preserve actual row xmin and updated_at; changed=${changed.join(',')}`);
    };
    await normalBootstrap();
    await unchanged('Initial settled configuration'); groups++;

    // Correct actual deployment drift while leaving unrelated authority rows alone.
    await sql(database => database.run("UPDATE canvas_organization_settings SET deployment_mode='single_user',team_features_enabled=0,updated_at=1 WHERE organization_id=$1", [organizationId]));
    const modeBefore = await stamps();
    await normalBootstrap();
    const mode = await sql(async database => row(await database.get('SELECT deployment_mode,team_features_enabled,updated_at FROM canvas_organization_settings WHERE organization_id=$1', [organizationId])));
    assert.equal(mode.deployment_mode, getDeploymentMode()); assert.equal(Number(mode.team_features_enabled), Number(areTeamFeaturesEnabled()));
    assert.notDeepEqual((await stamps()).organization, modeBefore.organization); await unchanged('Repaired deployment mode/features'); groups++;

    await sql(database => database.run('UPDATE "user" SET role=$1,updated_at=1 WHERE id=$2', ['user', owner.userId]));
    const promoted = await repeatOwner(); assert.equal(promoted.ownerUserId, owner.userId);
    const actualOwner = await sql(async database => row(await database.get('SELECT role,updated_at FROM "user" WHERE id=$1', [owner.userId])));
    assert.equal(actualOwner.role, 'admin'); assert(Number(actualOwner.updated_at) > 1);
    await unchanged('Repaired owner admin role'); groups++;

    // Existing custom rights/status must survive role promotion and every no-op.
    await sql(database => database.run(`UPDATE organization_user_permissions SET role='member',can_write_team_workspace=0,
      can_create_public_links=0,can_create_team_automations=1,can_share_plugins_and_skills=0,can_export=1,
      can_delete_team_files=0,can_delete_studio_assets=0,can_manage_backups=1,can_manage_organization_memory=0,
      can_migrate_database=0,can_enable_knowledge=1,can_recover_workspaces=0,updated_at=1 WHERE organization_id=$1 AND user_id=$2`, [organizationId, owner.userId]));
    const permission = () => sql(async database => row(await database.get('SELECT * FROM organization_user_permissions WHERE organization_id=$1 AND user_id=$2', [organizationId, owner.userId])));
    const rightsBefore = await permission(); await normalBootstrap(); const rightsAfter = await permission();
    assert.equal(rightsAfter.role, 'owner'); assert(Number(rightsAfter.updated_at) > 1);
    const rights = (value: Row) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'role' && key !== 'updated_at'));
    assert.deepEqual(rights(rightsAfter), rights(rightsBefore), 'Owner promotion must preserve every existing custom right and status.');
    await unchanged('Custom rights after owner-role promotion'); groups++;

    // Repair only canonical root/default fields, preserving meaningful labels and appearance.
    const customLabel = 'My personally named workspace';
    await sql(database => database.run(`UPDATE canvas_workspaces SET root_relative_path=$1,display_name=$2,is_default=0,
      workspace_icon='rocket',workspace_color='blue',description='Custom description',updated_at=1 WHERE type='personal' AND owner_user_id=$3`,
    ['workspaces/personal/alice/repair-before-bootstrap/files', customLabel, alice.userId]));
    await normalBootstrap();
    const workspace = () => sql(async database => row(await database.get("SELECT * FROM canvas_workspaces WHERE type='personal' AND owner_user_id=$1", [alice.userId])));
    const repaired = await workspace();
    assert.equal(repaired.root_relative_path, personalWorkspaceRootRelativePath(alice.userId)); assert.equal(Number(repaired.is_default), 1);
    assert.equal(repaired.display_name, customLabel); assert.equal(repaired.workspace_icon, 'rocket'); assert.equal(repaired.workspace_color, 'blue'); assert.equal(repaired.description, 'Custom description');
    assert((await fs.stat(path.join(fixture.root, personalWorkspaceRootRelativePath(alice.userId)))).isDirectory());
    await unchanged('Repaired personal workspace with custom label/appearance'); groups++;
    await sql(database => database.run("UPDATE canvas_workspaces SET display_name='',updated_at=1 WHERE type='personal' AND owner_user_id=$1", [alice.userId]));
    await normalBootstrap(); assert.equal((await workspace()).display_name, 'Personal Workspace');
    await unchanged('Empty workspace label repaired'); groups++;

    await sql(database => database.run('DELETE FROM organization_user_permissions WHERE organization_id=$1 AND user_id=$2', [organizationId, owner.userId]));
    await normalBootstrap(); const recreatedPermission = await permission(); assert.equal(recreatedPermission.role, 'owner'); assert.equal(recreatedPermission.status, 'active');
    await sql(database => database.run("DELETE FROM canvas_workspaces WHERE type='personal' AND owner_user_id=$1", [alice.userId]));
    const recreated = await normalBootstrap(); assert(recreated.defaultWorkspace);
    assert.equal(recreated.defaultWorkspace.ownerUserId, alice.userId); assert.equal(recreated.defaultWorkspace.rootRelativePath, personalWorkspaceRootRelativePath(alice.userId));
    await unchanged('Missing permission/workspace rows recreated'); groups++;

    const canonicalDirectory = path.join(fixture.root, personalWorkspaceRootRelativePath(alice.userId));
    assert.deepEqual(await fs.readdir(canonicalDirectory), [], 'Directory repair removes only an empty fixture-owned personal directory.');
    await fs.rmdir(canonicalDirectory);
    const directoryBefore = await stamps();
    await normalBootstrap();
    assert((await fs.stat(canonicalDirectory)).isDirectory(), 'A no-op SQL bootstrap still repairs the missing canonical directory.');
    assert.deepEqual(await stamps(), directoryBefore, 'Directory repair must not rewrite any of the five settled authority rows.'); groups++;

    if (fixture.native) {
      const currentOwnerWorkspace = await sql(async database => row(await database.get(
        "SELECT id FROM canvas_workspaces WHERE type='personal' AND owner_user_id=$1 AND organization_id=$2 AND status='active'",
        [owner.userId, organizationId])));
      assert.equal(typeof currentOwnerWorkspace.id, 'string');
      const currentActors = [{ userId: owner.userId, workspaceId: String(currentOwnerWorkspace.id) },
        { userId: alice.userId, workspaceId: recreated.defaultWorkspace.workspaceId }];
      const before = await stamps(), reader = await fixture.openObserverConnection();
      try {
        await reader.run('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await reader.get('SELECT txid_current()::text AS transaction_id');
        // This is the real ordinary entry point on its own connection, not a
        // substitute UPDATE or a stubbed successful permission projection.
        await normalBootstrap();
        for (const user of currentActors) {
          const verified = await resolveVerifiedAgentActorContextOnConnection({ userId: user.userId, organizationId, workspaceId: user.workspaceId }, reader, { lock: true });
          assert.equal(verified.userId, user.userId); assert.equal(verified.context.workspaceId, user.workspaceId);
        }
        await reader.run('COMMIT');
      } catch (error) { await reader.run('ROLLBACK'); throw error; }
      finally { await reader.close(); }
      assert.deepEqual(await stamps(), before, 'Normal concurrent bootstrap must neither change authority tuples nor abort the existing SERIALIZABLE snapshot.'); groups++;

      const changedReader = await fixture.openObserverConnection();
      try {
        await changedReader.run('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await changedReader.get('SELECT txid_current()::text AS transaction_id');
        await sql(database => database.run('UPDATE "user" SET banned=1 WHERE id=$1', [owner.userId]));
        await assert.rejects(resolveVerifiedAgentActorContextOnConnection({ userId: owner.userId, organizationId,
          workspaceId: currentActors[0]!.workspaceId }, changedReader, { lock: true }), { code: '40001' },
        'An actual authority change after the snapshot must still abort its old locking read, without retry.');
        await changedReader.run('ROLLBACK');
        await assert.rejects(sql(database => resolveVerifiedAgentActorContextOnConnection({ userId: owner.userId, organizationId,
          workspaceId: currentActors[0]!.workspaceId }, database, { lock: true })), { code: 'AGENT_ACTOR_CONTEXT_DENIED' },
        'A fresh actor read must deny the actual banned owner, never retain earlier authority.'); groups++;
      } finally {
        // Restore only this fixture-owned authority row; no retry or admission
        // is performed while its result is uncertain or permission is revoked.
        await changedReader.run('ROLLBACK'); await changedReader.close();
        await sql(database => database.run('UPDATE "user" SET banned=0 WHERE id=$1', [owner.userId]));
      }
    }
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS ${groups} ${fixture.native ? 'native PostgreSQL' : 'PGlite'} workspace bootstrap idempotency groups: unchanged xmin/updated_at, real mode/features/owner/permission/workspace repair, custom rights/appearance preservation and missing rows.${fixture.native ? ' Actual SERIALIZABLE snapshot + concurrent normal bootstrap + real actor locking read COMMIT succeeded without retry; actual revocation still yields 40001 and fresh denial.' : ' Native concurrency is not claimed in PGlite mode.'}`);
  } finally {
    await fixture.close(); await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
    if (fixture.native) {
      assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
      const observer = new Pool({ connectionString: maintenanceUrl, max: 1 });
      try { assert.equal((await observer.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [databaseName])).rows[0].count, 0); }
      finally { await observer.end(); }
    }
  }
}

runWorkspaceBootstrapIdempotencyRegression().catch(error => { console.error(error); process.exitCode = 1; });
