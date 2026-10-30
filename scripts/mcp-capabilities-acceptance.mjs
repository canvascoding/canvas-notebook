import assert from 'node:assert/strict';
export async function verifyCapabilitiesAcceptance(call) {
  const result = await call('get_workspace_overview', {});
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const { capabilities, limits } = result.structuredContent;
  assert.ok(capabilities.server_version); assert.equal(capabilities.schema_version, 8);
  assert.match(capabilities.schema_sha256, /^[a-f0-9]{64}$/u);
  assert(limits.upload_max_bytes > limits.upload_chunk_max_bytes);
  assert.equal(limits.upload_ttl_seconds, 900);
  for (const name of ['read_knowledge_source', 'upload_knowledge_asset', 'replace_knowledge_source', 'get_knowledge_manifest']) {
    const tool = capabilities.tools.find(tool => tool.name === name);
    assert.equal(tool.allowed_by_workspace_and_connection, true, JSON.stringify(tool));
  }
  return capabilities;
}
