import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.BASE_URL = 'https://canvas.example.test';
process.env.BETTER_AUTH_BASE_URL = process.env.BASE_URL;
const workspaceTools = import('../app/lib/mcp/server/workspace-tools');

test('binary upload exposes every input without host-dependent union branches', async () => {
  const { getDirectMcpWorkspaceToolDescriptor } = await workspaceTools;
  const schema = getDirectMcpWorkspaceToolDescriptor('upload_knowledge_asset').inputSchema;
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(schema.required, ['operation', 'workspace_id']);
  for (const field of ['operation', 'workspace_id', 'path', 'size', 'mime_type', 'sha256',
    'overwrite', 'expected_sha256', 'upload_id', 'offset', 'data_base64']) {
    assert.ok(Object.hasOwn(schema.properties ?? {}, field), `missing ${field}`);
  }
});

test('upload operation validation remains on the server', async () => {
  const { getDirectMcpWorkspaceToolDefinitions } = await workspaceTools;
  const tool = getDirectMcpWorkspaceToolDefinitions().find(item => item.id === 'upload_knowledge_asset')!;
  await assert.rejects(tool.execute({ operation: 'begin' }), /workspace_id/);
  await assert.rejects(tool.execute({ operation: 'not-an-operation', workspace_id: 'workspace' }), /operation must/);
  const unauthenticated = await tool.execute({ operation: 'begin', workspace_id: 'workspace' });
  assert.equal(unauthenticated.isError, true);
});
