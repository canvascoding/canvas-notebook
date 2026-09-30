import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { NextRequest } from 'next/server';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const internals = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = internals._load;
const workspaces: Record<string, Map<string, WorkspaceContext>> = {
  'fixture-alice': new Map(),
  'fixture-bob': new Map(),
};
const migratedScopes: Array<{ organizationId: string; workspaceId: string }> = [];

internals._load = function (name, ...args) {
  if (name === 'server-only') return {};
  if (name.endsWith('/app/lib/auth') || name.endsWith('/lib/auth')) {
    return { auth: { api: { getSession: async () => null } } };
  }
  if (name.endsWith('postgres-runtime')) {
    return {
      resolvePostgresWorkspaceForActor: async (actor: { userId: string }, workspaceId: string) => workspaces[actor.userId]?.get(workspaceId) ?? null,
      getPostgresWorkspaceState: async () => ({ defaultWorkspace: null }),
    };
  }
  if (name.endsWith('legacy-recovery')) {
    return { resolveLegacyWorkspaceRecovery: async () => null };
  }
  if (name.endsWith('studio-workspace-file-migration')) {
    return {
      ensureStudioWorkspaceFilesMigrated: async (scope: { storage: { organizationId: string; workspaceId: string } }) => {
        migratedScopes.push(scope.storage);
      },
    };
  }
  return originalLoad.call(this, name, ...args);
};

const permissions = {
  canRead: true,
  canWrite: true,
  canDelete: true,
  canCreatePublicLinks: false,
  canManageWorkspace: false,
  canRunAgent: false,
};

function workspace(workspaceId: string, organizationId: string): WorkspaceContext {
  return {
    workspaceId,
    workspaceType: 'organization',
    rootPath: `/fixture/${organizationId}/${workspaceId}`,
    organizationId,
    customerId: `customer-${organizationId}`,
    projectId: `project-${workspaceId}`,
    permissions,
    legacy: false,
  };
}

function session(userId: string) {
  return {
    user: { id: userId, email: `${userId}@fixture.invalid`, role: 'member' },
  } as never;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-org-scope-'));
  const envNames = [
    'DATA', 'CANVAS_DATA_ROOT', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH',
    'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY',
    'GEMINI_API_KEY', 'OPENAI_API_KEY', 'KIE_API_KEY',
  ] as const;
  const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

  try {
    for (const key of envNames) delete process.env[key];
    process.env.CANVAS_DATA_ROOT = root;

    const workspaceA = workspace('fixture-workspace-a', 'fixture-org-a');
    const workspaceB = workspace('fixture-workspace-b', 'fixture-org-b');
    workspaces['fixture-alice'].set(workspaceA.workspaceId, workspaceA);
    workspaces['fixture-bob'].set(workspaceB.workspaceId, workspaceB);

    const { requireStudioRequestScope } = await import('../app/lib/integrations/studio-request-scope');
    const { createStudioScope, studioInsertScope } = await import('../app/lib/integrations/studio-scope');
    const { getStudioWorkspaceRoot, getStudioWorkspaceVirtualRoot } = await import('../app/lib/integrations/studio-workspace');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { resolveStudioProviderCredential } = await import('../app/lib/integrations/studio-provider-credentials');

    const aliceRequest = new NextRequest('http://localhost/api/studio/products?workspaceId=fixture-workspace-a');
    const bobRequest = new NextRequest('http://localhost/api/studio/products', {
      headers: { 'x-canvas-workspace-id': 'fixture-workspace-b' },
    });
    const aliceResult = await requireStudioRequestScope(aliceRequest, session('fixture-alice'));
    const bobResult = await requireStudioRequestScope(bobRequest, session('fixture-bob'));

    assert.equal(aliceResult.response, null, JSON.stringify(await aliceResult.response?.clone().json()));
    assert.equal(bobResult.response, null);
    assert.deepEqual(aliceResult.scope && {
      actorUserId: aliceResult.scope.actorUserId,
      organizationId: aliceResult.scope.organizationId,
      workspaceId: aliceResult.scope.workspaceId,
      storage: aliceResult.scope.storage,
    }, {
      actorUserId: 'fixture-alice',
      organizationId: 'fixture-org-a',
      workspaceId: 'fixture-workspace-a',
      storage: { organizationId: 'fixture-org-a', workspaceId: 'fixture-workspace-a' },
    });
    assert.deepEqual(bobResult.scope && {
      actorUserId: bobResult.scope.actorUserId,
      organizationId: bobResult.scope.organizationId,
      workspaceId: bobResult.scope.workspaceId,
      storage: bobResult.scope.storage,
    }, {
      actorUserId: 'fixture-bob',
      organizationId: 'fixture-org-b',
      workspaceId: 'fixture-workspace-b',
      storage: { organizationId: 'fixture-org-b', workspaceId: 'fixture-workspace-b' },
    });
    assert.deepEqual(migratedScopes, [
      { organizationId: 'fixture-org-a', workspaceId: 'fixture-workspace-a' },
      { organizationId: 'fixture-org-b', workspaceId: 'fixture-workspace-b' },
    ], 'workspace migration receives the server-authorized organization/workspace pair');

    const foreignRequest = new NextRequest('http://localhost/api/studio/products?workspaceId=fixture-workspace-b', {
      headers: { 'x-canvas-workspace-id': 'fixture-workspace-a' },
    });
    const foreignResult = await requireStudioRequestScope(foreignRequest, session('fixture-alice'));
    assert.equal(foreignResult.response?.status, 404, 'a foreign query workspace is rejected even when the header names an authorized workspace');
    assert.equal(foreignResult.scope, null);
    assert.equal(migratedScopes.length, 2, 'unauthorized workspace requests never reach scoped migration');

    const aliceScope = createStudioScope('fixture-alice', workspaceA);
    const bobScope = createStudioScope('fixture-bob', workspaceB);
    assert.deepEqual(studioInsertScope(aliceScope), {
      organizationId: 'fixture-org-a', customerId: 'customer-fixture-org-a', projectId: 'project-fixture-workspace-a',
      workspaceId: 'fixture-workspace-a', createdByUserId: 'fixture-alice', visibility: 'workspace',
    });
    assert.deepEqual(studioInsertScope(bobScope), {
      organizationId: 'fixture-org-b', customerId: 'customer-fixture-org-b', projectId: 'project-fixture-workspace-b',
      workspaceId: 'fixture-workspace-b', createdByUserId: 'fixture-bob', visibility: 'workspace',
    });
    assert.equal(getStudioWorkspaceVirtualRoot(aliceScope.storage), 'studio/organizations/fixture-org-a/workspaces/fixture-workspace-a');
    assert.equal(getStudioWorkspaceVirtualRoot(bobScope.storage), 'studio/organizations/fixture-org-b/workspaces/fixture-workspace-b');
    assert.notEqual(getStudioWorkspaceRoot(aliceScope.storage), getStudioWorkspaceRoot(bobScope.storage));

    await replaceScopedEnvEntries('integrations', [{ key: 'GEMINI_API_KEY', value: 'fixture-org-a-gemini' }], aliceScope.storage);
    await replaceScopedEnvEntries('integrations', [{ key: 'GEMINI_API_KEY', value: 'fixture-org-b-gemini' }], bobScope.storage);
    await replaceScopedEnvEntries('integrations', [{ key: 'GEMINI_API_KEY', value: 'fixture-alice-personal-gemini' }], { userId: 'fixture-alice' });
    await replaceScopedEnvEntries('integrations', [{ key: 'GEMINI_API_KEY', value: 'fixture-bob-personal-gemini' }], { userId: 'fixture-bob' });

    assert.equal(await resolveStudioProviderCredential('gemini', aliceResult.scope!.storage), 'fixture-org-a-gemini');
    assert.equal(await resolveStudioProviderCredential('gemini', bobResult.scope!.storage), 'fixture-org-b-gemini');
    assert.equal(await resolveStudioProviderCredential('gemini', aliceResult.scope!.storage), await resolveStudioProviderCredential('gemini', { organizationId: 'fixture-org-a' }));
    assert.notEqual(await resolveStudioProviderCredential('gemini', aliceResult.scope!.storage), await resolveStudioProviderCredential('gemini', bobResult.scope!.storage));

    console.log('studio-organization-scope-test: request membership, workspace boundaries, and organization credentials passed');
  } finally {
    internals._load = originalLoad;
    for (const key of envNames) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
