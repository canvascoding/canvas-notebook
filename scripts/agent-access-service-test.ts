import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-access-'));
process.env.DATA = dataDir;

function insertOrganizationUser(
  sqlite: Database.Database,
  organizationId: string,
  input: { id: string; role?: 'admin' | 'member' },
) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, role, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(input.id, input.id, `${input.id}@example.test`, input.role || 'member', now, now);
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?)
  `).run(organizationId, input.id, input.role || 'member', now, now);
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const { runMigrations } = await import('../app/lib/db/migrate');
  const { createAgentProfile, deleteAgentProfile } = await import('../app/lib/agents/registry');
  const {
    AgentAccessError,
    createAgentManagerMembership,
    getAgentAccess,
    listAgentAccessForUser,
    listAgentMembersForManager,
    removeAgentMemberForManager,
    requireAgentAccess,
    upsertAgentMemberForManager,
  } = await import('../app/lib/agents/access');

  const owner = await createInitialOwner({
    name: 'Agent Owner',
    email: 'agent-owner@example.test',
    password: 'OwnerPassword123!',
  });
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };
  insertOrganizationUser(sqlite, organization.organizationId, { id: 'agent-user' });
  insertOrganizationUser(sqlite, organization.organizationId, { id: 'agent-editor' });
  insertOrganizationUser(sqlite, organization.organizationId, { id: 'agent-manager' });
  sqlite.close();

  const legacyAgent = await createAgentProfile({ name: 'Legacy Access Test Agent' });
  assert.deepEqual(await getAgentAccess('agent-user', legacyAgent.agentId), {
    canUse: true,
    canEdit: true,
    canManage: true,
  }, 'legacy profiles remain available until a manager membership initializes restricted access');
  const migrationDb = new Database(path.join(dataDir, 'sqlite.db'));
  runMigrations(migrationDb);
  migrationDb.close();
  assert.deepEqual(await getAgentAccess('agent-user', legacyAgent.agentId), {
    canUse: true,
    canEdit: true,
    canManage: false,
  }, 'legacy users retain use and edit access after membership backfill');
  assert.equal((await getAgentAccess(owner.id, legacyAgent.agentId)).canManage, true);
  await deleteAgentProfile(legacyAgent.agentId);

  const agent = await createAgentProfile({ name: 'Access Test Agent', accessPolicy: 'restricted' });
  assert.deepEqual(await getAgentAccess('agent-user', agent.agentId), {
    canUse: false,
    canEdit: false,
    canManage: false,
  });
  await createAgentManagerMembership(agent.agentId, owner.id);
  assert.deepEqual(await getAgentAccess(owner.id, agent.agentId), {
    canUse: true,
    canEdit: true,
    canManage: true,
  });
  assert.deepEqual(await getAgentAccess('agent-user', agent.agentId), {
    canUse: false,
    canEdit: false,
    canManage: false,
  });
  await assert.rejects(
    () => requireAgentAccess('agent-user', agent.agentId, 'canUse'),
    (error: unknown) => error instanceof AgentAccessError && error.code === 'AGENT_ACCESS_DENIED',
  );

  const initial = await listAgentMembersForManager(agent.agentId, owner.id);
  assert.deepEqual(initial.members.map((member) => member.userId), [owner.id]);
  assert.equal(initial.candidates.some((candidate) => candidate.userId === 'agent-user'), true);

  await upsertAgentMemberForManager({
    agentId: agent.agentId,
    actorUserId: owner.id,
    userId: 'agent-user',
    canUse: true,
  });
  assert.deepEqual(await getAgentAccess('agent-user', agent.agentId), {
    canUse: true,
    canEdit: false,
    canManage: false,
  });

  await upsertAgentMemberForManager({
    agentId: agent.agentId,
    actorUserId: owner.id,
    userId: 'agent-editor',
    canEdit: true,
  });
  assert.deepEqual(await getAgentAccess('agent-editor', agent.agentId), {
    canUse: true,
    canEdit: true,
    canManage: false,
  });

  await assert.rejects(
    () => upsertAgentMemberForManager({
      agentId: agent.agentId,
      actorUserId: owner.id,
      userId: owner.id,
      canManage: false,
    }),
    (error: unknown) => error instanceof AgentAccessError && error.code === 'AGENT_LAST_MANAGER',
  );
  await assert.rejects(
    () => removeAgentMemberForManager({
      agentId: agent.agentId,
      actorUserId: owner.id,
      userId: owner.id,
    }),
    (error: unknown) => error instanceof AgentAccessError && error.code === 'AGENT_LAST_MANAGER',
  );

  await upsertAgentMemberForManager({
    agentId: agent.agentId,
    actorUserId: owner.id,
    userId: 'agent-manager',
    canManage: true,
  });
  await upsertAgentMemberForManager({
    agentId: agent.agentId,
    actorUserId: owner.id,
    userId: owner.id,
    canEdit: true,
    canManage: false,
  });
  await removeAgentMemberForManager({
    agentId: agent.agentId,
    actorUserId: 'agent-manager',
    userId: owner.id,
  });
  assert.equal((await listAgentAccessForUser(owner.id)).has(agent.agentId), false);
  assert.equal((await listAgentAccessForUser('agent-manager')).get(agent.agentId)?.canManage, true);

  await deleteAgentProfile(agent.agentId);
  const verifyDb = new Database(path.join(dataDir, 'sqlite.db'));
  const remaining = verifyDb.prepare(`SELECT COUNT(*) AS count FROM agent_members WHERE agent_id = ?`).get(agent.agentId) as { count: number };
  verifyDb.close();
  assert.equal(remaining.count, 0, 'deleting an agent cascades its memberships');

  console.log('agent access service tests passed');
}

main()
  .finally(() => rmSync(dataDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
