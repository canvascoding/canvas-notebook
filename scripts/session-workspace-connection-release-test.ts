import assert from 'node:assert/strict';
import Module from 'node:module';

async function main(): Promise<void> {
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  process.env.BETTER_AUTH_SECRET = 'connection-release-test-secret-at-least-32-characters';
  const events: string[] = [];
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;

  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/db') {
      return {
        db: {},
        openDb: async () => {
          events.push('open');
          return { close: async () => events.push('close') };
        },
      };
    }
    if (request === '@/app/lib/agents/access') {
      return { requireAgentAccess: async () => undefined };
    }
    if (request === '@/app/lib/agents/storage') {
      return { DEFAULT_MANAGED_AGENT_ID: 'main' };
    }
    if (request === '@/app/lib/skills/effective-skill-read-roots') {
      return {
        resolveEffectiveSkillReadRoots: () => [],
        resolvePersonalSkillReadRoots: () => [],
      };
    }
    if (request === '@/app/lib/db/schema') {
      return { piSessions: {} };
    }
    if (request === '@/app/lib/agents/workspace-brand-context') {
      return { getWorkspaceBrandPromptBlock: async () => null };
    }
    if (request === '@/app/lib/workspaces/postgres-runtime') {
      return {
        findPostgresUserById: async () => {
          events.push('find-user');
          return { id: 'user-1', email: 'user@example.test', role: 'admin' };
        },
        getPostgresWorkspaceState: async () => ({ defaultWorkspace: null }),
        resolvePostgresWorkspaceForActor: async () => {
          events.push('resolve-workspace');
          return {
            workspaceId: 'workspace-1',
            workspaceType: 'personal',
            workspaceName: 'Personal Workspace',
            organizationId: null,
            customerId: null,
            projectId: null,
            rootRelativePath: 'workspaces/personal/user-1/files',
            legacy: false,
            permissions: { canRead: true, canRunAgent: true },
          };
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { resolveAgentSessionWorkspaceForUser } = await import('../app/lib/pi/session-workspace-context');
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: 'user-1',
      workspaceId: 'workspace-1',
    });
    assert.equal(workspace.workspaceId, 'workspace-1');
    assert.deepEqual(
      events,
      ['open', 'find-user', 'close', 'resolve-workspace'],
      'the user lookup connection must be released before nested workspace resolution',
    );
    console.log('Session workspace connection release check passed.');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

void main();
