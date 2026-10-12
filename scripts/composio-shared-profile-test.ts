import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { runPostgresMigrations } from '../app/lib/db/postgres';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-shared-profiles-'));
  const keys = ['DATA', 'CANVAS_DATA_ROOT', 'INTEGRATIONS_ENV_MASTER_KEY', 'CANVAS_INSTANCE_ID', 'BASE_URL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATA: root, CANVAS_DATA_ROOT: root, INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), CANVAS_INSTANCE_ID: 'profile-test-instance', BASE_URL: 'http://localhost:3000' });
  const database = await createPiTestDatabase();
  const raw = await database.openDb();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)
    ? database : original(name, parent, isMain);
  try {
    for (const id of ['owner', 'creator', 'manager', 'member', 'foreign']) await raw.run(
      'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@profiles.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org-profiles','owner','team',1,1000,1000)");
    for (const id of ['owner', 'creator', 'manager', 'member']) await raw.run(
      "INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-profiles',$1,$2,'active',0,1000,1000)",
      [id, id === 'owner' ? 'owner' : id === 'creator' ? 'admin' : 'member']);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-profiles','org-profiles','team','team-profiles','Profile team','active',1000,1000)");
    for (const id of ['owner', 'creator', 'manager', 'member']) await raw.run(
      "INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ('org-profiles','team-profiles',$1,'member','active',1,$2,1000,1000)", [id, Number(id === 'manager')]);
    const shared = await import('../app/lib/composio/composio-shared-profiles');
    const personal = await import('../app/lib/composio/composio-profiles');
    const actor = (userId: string) => ({ userId, workspaceId: 'team-profiles', organizationId: 'org-profiles' });
    const orgOwner = { type: 'organization' as const, organizationId: 'org-profiles' };
    const teamOwner = { type: 'team' as const, organizationId: 'org-profiles', workspaceId: 'team-profiles' };
    await assert.rejects(shared.createSharedComposioProfile({ actor: actor('member'), ownership: orgOwner, name: 'Denied', providerMode: 'local' }));
    const profile = await shared.createSharedComposioProfile({ actor: actor('creator'), ownership: orgOwner, name: 'Shared design', providerMode: 'local' });
    assert.equal(profile.ownerUserId, null);
    assert.equal(profile.createdByUserId, 'creator');
    assert.match(profile.composioUserId, /^canvas-notebook-profile-test-instance-profile-[a-f0-9-]+$/u);
    const teamProfile = await shared.createSharedComposioProfile({ actor: actor('manager'), ownership: teamOwner, name: 'Team design', providerMode: 'managed' });
    assert.equal(teamProfile.providerMode, 'managed');
    assert.equal((await shared.listSharedComposioProfiles(actor('manager'), teamOwner))[0].id, teamProfile.id);
    await assert.rejects(shared.inspectSharedComposioProfile(actor('member'), profile.id));
    await assert.rejects(shared.inspectSharedComposioProfile(actor('foreign'), profile.id));
    await assert.rejects(shared.createSharedComposioProfile({ actor: actor('creator'), ownership: { ...teamOwner, workspaceId: 'missing-team' }, name: 'Wrong team', providerMode: 'local' }));
    const own = await personal.ensureDefaultComposioProfile('creator');
    assert.equal((await personal.listComposioProfiles('creator')).length, 1);
    await assert.rejects(personal.resolveOwnedComposioProfileBinding({ userId: 'creator', workspaceId: 'team-profiles', profileId: profile.id }));
    await assert.rejects(personal.setComposioWorkspaceProfileOverride({ userId: 'creator', workspaceId: 'team-profiles', profileId: teamProfile.id }));
    await assert.rejects(raw.run("UPDATE composio_connection_profiles SET is_default = 1 WHERE id = $1", [profile.id]));
    await assert.rejects(raw.run("UPDATE composio_connection_profiles SET provider_mode = NULL WHERE id = $1", [profile.id]));
    await assert.rejects(raw.run("UPDATE composio_connection_profiles SET owner_user_id = 'creator' WHERE id = $1", [profile.id]));
    await assert.rejects(raw.run("UPDATE composio_connection_profiles SET scope_type = 'organization' WHERE id = $1", [own.id]));
    const providerId = profile.composioUserId;
    assert.equal((await shared.inspectSharedComposioProfile(actor('creator'), profile.id)).composioUserId, providerId);
    await raw.run('DELETE FROM canvas_workspace_members WHERE user_id = $1', ['creator']);
    await raw.run('DELETE FROM organization_user_permissions WHERE user_id = $1', ['creator']);
    await raw.run("DELETE FROM canvas_workspaces WHERE owner_user_id = $1 AND type = 'personal'", ['creator']);
    await raw.run('DELETE FROM "user" WHERE id = $1', ['creator']);
    const retained = await shared.inspectSharedComposioProfile(actor('owner'), profile.id);
    assert.equal(retained.createdByUserId, null); assert.equal(retained.updatedByUserId, null);
    assert.equal(retained.composioUserId, providerId);
    await runPostgresMigrations(database.getPostgresRuntimeQueryable() as unknown as Parameters<typeof runPostgresMigrations>[0]);
    assert.equal((await shared.inspectSharedComposioProfile(actor('owner'), profile.id)).createdByUserId, null);
    assert.equal(await raw.get('SELECT id FROM composio_connection_profiles WHERE id = $1', [own.id]), undefined);
    assert.equal((await shared.inspectSharedComposioProfile(actor('manager'), teamProfile.id)).ownerUserId, null);
    console.log('PASS shared Composio profile SQL constraints, creator lifecycle, scope management and unchanged personal defaults/overrides');
  } finally {
    loader._load = original;
    await database.close(); await fs.rm(root, { recursive: true, force: true });
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
