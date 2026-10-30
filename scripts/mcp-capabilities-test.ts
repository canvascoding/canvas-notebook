import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWorkspaceCapabilities } from '../app/lib/mcp/server/workspace-capabilities';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { DirectMcpToolDescriptor } from '../app/lib/mcp/server/tool-descriptor';

const descriptors = [
  ['read_knowledge_source', 'knowledge:read'], ['replace_knowledge_source', 'knowledge:write'],
  ['delete_knowledge_source', 'knowledge:write'],
].map(([name, scope]) => ({ name, inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' } } },
  securitySchemes: [{ type: 'oauth2', scopes: [scope] }], _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] } })) as DirectMcpToolDescriptor[];
const workspace = { workspaceId: 'one', permissions: { canRead: true, canRunAgent: true, canWrite: false, canDelete: false } } as WorkspaceContext;
test('capabilities combine current workspace rights, OAuth scopes and explicit tool opt-in', () => {
  const base = { workspace, enabled: true, enabledTools: descriptors.map(d => d.name), descriptors, scopes: ['knowledge:read', 'knowledge:write'] };
  const reader = describeWorkspaceCapabilities(base);
  assert.equal(reader.tools[0].allowed_by_workspace_and_connection, true);
  assert.deepEqual(reader.tools[1].reasons, ['WORKSPACE_WRITE_DENIED']);
  assert.deepEqual(reader.tools[2].reasons, ['WORKSPACE_WRITE_DENIED', 'WORKSPACE_DELETE_DENIED']);
  const writer = describeWorkspaceCapabilities({ ...base, workspace: { ...workspace, permissions: { ...workspace.permissions, canWrite: true } } });
  assert.equal(writer.tools[1].allowed_by_workspace_and_connection, true);
  assert.deepEqual(writer.tools[2].reasons, ['WORKSPACE_DELETE_DENIED']);
  const narrow = describeWorkspaceCapabilities({ ...base, scopes: ['knowledge:read'], enabledTools: ['read_knowledge_source'] });
  assert(narrow.tools[1].reasons.includes('OAUTH_SCOPE_MISSING'));
  assert(narrow.tools[1].reasons.includes('TOOL_DISABLED'));
  const disabled = describeWorkspaceCapabilities({ ...base, enabled: false });
  assert(disabled.tools.every(tool => !tool.allowed_by_workspace_and_connection));
  assert.equal(reader.schema_sha256, describeWorkspaceCapabilities({ ...base, descriptors: [...descriptors].reverse() }).schema_sha256);
  assert.notEqual(reader.schema_sha256, describeWorkspaceCapabilities({ ...base, descriptors: descriptors.slice(1) }).schema_sha256);
});
