import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, symlink, truncate } from 'node:fs/promises';
import path from 'node:path';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'get_knowledge_manifest';
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const token = await fixture.issue(); let id = 0;
    const rpc = async (method: string, params: unknown) => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25', authorization: `Bearer ${token}`,
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }));
      assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.error, undefined); return body.result;
    };
    const call = (args = {}) => rpc('tools/call', { name: 'get_knowledge_manifest', arguments: { workspace_id: fixture.workspaceId, ...args } });
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'manifest-test', version: '1' } });
    const bytes = Buffer.from([0, 255, 3, 4]);
    await writeFile(path.join(fixture.workspaceRoot, 'bytes.bin'), bytes);
    await writeFile(path.join(fixture.workspaceRoot, 'other.txt'), 'other');
    await mkdir(path.join(fixture.workspaceRoot, '.private'));
    await writeFile(path.join(fixture.workspaceRoot, '.private', 'secret.txt'), 'hidden');
    await symlink('/etc/passwd', path.join(fixture.workspaceRoot, 'alias.txt'));
    let cursor: string | null = null;
    const entries = new Map();
    do {
      const response = await call({ max_entries: 1, max_depth: 0, ...(cursor ? { cursor } : {}) });
      assert.notEqual(response.isError, true); const page = response.structuredContent;
      for (const entry of page.entries) { assert(!entries.has(entry.path)); entries.set(entry.path, entry); }
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual([...entries.keys()], ['bytes.bin', 'other.txt']);
    const first = entries.get('bytes.bin');
    assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(first.size, bytes.length); assert.equal(first.revision, `sha256:${first.sha256}`);
    assert.equal(first.hash_basis, 'original_file_bytes'); assert.ok(first.document_url);
    const before = (await call({ max_entries: 1, max_depth: 0 })).structuredContent;
    await writeFile(path.join(fixture.workspaceRoot, 'added.txt'), 'changed');
    const changed = await call({ max_entries: 1, max_depth: 0, cursor: before.next_cursor });
    assert.equal(changed.isError, true); assert.equal(changed.structuredContent.code, 'WORKSPACE_TREE_CHANGED');
    const huge = path.join(fixture.workspaceRoot, 'huge.bin'); await writeFile(huge, ''); await truncate(huge, 101 * 1024 * 1024);
    const page = (await call()).structuredContent;
    assert.equal(page.entries.find((entry: { path: string }) => entry.path === 'huge.bin').error, 'MANIFEST_FILE_TOO_LARGE');
    await fixture.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1', [fixture.workspaceId]);
    assert.equal((await call()).isError, true);
    console.log('PASS manifest: binary SHA/size/revision/link, pages, hidden and symlink exclusion, changed cursor, bounded hash, revoked grant');
  });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
