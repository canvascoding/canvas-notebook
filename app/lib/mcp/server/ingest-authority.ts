import 'server-only';

import type { DirectMcpAccessPrincipal } from './access-token-verifier';
import { verifyDirectMcpAccessToken } from './access-token-verifier';
import { getDirectMcpRuntimeSettings } from './runtime-settings';
import {
  isDirectMcpReadableWorkspace, listDirectMcpAllowedWorkspaceIds,
  listDirectMcpEnabledWorkspaceIds, loadDirectMcpWorkspaceListingForUser,
} from './workspace-access-policy';
import { DirectMcpFileIngestError } from './file-ingest';

/** Rechecks grant, instance/workspace opt-in and user permissions before publication. */
export async function createDirectMcpIngestAuthority(input: {
  token: string;
  tool: 'create_knowledge_source' | 'import_knowledge_file';
  workspaceId: string;
}) {
  const state: { original?: { principal: DirectMcpAccessPrincipal; rootPath: string } } = {};
  const verify = async () => {
    const [principal, settings] = await Promise.all([
      verifyDirectMcpAccessToken(input.token, ['knowledge:write']), getDirectMcpRuntimeSettings(),
    ]);
    if (!settings.enabled || !settings.tools.includes(input.tool)) {
      throw new DirectMcpFileIngestError('MCP_INGEST_NOT_ENABLED', 'Enable this capability under Settings > MCP Server.');
    }
    const [listing, allowed, enabled] = await Promise.all([
      loadDirectMcpWorkspaceListingForUser(principal.userId),
      listDirectMcpAllowedWorkspaceIds(principal), listDirectMcpEnabledWorkspaceIds(),
    ]);
    const workspace = listing.workspaces.find(candidate => candidate.workspaceId === input.workspaceId);
    if (!workspace || !isDirectMcpReadableWorkspace(workspace) || !workspace.permissions.canWrite
      || !workspace.permissions.canRunAgent || !allowed.has(input.workspaceId) || !enabled.has(input.workspaceId)
      || principal.expiresAt * 1000 <= Date.now()
      || (state.original && (principal.userId !== state.original.principal.userId
        || principal.clientId !== state.original.principal.clientId || principal.sessionId !== state.original.principal.sessionId
        || workspace.rootPath !== state.original.rootPath))) {
      throw new DirectMcpFileIngestError('MCP_INGEST_AUTHORITY_CHANGED', 'The workspace or connection no longer permits this import.');
    }
    return { principal, workspace };
  };
  const initial = await verify();
  state.original = { principal: initial.principal, rootPath: initial.workspace.rootPath };
  return { ...initial, verifyAuthority: async () => { await verify(); } };
}
