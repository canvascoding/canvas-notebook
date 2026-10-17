import 'server-only';

import { createHash } from 'node:crypto';
import { ExcalidrawDocumentError } from '@/app/lib/excalidraw-collaboration/scene-service';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { verifyDirectMcpAccessToken, type DirectMcpAccessPrincipal } from './access-token-verifier';
import { getDirectMcpRuntimeSettings } from './runtime-settings';
import { isDirectMcpReadableWorkspace, listDirectMcpAllowedWorkspaceIds,
  listDirectMcpEnabledWorkspaceIds, loadDirectMcpWorkspaceListingForUser } from './workspace-access-policy';

export type DirectMcpExcalidrawTool = 'create_excalidraw_scene' | 'get_excalidraw_scene' | 'edit_excalidraw_scene';

/** Each locked operation checks its live OAuth grant, capability and workspace again. */
export async function createDirectMcpExcalidrawAuthority(input: {
  token: string; tool: DirectMcpExcalidrawTool; workspaceId: string;
}) {
  const write = input.tool !== 'get_excalidraw_scene';
  const state: { initial?: { principal: DirectMcpAccessPrincipal; workspace: WorkspaceContext } } = {};
  const verify = async () => {
    const [principal, settings] = await Promise.all([
      verifyDirectMcpAccessToken(input.token, [write ? 'knowledge:write' : 'knowledge:read']),
      getDirectMcpRuntimeSettings(),
    ]);
    if (!settings.enabled || !settings.tools.includes(input.tool)) {
      throw new ExcalidrawDocumentError('EXCALIDRAW_MCP_NOT_ENABLED', 403, 'Enable this capability under Settings > MCP Server and reload the MCP connection.');
    }
    const [listing, allowed, enabled] = await Promise.all([
      loadDirectMcpWorkspaceListingForUser(principal.userId), listDirectMcpAllowedWorkspaceIds(principal),
      listDirectMcpEnabledWorkspaceIds(),
    ]);
    const workspace = listing.workspaces.find(candidate => candidate.workspaceId === input.workspaceId);
    if (!workspace || !isDirectMcpReadableWorkspace(workspace) || !allowed.has(input.workspaceId)
      || !enabled.has(input.workspaceId) || (write && (!workspace.permissions.canWrite || !workspace.permissions.canRunAgent))
      || principal.expiresAt * 1000 <= Date.now()
      || (state.initial && (principal.userId !== state.initial.principal.userId || principal.clientId !== state.initial.principal.clientId
        || principal.sessionId !== state.initial.principal.sessionId || workspace.rootPath !== state.initial.workspace.rootPath
        || (workspace.organizationId ?? null) !== (state.initial.workspace.organizationId ?? null)))) {
      throw new ExcalidrawDocumentError('EXCALIDRAW_MCP_AUTHORITY_CHANGED', 403, 'The workspace or connection no longer permits this Excalidraw operation. Reconnect and read the scene again.');
    }
    return { principal, workspace };
  };
  const initial = await verify();
  state.initial = initial;
  return { ...initial, actor: { userId: initial.principal.userId,
    actorId: `direct-mcp:${createHash('sha256').update(initial.principal.clientId).digest('hex').slice(0, 32)}`,
    actorType: 'agent' as const, sessionId: initial.principal.sessionId },
  verifyCurrent: async () => (await verify()).workspace };
}
