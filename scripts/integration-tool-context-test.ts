import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-integration-context-'));
  process.env.DATA = root;
  process.env.CANVAS_DATA_ROOT = root;
  process.env.CANVAS_ORGANIZATION_ID = 'integration-context-org';
  process.env.CANVAS_DEPLOYMENT_MODE = 'team';
  process.env.CANVAS_TEAM_FEATURES_ENABLED = 'true';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  let duringResolution: (() => Promise<void>) | undefined;
  internals._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    // Unrelated prompt packaging is excluded; session, workspace and agent authorization remain real.
    if (name === '@/app/lib/skills/effective-skill-read-roots') return {
      resolveEffectiveSkillReadRoots: async () => [], resolvePersonalSkillReadRoots: async () => [],
    };
    if (name === '@/app/lib/agents/workspace-brand-context') return { getWorkspaceBrandPromptBlock: async () => {
      const pending = duringResolution;
      duringResolution = undefined;
      await pending?.();
      return null;
    } };
    return originalLoad(name, parent, isMain);
  };
  try {
    const raw = await database.openDb();
    for (const userId of ['owner', 'alice', 'bob']) {
      await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)',
        [userId, `${userId}@example.test`]);
    }
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('integration-context-org','owner','team',1,1,1)");
    for (const userId of ['alice', 'bob']) {
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,created_at,updated_at) VALUES ('integration-context-org',$1,'member','active',1,1)", [userId]);
    }
    for (const workspaceId of ['team-a', 'team-b']) {
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'integration-context-org','team',$2,$1,'active',1,1)",
        [workspaceId, `workspaces/${workspaceId}/files`]);
    }
    await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ('integration-context-org','team-a','alice','member','active',1,0,0,1,1)");
    await raw.run("INSERT INTO agents (agent_id,name,type,access_policy,scope_type,organization_id,owner_user_id,created_at,updated_at) VALUES ('design-agent','Design agent','special','restricted','organization','integration-context-org','owner',1,1)");
    await raw.run("INSERT INTO agent_grants (id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at) VALUES ('design-team-grant','design-agent','integration-context-org','workspace','team-a',1,0,0,1,1)");
    const { piSessions } = await import('../app/lib/db/schema');
    const now = new Date();
    await database.db.insert(piSessions).values([
      { sessionId: 'alice-team', userId: 'alice', agentId: 'design-agent', workspaceId: 'team-a', workspaceType: 'team',
        organizationId: 'integration-context-org', provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now },
      { sessionId: 'bob-team', userId: 'bob', agentId: 'bradley', workspaceId: 'team-a', workspaceType: 'team',
        organizationId: 'integration-context-org', provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now },
      { sessionId: 'alice-archived', userId: 'alice', agentId: 'design-agent', workspaceId: 'team-a', workspaceType: 'team',
        organizationId: 'integration-context-org', provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now, archivedAt: now },
      { sessionId: 'alice-inaccessible', userId: 'alice', agentId: 'design-agent', workspaceId: 'team-b', workspaceType: 'team',
        organizationId: 'integration-context-org', provider: 'fixture', model: 'fixture', createdAt: now, updatedAt: now },
    ]);
    const { resolveIntegrationExecutionContext } = await import('../app/lib/integration-tools/context');
    const input = { actorUserId: 'alice', sessionId: 'alice-team', policyRevision: 'policy-1' };
    const resolved = await resolveIntegrationExecutionContext(input);
    assert.deepEqual(resolved.integrationContext, {
      actorUserId: 'alice', organizationId: 'integration-context-org', workspaceId: 'team-a', agentId: 'design-agent', policyRevision: 'policy-1',
    });
    assert.equal(resolved.executionContext.canWrite, false, 'Read/run access is sufficient, no synthetic write grant.');
    assert.equal(resolved.executionContext.sessionId, 'alice-team');
    const mutable = { ...input };
    const pending = resolveIntegrationExecutionContext(mutable);
    Object.assign(mutable, { actorUserId: 'bob', sessionId: 'bob-team', policyRevision: 'forged' });
    assert.deepEqual((await pending).integrationContext, resolved.integrationContext, 'Authority is captured before the first await.');
    for (const changed of [
      { ...input, sessionId: 'missing' }, { ...input, sessionId: 'bob-team' },
      { ...input, sessionId: 'alice-archived' }, { ...input, actorUserId: 'bob' },
      { ...input, agentId: 'bradley' },
    ]) await assert.rejects(resolveIntegrationExecutionContext(changed), { code: 'provider_denied' });
    for (const changed of [{ ...input, policyRevision: ' ' }, { ...input, actorUserId: '' }, { ...input, sessionId: '' }]) {
      await assert.rejects(resolveIntegrationExecutionContext(changed), { code: 'invalid_request' });
    }
    await assert.rejects(resolveIntegrationExecutionContext({ ...input, sessionId: 'alice-inaccessible' }), /inaccessible/u);
    await raw.run("UPDATE agent_grants SET can_use=0 WHERE agent_id='design-agent'");
    await assert.rejects(resolveIntegrationExecutionContext(input), { code: 'AGENT_ACCESS_DENIED' });
    await raw.run("UPDATE agent_grants SET can_use=1 WHERE agent_id='design-agent'");
    await raw.run("UPDATE canvas_workspace_members SET status='disabled' WHERE user_id='alice' AND workspace_id='team-a'");
    await assert.rejects(resolveIntegrationExecutionContext(input), /inaccessible/u);
    await raw.run("UPDATE canvas_workspace_members SET status='active' WHERE user_id='alice' AND workspace_id='team-a'");
    duringResolution = async () => { await raw.run("UPDATE pi_sessions SET archived_at=1 WHERE session_id='alice-team'"); };
    await assert.rejects(resolveIntegrationExecutionContext(input), { code: 'provider_denied' }, 'Archiving during resolution invalidates the context.');
    await raw.run("UPDATE pi_sessions SET archived_at=NULL WHERE session_id='alice-team'");
    duringResolution = async () => { await raw.run("UPDATE pi_sessions SET agent_id='bradley' WHERE session_id='alice-team'"); };
    await assert.rejects(resolveIntegrationExecutionContext(input), { code: 'provider_denied' }, 'Changing the agent during resolution invalidates the context.');
    await raw.run("UPDATE pi_sessions SET agent_id='design-agent' WHERE session_id='alice-team'");
    await raw.run("UPDATE \"user\" SET banned=1 WHERE id='alice'");
    await assert.rejects(resolveIntegrationExecutionContext(input), { code: 'provider_denied' });
    console.log('PASS real PostgreSQL session context: actor/session/agent binding, archived and missing sessions, workspace and agent revocation, banned actor.');
  } finally {
    internals._load = originalLoad;
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
