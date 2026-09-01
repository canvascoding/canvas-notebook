import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-management-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return {};
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  if (request === '@earendil-works/pi-ai/oauth') {
    return { getOAuthProvider: () => null };
  }
  return originalLoad(request, parent, isMain);
};

function insertMember(sqlite: Database.Database, organizationId: string, userId: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'user', ?, ?)
  `).run(userId, userId, `${userId}@example.test`, now, now);
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', ?, ?)
  `).run(organizationId, userId, now, now);
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const {
    createManagedAgent,
    deleteManagedAgent,
    inspectManagedAgent,
    listManagedAgents,
    previewManagedAgentDeletion,
    setManagedAgentGrant,
    updateManagedAgentCapabilities,
    updateManagedAgentFile,
    updateManagedAgentProfile,
  } = await import('../app/lib/agents/management-actions');
  const { listAgentGrantTargets } = await import('../app/lib/agents/grants');
  const { AgentRevisionConflictError } = await import('../app/lib/agents/registry');
  const { getAgentAccess } = await import('../app/lib/agents/access');
  const { addMemory, exportAgentMemory } = await import('../app/lib/memory/service');

  const owner = await createInitialOwner({
    name: 'Agent Management Owner',
    email: 'agent-management-owner@example.test',
    password: 'OwnerPassword123!',
  });
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId FROM canvas_organization_settings LIMIT 1
  `).get() as { organizationId: string };
  insertMember(sqlite, organization.organizationId, 'marketing-user');
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO canvas_projects (
      id, organization_id, name, slug, status, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    'project-agent-grant-target',
    organization.organizationId,
    'Agent Grant Project',
    'agent-grant-project',
    owner.id,
    now,
    now,
  );
  sqlite.prepare(`
    INSERT INTO canvas_workspaces (
      id, organization_id, type, root_relative_path, display_name, description,
      workspace_icon, status, is_default, created_at, updated_at
    ) VALUES (?, ?, 'team', ?, ?, '', 'users-round', 'active', 0, ?, ?)
  `).run(
    'workspace-agent-grant-target',
    organization.organizationId,
    `workspaces/team/${organization.organizationId}/agent-grant-target/files`,
    'Agent Grant Workspace',
    now,
    now,
  );
  sqlite.prepare(`
    INSERT INTO canvas_workspace_members (
      organization_id, workspace_id, user_id, role, status,
      can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'member', 'active', 1, 1, 0, ?, ?, ?)
  `).run(
    organization.organizationId,
    'workspace-agent-grant-target',
    'marketing-user',
    owner.id,
    now,
    now,
  );
  sqlite.prepare(`
    INSERT INTO canvas_workspaces (
      id, organization_id, type, root_relative_path, display_name, description,
      workspace_icon, status, is_default, created_at, updated_at
    ) VALUES (?, ?, 'team', ?, ?, '', 'users-round', 'disabled', 0, ?, ?)
  `).run(
    'workspace-agent-grant-disabled',
    organization.organizationId,
    `workspaces/team/${organization.organizationId}/agent-grant-disabled/files`,
    'Disabled Agent Grant Workspace',
    now,
    now,
  );
  const otherWorkspace = sqlite.prepare(`
    SELECT id
    FROM canvas_workspaces
    WHERE organization_id = ? AND id != ? AND status = 'active'
    ORDER BY id ASC
    LIMIT 1
  `).get(
    organization.organizationId,
    'workspace-agent-grant-target',
  ) as { id: string };
  sqlite.close();

  const memberActor = { userId: 'marketing-user', organizationId: organization.organizationId, source: 'api' as const };
  const ownerActor = { userId: owner.id, organizationId: organization.organizationId, source: 'api' as const };

  const personal = await createManagedAgent(memberActor, {
    name: 'Personal Marketing Helper',
    scopeType: 'user',
    enabledTools: ['read', 'web_search'],
    files: { 'AGENTS.md': '# Personal marketing instructions' },
  });
  assert.equal(personal.agent.scopeType, 'user');
  assert.equal(personal.agent.ownerUserId, 'marketing-user');
  assert.equal((await listManagedAgents(memberActor)).some((agent) => agent.agentId === personal.agent.agentId), true);
  assert.equal(
    existsSync(path.join(dataDir, 'users', 'marketing-user', 'agents', personal.agent.agentId, 'AGENTS.md')),
    true,
  );

  const skillsOverride = await updateManagedAgentCapabilities({
    actor: memberActor,
    agentId: personal.agent.agentId,
    expectedRevision: personal.agent.revision,
    relevantSkills: [],
  });
  assert.deepEqual(skillsOverride.agent.relevantSkills, []);
  assert.equal(skillsOverride.agent.relevantConnections, null);

  const connectionsOverride = await updateManagedAgentCapabilities({
    actor: memberActor,
    agentId: personal.agent.agentId,
    expectedRevision: skillsOverride.agent.revision,
    relevantConnections: [],
  });
  assert.deepEqual(connectionsOverride.agent.relevantSkills, []);
  assert.deepEqual(connectionsOverride.agent.relevantConnections, []);

  const inheritedSkills = await updateManagedAgentCapabilities({
    actor: memberActor,
    agentId: personal.agent.agentId,
    expectedRevision: connectionsOverride.agent.revision,
    relevantSkills: null,
  });
  assert.equal(inheritedSkills.agent.relevantSkills, null);
  assert.deepEqual(inheritedSkills.agent.relevantConnections, []);

  const inheritedConnections = await updateManagedAgentCapabilities({
    actor: memberActor,
    agentId: personal.agent.agentId,
    expectedRevision: inheritedSkills.agent.revision,
    relevantConnections: null,
  });
  assert.equal(inheritedConnections.agent.relevantSkills, null);
  assert.equal(inheritedConnections.agent.relevantConnections, null);

  await assert.rejects(
    () => createManagedAgent(memberActor, {
      name: 'Recursive Agent Factory',
      scopeType: 'user',
      enabledTools: ['create_agent'],
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'AGENT_RECURSIVE_MANAGEMENT_BLOCKED',
  );

  await assert.rejects(
    () => createManagedAgent(memberActor, { name: 'Forbidden Organization Agent', scopeType: 'organization' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'AGENT_ORGANIZATION_ADMIN_REQUIRED',
  );

  const organizationAgent = await createManagedAgent(ownerActor, {
    name: 'Organization Marketing Agent',
    scopeType: 'organization',
    enabledTools: ['read', 'web_search'],
    relevantConnections: ['hubspot'],
    files: {
      'AGENTS.md': '# Organization marketing instructions',
      'MEMORY.md': 'Owner-specific marketing memory',
    },
  });
  assert.equal(organizationAgent.agent.scopeType, 'organization');
  assert.equal(organizationAgent.agent.organizationId, organization.organizationId);
  assert.equal(organizationAgent.agent.ownerUserId, null);
  assert.equal(organizationAgent.readiness[0]?.readiness, 'personal-connection-required');

  const grantTargets = await listAgentGrantTargets(organization.organizationId);
  assert.deepEqual(
    grantTargets.users.find((candidate) => candidate.userId === 'marketing-user'),
    {
      userId: 'marketing-user',
      name: 'marketing-user',
      email: 'marketing-user@example.test',
      role: 'member',
    },
  );
  assert.deepEqual(
    grantTargets.workspaces.find((candidate) => candidate.workspaceId === 'workspace-agent-grant-target'),
    {
      workspaceId: 'workspace-agent-grant-target',
      name: 'Agent Grant Workspace',
      type: 'team',
    },
  );
  assert.equal(
    grantTargets.workspaces.some((candidate) => candidate.workspaceId === 'workspace-agent-grant-disabled'),
    false,
  );
  assert.deepEqual(
    grantTargets.projects.find((candidate) => candidate.projectId === 'project-agent-grant-target'),
    {
      projectId: 'project-agent-grant-target',
      name: 'Agent Grant Project',
    },
  );

  const definitionPath = path.join(
    dataDir,
    'organizations',
    organization.organizationId,
    'agents',
    organizationAgent.agent.agentId,
    'definition',
    'AGENTS.md',
  );
  const memoryPath = path.join(dataDir, 'users', owner.id, 'agents', organizationAgent.agent.agentId, 'MEMORY.md');
  assert.equal(readFileSync(definitionPath, 'utf8').trim(), '# Organization marketing instructions');
  assert.equal(readFileSync(memoryPath, 'utf8').trim(), 'Owner-specific marketing memory');

  const granted = await setManagedAgentGrant({
    actor: ownerActor,
    agentId: organizationAgent.agent.agentId,
    expectedRevision: organizationAgent.agent.revision,
    targetType: 'workspace',
    targetId: 'workspace-agent-grant-target',
    canUse: true,
  });
  assert.deepEqual(await getAgentAccess('marketing-user', organizationAgent.agent.agentId), {
    canUse: true,
    canEdit: false,
    canManage: false,
  });
  assert.deepEqual(await getAgentAccess('marketing-user', organizationAgent.agent.agentId, {
    organizationId: organization.organizationId,
    workspaceId: 'workspace-agent-grant-target',
  }), {
    canUse: true,
    canEdit: false,
    canManage: false,
  });
  assert.deepEqual(await getAgentAccess('marketing-user', organizationAgent.agent.agentId, {
    organizationId: organization.organizationId,
    workspaceId: otherWorkspace.id,
  }), {
    canUse: false,
    canEdit: false,
    canManage: false,
  });

  const inspected = await inspectManagedAgent(memberActor, organizationAgent.agent.agentId);
  assert.equal(inspected.agent.agentId, organizationAgent.agent.agentId);
  assert.equal(inspected.access.canUse, true);
  assert.equal(inspected.files, undefined, 'users without edit access cannot disclose definition files');

  await assert.rejects(
    () => updateManagedAgentProfile({
      actor: ownerActor,
      agentId: organizationAgent.agent.agentId,
      expectedRevision: organizationAgent.agent.revision,
      name: 'Stale update',
    }),
    (error: unknown) => error instanceof AgentRevisionConflictError,
  );

  const fileUpdate = await updateManagedAgentFile({
    actor: ownerActor,
    agentId: organizationAgent.agent.agentId,
    expectedRevision: granted.agent.revision,
    fileName: 'AGENTS.md',
    content: '# Updated organization marketing instructions',
  });
  assert.equal(readFileSync(definitionPath, 'utf8').trim(), '# Updated organization marketing instructions');

  await addMemory({
    target: 'agent',
    userId: owner.id,
    agentId: organizationAgent.agent.agentId,
    content: 'Keep the retained campaign vocabulary after agent deletion.',
  });

  const preview = await previewManagedAgentDeletion(ownerActor, organizationAgent.agent.agentId);
  assert.equal(preview.impacts.grants, 1);
  assert.equal(preview.impacts.memoryCollections, 1);
  assert.equal(preview.impacts.memoryEntries, 1);
  assert.equal(preview.impacts.memoryPolicy, 'retained');
  assert.equal(preview.agent.revision, fileUpdate.agent.revision);
  await assert.rejects(
    () => deleteManagedAgent({
      actor: ownerActor,
      agentId: organizationAgent.agent.agentId,
      expectedRevision: fileUpdate.agent.revision,
      confirmationToken: `${preview.confirmationToken}invalid`,
    }),
    /confirmation is invalid/,
  );
  await deleteManagedAgent({
    actor: ownerActor,
    agentId: organizationAgent.agent.agentId,
    expectedRevision: fileUpdate.agent.revision,
    confirmationToken: preview.confirmationToken,
  });
  assert.equal(existsSync(path.dirname(path.dirname(definitionPath))), false);
  const retainedMemory = await exportAgentMemory(owner.id, organizationAgent.agent.agentId);
  assert.equal(retainedMemory.ownerStatus, 'deleted');
  assert.equal(retainedMemory.collections[0]?.entries.length, 1);

  const personalPreview = await previewManagedAgentDeletion(memberActor, personal.agent.agentId);
  await deleteManagedAgent({
    actor: memberActor,
    agentId: personal.agent.agentId,
    expectedRevision: personalPreview.agent.revision,
    confirmationToken: personalPreview.confirmationToken,
  });
  assert.equal((await listManagedAgents(memberActor)).some((agent) => agent.agentId === personal.agent.agentId), false);

  console.log('agent management service tests passed');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
