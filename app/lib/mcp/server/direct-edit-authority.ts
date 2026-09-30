import 'server-only';

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { verifyDirectMcpAccessToken } from './access-token-verifier';
import { getDirectMcpRuntimeSettings } from './runtime-settings';
import {
  isDirectMcpReadableWorkspace,
  listDirectMcpAllowedWorkspaceIds,
  listDirectMcpEnabledWorkspaceIds,
  loadDirectMcpWorkspaceListingForUser,
} from './workspace-access-policy';

export type DirectMcpEditAuthorityScope = {
  userId: string;
  clientId: string;
  sessionId: string;
  actorId: string;
  workspaceId: string;
  documentId: string;
  path: string;
  lifecycleGeneration: number;
};

declare const directMcpEditAuthorityBrand: unique symbol;
export type DirectMcpEditAuthority = {
  readonly [directMcpEditAuthorityBrand]: true;
  readonly scope: Readonly<DirectMcpEditAuthorityScope>;
  verifyCurrent(): Promise<WorkspaceContext>;
  assertUnexpired(): void;
};

export class DirectMcpEditAuthorityError extends Error {
  readonly code = 'MCP_DIRECT_EDIT_AUTHORITY_CHANGED';

  constructor() {
    super('MCP editing authority changed. Reconnect and read the current document before retrying.');
  }
}

// Next and the standalone collaboration server can load distinct bundles in
// one process. Share only the non-serializable registry; never store the token.
const registryKey = Symbol.for('canvas.direct-mcp-edit-authorities');
const runtime = globalThis as typeof globalThis & { [registryKey]?: WeakSet<object> };
const authorities = runtime[registryKey] ??= new WeakSet<object>();

export function isDirectMcpEditAuthority(value: unknown): value is DirectMcpEditAuthority {
  return typeof value === 'object' && value !== null && authorities.has(value);
}

export async function createDirectMcpEditAuthority(input: {
  token: string;
  scope: DirectMcpEditAuthorityScope;
}): Promise<DirectMcpEditAuthority> {
  const scope = Object.freeze({ ...input.scope });
  if (scope.actorId !== `direct-mcp:${createHash('sha256').update(scope.clientId).digest('hex').slice(0, 32)}`
    || !scope.userId || !scope.sessionId || !scope.workspaceId || !scope.documentId || !scope.path
    || !Number.isSafeInteger(scope.lifecycleGeneration) || scope.lifecycleGeneration < 1) {
    throw new DirectMcpEditAuthorityError();
  }
  let expiresAt = 0;
  const authority = Object.freeze({
    scope,
    assertUnexpired() {
      if (Date.now() >= expiresAt) throw new DirectMcpEditAuthorityError();
    },
    async verifyCurrent() {
      try {
        const [principal, settings] = await Promise.all([
          verifyDirectMcpAccessToken(input.token, ['knowledge:write']),
          getDirectMcpRuntimeSettings(),
        ]);
        if (!settings.enabled || !settings.tools.includes('edit_knowledge_source')
          || principal.userId !== scope.userId || principal.clientId !== scope.clientId
          || principal.sessionId !== scope.sessionId) throw new DirectMcpEditAuthorityError();
        expiresAt = principal.expiresAt * 1000;
        authority.assertUnexpired();
        const [listing, allowed, enabled] = await Promise.all([
          loadDirectMcpWorkspaceListingForUser(principal.userId),
          listDirectMcpAllowedWorkspaceIds(principal),
          listDirectMcpEnabledWorkspaceIds(),
        ]);
        const workspace = listing.workspaces.find(candidate => candidate.workspaceId === scope.workspaceId);
        if (!workspace || !isDirectMcpReadableWorkspace(workspace) || !workspace.permissions.canWrite
          || !workspace.permissions.canRunAgent || !allowed.has(scope.workspaceId)
          || !enabled.has(scope.workspaceId)) throw new DirectMcpEditAuthorityError();
        authority.assertUnexpired();
        return workspace;
      } catch {
        throw new DirectMcpEditAuthorityError();
      }
    },
  }) as DirectMcpEditAuthority;
  await authority.verifyCurrent();
  authorities.add(authority);
  return authority;
}
