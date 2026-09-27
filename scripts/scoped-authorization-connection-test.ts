import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import type { AgentAccess, AgentAccessContext } from '../app/lib/agents/access';
import type { PostgresRuntimeDb } from '../app/lib/workspaces/postgres-runtime';
import type * as WorkspacePermissionsModule from '../app/lib/workspaces/permissions';
import type { WorkspaceActor, WorkspaceContext } from '../app/lib/workspaces/types';

type AgentAccessModule = {
  getAgentAccess(
    userId: string,
    agentId?: string | null,
    context?: AgentAccessContext,
  ): Promise<AgentAccess>;
  getAgentAccessOnConnection(
    database: Pick<PostgresRuntimeDb, 'get' | 'all'>,
    userId: string,
    agentId?: string | null,
    context?: AgentAccessContext,
  ): Promise<AgentAccess>;
};

type WorkspaceRuntimeModule = {
  readPostgresWorkspaceForActor(actor: WorkspaceActor, workspaceId: string): Promise<WorkspaceContext | null>;
  readPostgresWorkspaceForActorOnConnection(
    database: PostgresRuntimeDb,
    actor: WorkspaceActor,
    workspaceId: string,
  ): Promise<WorkspaceContext | null>;
};

function compile<T>(relativePath: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(relativePath);
  const runtimeRequire = createRequire(filename);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : runtimeRequire(name),
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports as T;
}

test('agent access on an existing connection preserves policy and observes revocation without borrowing', async () => {
  let opens = 0;
  let closes = 0;
  let failAgentRead = false;
  let agentRow: {
    access_policy: string;
    scope_type: string;
    organization_id: string | null;
    owner_user_id: string | null;
    can_use: number;
    can_edit: number;
    can_manage: number;
  } | undefined = {
    access_policy: 'organization',
    scope_type: 'organization',
    organization_id: 'organization-1',
    owner_user_id: null,
    can_use: 0,
    can_edit: 0,
    can_manage: 0,
  };
  let organizationPermission = { role: 'member', status: 'active' };
  let grants = [{ target_type: 'role', target_id: 'member', can_use: 1, can_edit: 0, can_manage: 0 }];
  const database = {
    async get(sql: string) {
      if (sql.includes('FROM agents a')) {
        if (failAgentRead) throw new Error('injected agent query failure');
        return agentRow ? { ...agentRow } : undefined;
      }
      if (sql.includes('FROM organization_user_permissions')) return { ...organizationPermission };
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async all(sql: string) {
      if (sql.includes('FROM agent_grants')) return grants.map((grant) => ({ ...grant }));
      throw new Error(`Unexpected all query: ${sql}`);
    },
    async close() {
      closes++;
    },
  };
  const access = compile<AgentAccessModule>('app/lib/agents/access.ts', {
    'server-only': {},
    '@/app/lib/db': { async openDb() { opens++; return database; } },
    '@/app/lib/organization/permissions': { readOrganizationPermissionForUser: async () => null },
    '@/app/lib/agents/registry': {
      listAgentProfiles: async () => [],
      normalizeManagedAgentId: (value: string | null | undefined) => value || 'main',
    },
    '@/app/lib/agents/storage': { SYSTEM_MANAGED_AGENT_IDS: ['main'] },
  });
  const context = { organizationId: 'organization-1', workspaceId: 'workspace-1' };

  assert.deepEqual(await access.getAgentAccess('user-1', 'agent-1', context), {
    canUse: true, canEdit: false, canManage: false,
  });
  assert.deepEqual({ opens, closes }, { opens: 1, closes: 1 });

  const leaseCounts = { opens, closes };
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', context), {
    canUse: true, canEdit: false, canManage: false,
  });
  assert.deepEqual({ opens, closes }, leaseCounts, 'connection-scoped access must not borrow or close a lease');

  grants = [{ target_type: 'workspace', target_id: 'workspace-1', can_use: 0, can_edit: 1, can_manage: 0 }];
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', context), {
    canUse: false, canEdit: true, canManage: false,
  }, 'workspace grants apply only to the matching scoped workspace');

  grants = [{ target_type: 'project', target_id: 'project-1', can_use: 0, can_edit: 0, can_manage: 1 }];
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', {
    ...context, projectId: 'project-1',
  }), {
    canUse: false, canEdit: false, canManage: true,
  }, 'project grants apply to a matching project in workspace scope');

  grants = [];
  agentRow = { ...agentRow, can_use: 1, can_manage: 1 };
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', context), {
    canUse: true, canEdit: false, canManage: true,
  }, 'direct membership flags remain effective without a scoped grant');

  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', {
    ...context, organizationId: 'organization-2',
  }), {
    canUse: false, canEdit: false, canManage: false,
  }, 'an organization mismatch rejects direct and scoped access');

  grants = [];
  agentRow = { ...agentRow, can_use: 0, can_manage: 0 };
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', context), {
    canUse: false, canEdit: false, canManage: false,
  }, 'a revoked grant must be observed on the caller connection');

  grants = [{ target_type: 'role', target_id: 'member', can_use: 1, can_edit: 1, can_manage: 0 }];
  organizationPermission = { role: 'member', status: 'suspended' };
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', context), {
    canUse: false, canEdit: false, canManage: false,
  }, 'a suspended organization membership must revoke scoped grants');

  organizationPermission = { role: 'member', status: 'active' };
  agentRow = {
    ...agentRow,
    access_policy: 'restricted',
    scope_type: 'user',
    organization_id: null,
    owner_user_id: 'user-1',
  };
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1'), {
    canUse: true, canEdit: true, canManage: true,
  }, 'a user-scoped owner retains full access');
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-2', 'agent-1'), {
    canUse: false, canEdit: false, canManage: false,
  }, 'a non-owner cannot use an owned user-scoped agent');

  agentRow = { ...agentRow, owner_user_id: null, can_use: 1, can_edit: 1, can_manage: 0 };
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-2', 'agent-1'), {
    canUse: true, canEdit: true, canManage: false,
  }, 'a pre-scope user agent retains its direct legacy member flags');

  agentRow = undefined;
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'missing-agent'), {
    canUse: false, canEdit: false, canManage: false,
  }, 'a missing agent has no access');

  agentRow = {
    access_policy: 'legacy',
    scope_type: 'organization',
    organization_id: 'organization-1',
    owner_user_id: null,
    can_use: 0,
    can_edit: 0,
    can_manage: 0,
  };
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'agent-1', context), {
    canUse: true, canEdit: true, canManage: true,
  }, 'legacy policy remains unrestricted');
  assert.deepEqual(await access.getAgentAccessOnConnection(database, 'user-1', 'main', context), {
    canUse: true, canEdit: true, canManage: true,
  }, 'built-in agents remain unrestricted');
  assert.deepEqual(await access.getAgentAccess('user-1'), {
    canUse: true, canEdit: true, canManage: true,
  }, 'the lease-owning API keeps the default built-in fast path');
  assert.deepEqual({ opens, closes }, leaseCounts);

  failAgentRead = true;
  await assert.rejects(access.getAgentAccess('user-1', 'agent-1', context), /injected agent query failure/);
  assert.deepEqual({ opens, closes }, { opens: 2, closes: 2 }, 'the wrapper closes its lease after a query failure');
});

test('workspace access on an existing connection matches the leased wrapper and observes revoked membership', async () => {
  let opens = 0;
  let closes = 0;
  const workspaceRow = {
    id: 'workspace-1',
    organization_id: 'organization-1',
    type: 'team',
    owner_user_id: null,
    customer_id: null,
    project_id: null,
    root_relative_path: 'workspaces/team/organization-1/workspace-1/files',
    display_name: 'Shared workspace',
    description: '',
    workspace_icon: 'folder',
    workspace_color: 'blue',
    status: 'active',
    is_default: 0,
    created_at: 1,
    updated_at: 2,
  };
  let organizationPermission = {
    role: 'member',
    status: 'active',
    can_write_team_workspace: 0,
    can_create_public_links: 1,
    can_create_team_automations: 0,
    can_share_plugins_and_skills: 0,
    can_export: 0,
    can_delete_team_files: 0,
    can_delete_studio_assets: 0,
    can_manage_backups: 0,
    can_manage_organization_memory: 0,
    can_migrate_database: 0,
    can_enable_knowledge: 0,
    can_recover_workspaces: 0,
  };
  let teamPermission = {
    workspace_id: 'workspace-1', role: 'member', status: 'active', can_read: 1, can_write: 0, can_manage: 0,
  };
  const database: PostgresRuntimeDb = {
    async get(sql: string) {
      if (sql.includes('FROM canvas_workspaces') && sql.includes('WHERE id = $1')) return { ...workspaceRow };
      if (sql.includes('FROM organization_user_permissions')) return { ...organizationPermission };
      if (sql.includes('FROM canvas_workspace_members')) return { ...teamPermission };
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async all(sql: string) { throw new Error(`Unexpected all query: ${sql}`); },
    async run(sql: string) { throw new Error(`Unexpected run query: ${sql}`); },
    async close() {
      closes++;
    },
  };
  const workspacePermissions = compile<typeof WorkspacePermissionsModule>('app/lib/workspaces/permissions.ts', {
    'server-only': {},
  });
  const runtime = compile<WorkspaceRuntimeModule>('app/lib/workspaces/postgres-runtime.ts', {
    'server-only': {},
    '@/app/lib/db': { async openDb() { opens++; return database; } },
    '@/app/lib/organization/config': {
      areTeamFeaturesEnabled: () => true,
      getConfiguredOrganizationId: () => 'organization-1',
      getDeploymentMode: () => 'team',
    },
    '@/app/lib/organization/contracts': {
      LOCAL_ORGANIZATION_ID_PREFIX: 'local-',
      OrganizationBootstrapError: class OrganizationBootstrapError extends Error {},
    },
    '@/app/lib/db/provider': {
      getDatabaseProvider: () => 'postgres',
      getDatabaseProviderProblemMessages: () => [],
      resolveDatabaseProviderGate: () => ({ blockers: [] }),
    },
    './colors': {
      DEFAULT_WORKSPACE_COLOR: 'gray',
      parseWorkspaceColor: (value: unknown) => typeof value === 'string' ? value : null,
    },
    './icons': {
      getDefaultWorkspaceIcon: () => 'folder',
      isWorkspaceIcon: (value: unknown) => typeof value === 'string',
    },
    './member-manager-policy': {
      WORKSPACE_LAST_MANAGER_CODE: 'WORKSPACE_LAST_MANAGER',
      WORKSPACE_LAST_MANAGER_MESSAGE: 'last manager',
      wouldRemoveLastWorkspaceManager: () => false,
    },
    './permissions': workspacePermissions,
    './starter-document': { seedWorkspaceStarterDocument: async () => undefined },
    './legacy-recovery': { importLegacyWorkspaceForOwner: async () => undefined },
    './contracts': {
      normalizeWorkspaceDescription: (value: unknown) => String(value || ''),
      normalizeWorkspaceColor: (value: unknown) => value,
      normalizeWorkspaceSlug: (value: string) => value,
      organizationWorkspaceRootRelativePathForSlug: () => '',
      personalWorkspaceRootRelativePath: () => '',
      personalWorkspaceRootRelativePathForSlug: () => '',
      projectWorkspaceRootRelativePath: () => '',
      teamWorkspaceRootRelativePathForSlug: () => '',
      WorkspaceOperationError: class WorkspaceOperationError extends Error {},
      workspaceAbsoluteRoot: (relativePath: string) => `/data/${relativePath}`,
    },
  });
  const actor: WorkspaceActor = { userId: 'user-1', role: 'member' };

  const leased = await runtime.readPostgresWorkspaceForActor(actor, 'workspace-1');
  assert.ok(leased);
  assert.equal(leased.permissions.canRead, true);
  assert.deepEqual({ opens, closes }, { opens: 1, closes: 1 });

  const leaseCounts = { opens, closes };
  const scoped = await runtime.readPostgresWorkspaceForActorOnConnection(database, actor, 'workspace-1');
  assert.deepEqual(scoped, leased, 'connection-scoped workspace lookup must preserve wrapper semantics');
  assert.deepEqual({ opens, closes }, leaseCounts, 'connection-scoped workspace lookup must not borrow or close a lease');

  teamPermission = { ...teamPermission, status: 'suspended', can_read: 0 };
  assert.equal(
    await runtime.readPostgresWorkspaceForActorOnConnection(database, actor, 'workspace-1'),
    null,
    'revoked workspace membership must be observed immediately',
  );
  organizationPermission = { ...organizationPermission, status: 'suspended' };
  teamPermission = { ...teamPermission, status: 'active', can_read: 1 };
  assert.equal(
    await runtime.readPostgresWorkspaceForActorOnConnection(database, actor, 'workspace-1'),
    null,
    'revoked organization membership must block team workspace access',
  );
  assert.deepEqual({ opens, closes }, leaseCounts);
});
