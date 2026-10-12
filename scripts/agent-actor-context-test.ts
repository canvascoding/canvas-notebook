import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-agent-actor-'));
  const previousData = process.env.DATA;
  process.env.DATA = root;
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    return originalLoad(name, parent, isMain);
  };
  try {
    const db = await database.openDb();
    for (const id of ['owner', 'alice', 'bob', 'external', 'banned', 'inactive', 'unattached']) {
      await db.run('INSERT INTO "user" (id,name,email,role,email_verified,banned,created_at,updated_at) VALUES ($1,$1,$2,$3,1,$4,1,1)',
        [id, `${id}@example.test`, id === 'alice' ? 'admin' : 'member', id === 'banned' ? 1 : 0]);
    }
    await db.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('actor-org','owner','team',1,1,1),('foreign-org','owner','team',1,2,2)");
    for (const id of ['owner', 'alice', 'bob', 'external', 'banned', 'inactive']) {
      await db.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('actor-org',$1,$2,$3,1,1)",
        [id, id === 'owner' ? 'owner' : id === 'external' ? 'external' : 'member', id === 'inactive' ? 'archived' : 'active']);
    }
    await db.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('foreign-org','alice','member','active',1,1)");
    for (const id of ['alice-private', 'bob-private', 'external-private', 'team-a', 'team-b', 'archived-team', 'foreign-team']) {
      await db.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$1,$6,1,1)",
        [id, id === 'foreign-team' ? 'foreign-org' : 'actor-org', id.endsWith('private') ? 'personal' : 'team',
          id === 'alice-private' ? 'alice' : id === 'bob-private' ? 'bob' : id === 'external-private' ? 'external' : null,
          `workspaces/${id}/files`, id === 'archived-team' ? 'archived' : 'active']);
    }
    for (const [workspace, userId, canRead] of [['team-a', 'alice', 1], ['team-b', 'bob', 1], ['team-b', 'alice', 0], ['foreign-team', 'alice', 1]]) {
      await db.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,0,0,1,1)",
        [workspace === 'foreign-team' ? 'foreign-org' : 'actor-org', workspace, userId, canRead]);
    }
    for (const id of ['project-only', 'project-hidden', 'project-archived', 'project-workspace']) {
      await db.run("INSERT INTO canvas_projects (id,organization_id,name,slug,status,created_at,updated_at) VALUES ($1,'actor-org',$1,$1,$2,1,1)",
        [id, id === 'project-archived' ? 'archived' : 'active']);
    }
    for (const [project, id, canRead] of [['project-only', 'alice', 1], ['project-only', 'external', 1], ['project-hidden', 'alice', 0],
      ['project-archived', 'alice', 1], ['project-workspace', 'alice', 1]]) {
      await db.run("INSERT INTO canvas_project_members (organization_id,project_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('actor-org',$1,$2,$3,'active',$4,1,0,1,1)",
        [project, id, id === 'external' ? 'external' : 'member', canRead]);
    }
    await db.run("INSERT INTO canvas_workspaces (id,organization_id,type,project_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ('project-ws','actor-org','project','project-workspace','workspaces/project/files','Project','active',1,1)");
    const { resolveVerifiedAgentActorContextOnConnection: resolve, AgentActorContextError, isAgentActorContextError } = await import('../app/lib/agents/actor-context');
    const error = new AgentActorContextError();
    assert.equal(isAgentActorContextError(error), true);
    assert.equal(isAgentActorContextError(JSON.parse(JSON.stringify(error))), false);
    const otherModuleError = Object.assign(new Error(error.message), { code: error.code, status: 403 });
    Object.defineProperty(otherModuleError, Symbol.for('canvas.agent.actor-context-error.v1'), { value: true });
    assert.equal(isAgentActorContextError(otherModuleError), true);
    const denied = (input: Parameters<typeof resolve>[0]) => assert.rejects(resolve(input, db), error =>
      error instanceof AgentActorContextError && error.status === 403 && error.code === 'AGENT_ACTOR_CONTEXT_DENIED');
    const legacy = await resolve({ userId: 'alice' }, db);
    assert.deepEqual(legacy.context, {});
    assert.equal(legacy.organizationId, 'actor-org');
    assert.equal(legacy.organizationRole, 'member', 'Fresh organization role overrides stale user.role=admin.');
    assert.equal(legacy.workspacePermissions, null);
    const own = await resolve({ userId: 'alice', workspaceId: 'alice-private' }, db);
    assert.deepEqual(own.context, { organizationId: 'actor-org', workspaceId: 'alice-private', projectId: null });
    assert.equal(own.workspacePermissions?.canRead, true);
    assert.equal(own.workspacePermissions?.canRunAgent, true);
    const team = await resolve({ userId: 'alice', organizationId: 'actor-org', workspaceId: 'team-a' }, db);
    assert.equal(team.workspacePermissions?.canRead, true);
    assert.equal(team.workspacePermissions?.canManageWorkspace, false);
    await denied({ userId: 'alice', workspaceId: 'bob-private' });
    await denied({ userId: 'alice', workspaceId: 'team-b' });
    await denied({ userId: 'alice', workspaceId: 'foreign-team' });
    await denied({ userId: 'alice', workspaceId: 'archived-team' });
    await denied({ userId: 'alice', workspaceId: 'team-a', organizationId: 'foreign-org' });
    await denied({ userId: 'alice', workspaceId: 'team-a', projectId: 'project-only' });
    await denied({ userId: 'alice', workspaceId: 'missing' });
    await denied({ userId: 'banned' });
    await denied({ userId: 'inactive' });
    await denied({ userId: 'unattached' });
    await denied({ userId: 'missing' });
    await denied({ userId: 'alice', organizationId: '' });
    await denied({ userId: 'alice', workspaceId: ' team-a' });
    await denied({ userId: 'external', workspaceId: 'team-a' });
    const externalPersonal = await resolve({ userId: 'external', workspaceId: 'external-private' }, db);
    assert.equal(externalPersonal.organizationRole, 'external');
    assert.equal(externalPersonal.workspacePermissions?.canRead, true);
    assert.equal(externalPersonal.workspacePermissions?.canRunAgent, true);
    await denied({ userId: 'external', workspaceId: 'bob-private' });
    await db.run('UPDATE "user" SET role=\'external\' WHERE id=\'external\'');
    await denied({ userId: 'external', workspaceId: 'external-private' });
    await db.run('UPDATE "user" SET role=\'member\' WHERE id=\'external\'');
    assert.equal((await resolve({ userId: 'external', workspaceId: 'external-private' }, db)).workspacePermissions?.canRead, true);
    const projectOnly = await resolve({ userId: 'alice', projectId: 'project-only' }, db);
    assert.equal(projectOnly.context.workspaceId, undefined, 'A project-only request does not invent a workspace.');
    assert.deepEqual(projectOnly.context, { organizationId: 'actor-org', projectId: 'project-only' });
    assert.equal(projectOnly.workspacePermissions?.canRead, true);
    assert.equal((await resolve({ userId: 'external', projectId: 'project-only' }, db)).workspacePermissions?.canRead, true);
    await denied({ userId: 'alice', projectId: 'project-hidden' });
    await denied({ userId: 'bob', projectId: 'project-only' });
    await denied({ userId: 'alice', projectId: 'project-archived' });
    assert.equal((await resolve({ userId: 'owner', projectId: 'project-hidden' }, db)).workspacePermissions?.canRead, true);
    assert.deepEqual((await resolve({ userId: 'alice', workspaceId: 'project-ws' }, db)).context,
      { organizationId: 'actor-org', workspaceId: 'project-ws', projectId: 'project-workspace' });
    await denied({ userId: 'alice', workspaceId: 'project-ws', projectId: 'project-only' });
    await db.run("UPDATE canvas_projects SET status='archived' WHERE id='project-workspace'");
    await denied({ userId: 'alice', workspaceId: 'project-ws' });
    await db.run("UPDATE canvas_projects SET status='active' WHERE id='project-workspace'");
    await db.run("UPDATE canvas_workspace_members SET status='archived' WHERE workspace_id='team-a' AND user_id='alice'");
    await denied({ userId: 'alice', workspaceId: 'team-a' });
    await db.run("UPDATE canvas_workspace_members SET status='active' WHERE workspace_id='team-a' AND user_id='alice'");
    await db.run("UPDATE canvas_project_members SET status='archived' WHERE project_id='project-only' AND user_id='alice'");
    await denied({ userId: 'alice', projectId: 'project-only' });

    const statements: string[] = [];
    const traced = { get: async (sql: string, params?: unknown[]) => { statements.push(sql); return db.get(sql, params); },
      all: async (sql: string, params?: unknown[]) => { statements.push(sql); return db.all(sql, params); } };
    await db.run('BEGIN');
    try {
      const locked = await resolve({ userId: 'alice', workspaceId: 'team-a' }, traced, { lock: true });
      assert.equal(locked.workspacePermissions?.canRead, true);
      const locks = statements.filter(sql => sql.includes('FOR SHARE'));
      assert.match(locks[0], /canvas_organization_settings/);
      assert(locks.findIndex(sql => sql.includes('FROM "user"')) > 0);
      assert(locks.findIndex(sql => sql.includes('organization_user_permissions')) > locks.findIndex(sql => sql.includes('FROM "user"')));
      assert(locks.some(sql => sql.includes('canvas_workspaces')));
      assert(locks.some(sql => sql.includes('canvas_workspace_members')));
      assert(!statements.some(sql => /^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)));
      await db.run('COMMIT');
    } catch (error) { await db.run('ROLLBACK'); throw error; }

    let release!: () => void;
    const wait = new Promise<void>(resolveWait => { release = resolveWait; });
    let first = true;
    const gated = { get: async (sql: string, params?: unknown[]) => { if (first) { first = false; await wait; } return db.get(sql, params); }, all: db.all };
    const mutable = { userId: 'alice', workspaceId: 'alice-private' };
    const captured = resolve(mutable, gated);
    mutable.userId = 'bob'; mutable.workspaceId = 'bob-private';
    release();
    assert.equal((await captured).context.workspaceId, 'alice-private');
    assert.equal((await resolve({ userId: 'alice', organizationId: 'actor-org' }, db)).context.workspaceId, undefined);
    // The helper is a read-only resolver, not organization bootstrap. Unconfigured
    // legacy global access keeps its missing scope instead of creating a default.
    await db.run('DELETE FROM canvas_organization_settings');
    const unconfigured = await resolve({ userId: 'alice' }, db);
    assert.deepEqual(unconfigured.context, {});
    assert.equal(unconfigured.organizationId, null);
    assert.equal(unconfigured.organizationRole, null);
    await denied({ userId: 'alice', organizationId: 'actor-org' });
    await denied({ userId: 'alice', projectId: 'project-only' });
    console.log('agent-actor-context-test: PASS (actual PostgreSQL schema, canonical scope, revocation and transaction lock order)');
  } finally {
    internals._load = originalLoad;
    await database.close();
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
