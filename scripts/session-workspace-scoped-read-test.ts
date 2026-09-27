import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { assertWorkspacePermission } from '../app/lib/workspaces/permissions';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type ReadStoredWorkspace = (database: Record<string, unknown>, input: {
  sessionId: string; userId: string; agentId: string; workspaceId: string; permissions?: Array<'canRead' | 'canWrite' | 'canRunAgent'>;
}) => Promise<WorkspaceContext>;

type TestOptions = {
  session?: { workspace_id: string | null } | null;
  user?: { id: string; email: string; role: string } | null;
  workspace?: WorkspaceContext | null;
  canUse?: boolean;
};

function scopedReadHarness(options: TestOptions = {}) {
  const events: string[] = [];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const permissionChecks: string[] = [];
  const noConnectionSideEffects = { close: 0, run: 0, open: 0, globalDrizzle: 0, skills: 0 };
  const database = {
    get: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('FROM pi_sessions')) return options.session === undefined
        ? { workspace_id: 'workspace-1' } : options.session ?? undefined;
      throw new Error(`Unexpected caller-connection query: ${sql}`);
    },
    close: async () => { noConnectionSideEffects.close++; },
    run: async () => { noConnectionSideEffects.run++; throw new Error('read helper must not write'); },
  };
  const workspace: WorkspaceContext = options.workspace === undefined ? {
    workspaceId: 'workspace-1', workspaceType: 'team', displayName: 'Team Workspace', rootPath: '/unused',
    rootRelativePath: 'workspaces/team/files', organizationId: 'org-1', customerId: null, projectId: null,
    legacy: false, permissions: { canRead: true, canWrite: false, canDelete: false,
      canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true },
  } : options.workspace as WorkspaceContext;
  const user = options.user === undefined ? { id: 'user-1', email: 'member@example.test', role: 'member' } : options.user ?? undefined;
  const source = ts.transpileModule(readFileSync(path.resolve('app/lib/pi/session-workspace-context.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mockRequire = (name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db') return {
      db: { get: async () => { noConnectionSideEffects.globalDrizzle++; throw new Error('global db must not be used'); } },
      openDb: async () => { noConnectionSideEffects.open++; throw new Error('read helper must not borrow a connection'); },
    };
    if (name === '@/app/lib/db/schema') return { piSessions: {} };
    if (name === 'drizzle-orm') return { and: (...values: unknown[]) => values, eq: (...values: unknown[]) => values, isNull: (value: unknown) => value };
    if (name === '@/app/lib/agents/access') return {
      requireAgentAccess: async () => { throw new Error('legacy access resolver must not run'); },
      getAgentAccessOnConnection: async (connection: unknown, userId: string, agentId: string, accessScope: unknown) => {
        assert.equal(connection, database);
        events.push('agent-access');
        assert.equal(userId, 'user-1'); assert.equal(agentId, 'agent-1');
        assert.deepEqual(accessScope, { organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, projectId: workspace.projectId });
        return { canUse: options.canUse ?? true, canEdit: false, canManage: false };
      },
    };
    if (name === '@/app/lib/agents/storage') return { DEFAULT_MANAGED_AGENT_ID: 'main' };
    if (name === '@/app/lib/skills/effective-skill-read-roots') return {
      resolveEffectiveSkillReadRoots: async () => { noConnectionSideEffects.skills++; throw new Error('skill lookup not allowed'); },
      resolvePersonalSkillReadRoots: async () => { noConnectionSideEffects.skills++; throw new Error('skill lookup not allowed'); },
    };
    if (name === '@/app/lib/workspaces/context') return {
      LEGACY_PERSONAL_WORKSPACE_ID: 'legacy-personal',
      resolveWorkspaceActor: (input: { id: string; email: string; role: string }) => {
        events.push('actor'); assert.deepEqual(input, user);
        return { userId: input.id, email: input.email, role: input.role };
      },
    };
    if (name === '@/app/lib/workspaces/permissions') return {
      assertWorkspacePermission: (permissions: WorkspaceContext['permissions'], permission: keyof WorkspaceContext['permissions'], message?: string) => {
        permissionChecks.push(permission);
        assertWorkspacePermission(permissions, permission, message);
      },
    };
    if (name === '@/app/lib/workspaces/legacy-recovery') return { resolveLegacyWorkspaceRecovery: async () => false };
    if (name === '@/app/lib/workspaces/postgres-runtime') return {
      findPostgresUserById: async (connection: unknown, userId: string) => {
        assert.equal(connection, database); events.push('find-user'); assert.equal(userId, 'user-1'); return user;
      },
      readPostgresWorkspaceForActorOnConnection: async (connection: unknown, actor: unknown, workspaceId: string) => {
        assert.equal(connection, database); events.push('workspace-read');
        assert.deepEqual(actor, { userId: user?.id, email: user?.email, role: user?.role });
        assert.equal(workspaceId, 'workspace-1'); return workspace;
      },
      getPostgresWorkspaceState: async () => { throw new Error('workspace-state/default resolution must not run'); },
      resolvePostgresWorkspaceForActor: async () => { throw new Error('nested workspace resolution must not run'); },
    };
    if (name === '@/app/lib/agents/workspace-brand-context') return { getWorkspaceBrandPromptBlock: async () => null };
    return {};
  };
  new Function('require', 'module', 'exports', source)(mockRequire, { exports }, exports);
  return { read: (exports as { readStoredAgentWorkspaceOnConnection: ReadStoredWorkspace }).readStoredAgentWorkspaceOnConnection,
    database, queries, events, permissionChecks, noConnectionSideEffects, workspace };
}

const input = { sessionId: 'session-1', userId: 'user-1', agentId: 'agent-1', workspaceId: 'workspace-1' };

test('reads the exact active session and current authorization only on the caller connection', async () => {
  const h = scopedReadHarness();
  const result = await h.read(h.database, input);
  assert.equal(result, h.workspace);
  assert.deepEqual(h.queries, [{
    sql: 'SELECT workspace_id FROM pi_sessions\n     WHERE session_id = $1 AND user_id = $2 AND agent_id = $3 AND archived_at IS NULL LIMIT 1',
    params: ['session-1', 'user-1', 'agent-1'],
  }]);
  assert.deepEqual(h.events, ['find-user', 'actor', 'workspace-read', 'agent-access']);
  assert.deepEqual(h.noConnectionSideEffects, { close: 0, run: 0, open: 0, globalDrizzle: 0, skills: 0 });
});

test('caller mutation during the first await cannot change captured identity or requested permissions', async () => {
  const writable = scopedReadHarness({ workspace: {
    workspaceId: 'workspace-1', workspaceType: 'team', displayName: 'Team Workspace', rootPath: '/unused',
    rootRelativePath: 'workspaces/team/files', organizationId: 'org-1', customerId: null, projectId: null,
    legacy: false, permissions: { canRead: true, canWrite: true, canDelete: false,
      canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true },
  } });
  const mutableInput: {
    sessionId: string; userId: string; agentId: string; workspaceId: string;
    permissions: Array<'canRead' | 'canWrite' | 'canRunAgent'>;
  } = { ...input, permissions: ['canWrite'] };
  const get = writable.database.get;
  writable.database.get = async (sql, params) => {
    mutableInput.sessionId = 'attacker-session';
    mutableInput.userId = 'attacker-user';
    mutableInput.agentId = 'attacker-agent';
    mutableInput.workspaceId = 'attacker-workspace';
    mutableInput.permissions.splice(0, mutableInput.permissions.length, 'canRunAgent');
    return get(sql, params);
  };
  const result = await writable.read(writable.database, mutableInput);
  assert.equal(result, writable.workspace);
  assert.deepEqual(writable.queries[0].params, ['session-1', 'user-1', 'agent-1']);
  assert.deepEqual(writable.events, ['find-user', 'actor', 'workspace-read', 'agent-access']);
  assert.deepEqual(writable.permissionChecks, ['canWrite']);
});

test('read-only workspace permission is sufficient by default; write permission is explicit', async () => {
  const h = scopedReadHarness();
  assert.equal((await h.read(h.database, input)).permissions.canWrite, false);
  await assert.rejects(h.read(h.database, { ...input, permissions: ['canWrite'] }), (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'WORKSPACE_PERMISSION_DENIED'));
});

test('missing, moved, null, and archived sessions stop before user or workspace lookups', async (t) => {
  for (const [label, session] of [
    ['missing', null], ['moved', { workspace_id: 'other-workspace' }], ['null workspace', { workspace_id: null }],
    ['archived excluded by predicate', null],
  ] as const) {
    await t.test(label, async () => {
      const h = scopedReadHarness({ session });
      await assert.rejects(h.read(h.database, input), /originating agent session is unavailable/u);
      assert.equal(h.queries.length, 1);
      assert.deepEqual(h.events, []);
      assert.match(h.queries[0].sql, /archived_at IS NULL/u);
    });
  }
});

test('missing users, unavailable or legacy workspaces, and revoked agent access fail closed', async (t) => {
  const legacy = { workspaceId: 'workspace-1', workspaceType: 'personal', rootPath: '/legacy', legacy: true,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } } as WorkspaceContext;
  for (const [label, options] of [
    ['missing user', { user: null }], ['unavailable workspace', { workspace: null }], ['legacy workspace', { workspace: legacy }],
    ['revoked agent access', { canUse: false }],
  ] as const) {
    await t.test(label, async () => {
      const h = scopedReadHarness(options);
      await assert.rejects(h.read(h.database, input));
      assert.equal(h.noConnectionSideEffects.open, 0);
    });
  }
});

test('requested read and agent-run permissions are checked on the fresh workspace result', async (t) => {
  const noRead = { workspaceId: 'workspace-1', workspaceType: 'team', rootPath: '/unused', legacy: false,
    permissions: { canRead: false, canWrite: false, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true } } as WorkspaceContext;
  const noRun = { ...noRead, permissions: { ...noRead.permissions, canRead: true, canRunAgent: false } };
  for (const [label, workspace] of [['read denied', noRead], ['agent-run denied', noRun]] as const) {
    await t.test(label, async () => {
      const h = scopedReadHarness({ workspace });
      await assert.rejects(h.read(h.database, input), (error: unknown) =>
        Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'WORKSPACE_PERMISSION_DENIED'));
      assert.equal(h.events.includes('agent-access'), false, 'agent access is not evaluated without workspace permissions');
    });
  }
});
