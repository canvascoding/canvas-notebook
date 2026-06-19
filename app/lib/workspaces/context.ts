import 'server-only';

import path from 'node:path';

import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';
import { resolveWorkspacePermissions, normalizeWorkspaceRole } from './permissions';
import type { WorkspaceActor, WorkspaceContext } from './types';

export const LEGACY_PERSONAL_WORKSPACE_ID = 'legacy-personal-workspace';

function getRuntimeCwd(): string {
  return Reflect.apply(process.cwd, process, []) as string;
}

export function resolveWorkspaceDataRoot(cwd: string = getRuntimeCwd()): string {
  const configuredDataDir = process.env.DATA?.trim();
  if (!configuredDataDir || configuredDataDir === './data' || configuredDataDir === 'data') {
    return path.join(cwd, 'data');
  }

  if (path.isAbsolute(configuredDataDir)) {
    return configuredDataDir;
  }

  return path.join(cwd, 'data');
}

export function resolveLegacyWorkspaceRoot(cwd?: string): string {
  return path.join(resolveWorkspaceDataRoot(cwd), 'workspace');
}

export function resolveWorkspaceActor(input: {
  id: string;
  email?: string | null;
  role?: string | null;
}): WorkspaceActor {
  const role = isBootstrapAdminEmail(input.email) ? 'admin' : normalizeWorkspaceRole(input.role);
  return {
    userId: input.id,
    email: input.email,
    role,
  };
}

export function createLegacyPersonalWorkspaceContext(actor?: WorkspaceActor): WorkspaceContext {
  const role = actor?.role ?? 'member';
  return {
    workspaceId: LEGACY_PERSONAL_WORKSPACE_ID,
    workspaceType: 'personal',
    rootPath: resolveLegacyWorkspaceRoot(),
    actor,
    organizationId: null,
    ownerUserId: actor?.userId ?? null,
    permissions: resolveWorkspacePermissions({
      role,
      workspaceType: 'personal',
      ownsPersonalWorkspace: true,
      canCreatePublicLinks: true,
    }),
    legacy: true,
  };
}
