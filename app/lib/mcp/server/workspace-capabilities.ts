import 'server-only';
import { createHash } from 'node:crypto';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { DirectMcpToolDescriptor } from './tool-descriptor';
import { DIRECT_MCP_PROTOCOL_VERSION, DIRECT_MCP_TOOL_CONFIGURATION_VERSION } from './config';
import { DIRECT_MCP_SERVER_VERSION } from './version';

/** Report current workspace/connection permission, separately from document policy. */
export function describeWorkspaceCapabilities(input: {
  workspace: WorkspaceContext; scopes: readonly string[]; enabled: boolean;
  enabledTools: readonly string[]; descriptors: readonly DirectMcpToolDescriptor[];
}) {
  const permissions = input.workspace.permissions;
  const tools = input.descriptors.map(descriptor => {
    const scopes = descriptor.securitySchemes.flatMap(scheme => scheme.scopes);
    const write = scopes.includes('knowledge:write');
    const requiresDelete = ['move_knowledge_source', 'delete_knowledge_source'].includes(descriptor.name);
    const reasons = [
      ...(!input.enabled || !input.enabledTools.includes(descriptor.name) ? ['TOOL_DISABLED'] : []),
      ...(scopes.some(scope => !input.scopes.includes(scope)) ? ['OAUTH_SCOPE_MISSING'] : []),
      ...(!permissions.canRead || !permissions.canRunAgent ? ['WORKSPACE_ACCESS_DENIED'] : []),
      ...(write && !permissions.canWrite ? ['WORKSPACE_WRITE_DENIED'] : []),
      ...(requiresDelete && !permissions.canDelete ? ['WORKSPACE_DELETE_DENIED'] : []),
    ];
    return { name: descriptor.name, required_scopes: scopes, allowed_by_workspace_and_connection: reasons.length === 0,
      reasons, subject_to_document_policy: write };
  });
  const schemas = [...input.descriptors].sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }));
  return {
    server_version: DIRECT_MCP_SERVER_VERSION, protocol_version: DIRECT_MCP_PROTOCOL_VERSION,
    schema_version: DIRECT_MCP_TOOL_CONFIGURATION_VERSION,
    schema_sha256: createHash('sha256').update(JSON.stringify(schemas)).digest('hex'),
    workspace_granted: true, workspace_enabled: true,
    workspace_permissions: { read: permissions.canRead, write: permissions.canWrite,
      delete: permissions.canDelete, run_agent: permissions.canRunAgent },
    oauth_scopes: [...input.scopes].sort(), tools,
    consistency: 'Current authorized workspace observation; every operation rechecks access. Document state, revision, native mutation gates, destination permissions and review policies still apply.',
  };
}
