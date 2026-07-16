import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-workspace-scope-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';

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
  if (request === '@earendil-works/pi-ai/oauth') return { getOAuthProvider: () => null };
  return originalLoad(request, parent, isMain);
};

async function listedAgentIds(response: Response): Promise<string[]> {
  const payload = await response.json() as {
    success?: boolean;
    data?: { agents?: Array<{ agentId: string }> };
  };
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.success, true);
  return (payload.data?.agents || []).map((agent) => agent.agentId);
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const { createManagedAgent, setManagedAgentGrant } = await import('../app/lib/agents/management-actions');
  const { upsertAgentGrant } = await import('../app/lib/agents/grants');

  const owner = await createInitialOwner({
    name: 'Workspace Scope Owner',
    email: 'workspace-scope-owner@example.test',
    password: 'WorkspaceScopeOwnerPassword123!',
  });
  const memberId = 'workspace-scope-member';
  const grantedWorkspaceId = 'workspace-scope-granted';
  const otherWorkspaceId = 'workspace-scope-other';
  const accessibleProjectId = 'workspace-scope-project';
  const now = Date.now();
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  sqlite.pragma('foreign_keys = ON');
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };
  sqlite.prepare(`
    UPDATE canvas_organization_settings
    SET team_features_enabled = 1
    WHERE organization_id = ?
  `).run(organization.organizationId);
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
    VALUES (?, 'Workspace Scope Member', 'workspace-scope-member@example.test', 1, 'user', ?, ?)
  `).run(memberId, now, now);
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', ?, ?)
  `).run(organization.organizationId, memberId, now, now);

  for (const [workspaceId, displayName] of [
    [grantedWorkspaceId, 'Granted Workspace'],
    [otherWorkspaceId, 'Other Workspace'],
  ] as const) {
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, root_relative_path, display_name, description,
        workspace_icon, status, is_default, created_at, updated_at
      ) VALUES (?, ?, 'team', ?, ?, '', 'users-round', 'active', 0, ?, ?)
    `).run(
      workspaceId,
      organization.organizationId,
      `workspaces/team/${organization.organizationId}/${workspaceId}/files`,
      displayName,
      now,
      now,
    );
    sqlite.prepare(`
      INSERT INTO canvas_workspace_members (
        organization_id, workspace_id, user_id, role, status,
        can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'member', 'active', 1, 1, 0, ?, ?, ?)
    `).run(organization.organizationId, workspaceId, memberId, owner.id, now, now);
  }

  sqlite.prepare(`
    INSERT INTO canvas_projects (
      id, organization_id, name, slug, status, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, 'Accessible Project', 'workspace-scope-project', 'active', ?, ?, ?)
  `).run(accessibleProjectId, organization.organizationId, owner.id, now, now);
  sqlite.prepare(`
    INSERT INTO canvas_project_members (
      organization_id, project_id, user_id, role, status,
      can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'member', 'active', 1, 0, 0, ?, ?, ?)
  `).run(organization.organizationId, accessibleProjectId, memberId, owner.id, now, now);
  sqlite.close();

  const ownerActor = {
    userId: owner.id,
    organizationId: organization.organizationId,
    source: 'api' as const,
  };
  const created = await createManagedAgent(ownerActor, {
    name: 'Workspace Scoped Agent',
    scopeType: 'organization',
  });
  await setManagedAgentGrant({
    actor: ownerActor,
    agentId: created.agent.agentId,
    expectedRevision: created.agent.revision,
    targetType: 'workspace',
    targetId: grantedWorkspaceId,
    canUse: true,
  });
  await upsertAgentGrant({
    agentId: created.agent.agentId,
    organizationId: organization.organizationId,
    targetType: 'project',
    targetId: accessibleProjectId,
    canUse: true,
    actorUserId: owner.id,
  });

  const originalFetch = globalThis.fetch;
  let requestedAgentUrl = '';
  globalThis.fetch = async (input) => {
    requestedAgentUrl = String(input);
    return Response.json({ success: true, data: { agents: [] } });
  };
  try {
    const { fetchChatAgents } = await import('../app/lib/chat/agent-api');
    await fetchChatAgents(grantedWorkspaceId);
    assert.equal(requestedAgentUrl, `/api/agents?workspaceId=${grantedWorkspaceId}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { auth } = await import('../app/lib/auth');
  type RouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
  const routeSession = {
    user: {
      id: memberId,
      email: 'workspace-scope-member@example.test',
      name: 'Workspace Scope Member',
      role: 'user',
    },
    session: { id: 'workspace-scope-session', userId: memberId },
  } as RouteSession;
  Reflect.set(auth.api, 'getSession', async () => routeSession);

  const agentsRoute = await import('../app/api/agents/route');
  const effectiveRoute = await import('../app/api/agent-runtime/effective/route');
  const preferencesRoute = await import('../app/api/agent-runtime/preferences/route');

  const broadAgentIds = await listedAgentIds(await agentsRoute.GET(new NextRequest(
    'http://localhost:3000/api/agents',
  )));
  assert.equal(broadAgentIds.includes(created.agent.agentId), true);

  const grantedAgentIds = await listedAgentIds(await agentsRoute.GET(new NextRequest(
    `http://localhost:3000/api/agents?workspaceId=${grantedWorkspaceId}`,
  )));
  assert.equal(grantedAgentIds.includes(created.agent.agentId), true);

  const otherAgentIds = await listedAgentIds(await agentsRoute.GET(new NextRequest(
    `http://localhost:3000/api/agents?workspaceId=${otherWorkspaceId}`,
  )));
  assert.equal(
    otherAgentIds.includes(created.agent.agentId),
    false,
    'A grant for another workspace or project must not leak into the active workspace.',
  );

  const missingWorkspaceResponse = await agentsRoute.GET(new NextRequest(
    'http://localhost:3000/api/agents?workspaceId=missing-workspace',
  ));
  assert.equal(missingWorkspaceResponse.status, 404);

  const effectiveResponse = await effectiveRoute.GET(new NextRequest(
    `http://localhost:3000/api/agent-runtime/effective?workspaceId=${otherWorkspaceId}&agentId=${created.agent.agentId}`,
  ));
  assert.equal(effectiveResponse.status, 403);
  assert.equal((await effectiveResponse.json()).code, 'AGENT_ACCESS_DENIED');

  const preferenceResponse = await preferencesRoute.GET(new NextRequest(
    `http://localhost:3000/api/agent-runtime/preferences?workspaceId=${otherWorkspaceId}&agentId=${created.agent.agentId}`,
  ));
  assert.equal(preferenceResponse.status, 403);
  assert.equal((await preferenceResponse.json()).code, 'AGENT_ACCESS_DENIED');

  console.log('agent-workspace-scope-test: ok');
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
