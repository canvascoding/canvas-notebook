import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, symlink, truncate, lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import { filesystemFileVersion } from '../app/lib/filesystem/file-version';

async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'get_knowledge_manifest,list_knowledge_tree,get_workspace_overview';
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const scopes = ['workspace:list', 'knowledge:tree', 'knowledge:read'];
    await fixture.admin.query('UPDATE oauth_consent SET scopes=$1', [JSON.stringify(scopes)]);
    const token = await fixture.issue({ scope: scopes.join(' ') }); let id = 0;
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
    const tree = await rpc('tools/call', { name: 'list_knowledge_tree', arguments: { workspace_id: fixture.workspaceId, max_depth: 0 } });
    assert.notEqual(tree.isError, true);
    assert.deepEqual(tree.structuredContent.entries.map((entry: { path: string }) => entry.path), ['bytes.bin', 'other.txt']);
    assert(tree.structuredContent.entries.every((entry: { document_url?: string }) => entry.document_url));
    const overview = await rpc('tools/call', { name: 'get_workspace_overview', arguments: { workspace_id: fixture.workspaceId } });
    assert.notEqual(overview.isError, true); assert.equal(overview.structuredContent.workspace.id, fixture.workspaceId);
    assert.deepEqual(overview.structuredContent.contents, { top_level_files: 2, top_level_folders: 0, file_types: ['bin', 'txt'] });
    assert(overview.structuredContent.capabilities.tools.some((tool: { name: string; allowed_by_workspace_and_connection: boolean }) =>
      tool.name === 'list_knowledge_tree' && tool.allowed_by_workspace_and_connection));
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
    assert.equal(first.file_version, filesystemFileVersion(await lstat(path.join(fixture.workspaceRoot, 'bytes.bin'))));
    assert.equal(first.hash_basis, 'original_file_bytes'); assert.ok(first.document_url);
    const replacement = path.join(fixture.workspaceRoot, '.replacement-bytes.bin');
    await writeFile(replacement, bytes); await rename(replacement, path.join(fixture.workspaceRoot, 'bytes.bin'));
    const replaced = (await call()).structuredContent.entries.find((entry: { path: string }) => entry.path === 'bytes.bin');
    assert.equal(replaced.sha256, first.sha256); assert.equal(replaced.revision, first.revision);
    assert.notEqual(replaced.file_version, first.file_version);
    assert.equal(replaced.file_version, filesystemFileVersion(await lstat(path.join(fixture.workspaceRoot, 'bytes.bin'))));
    const before = (await call({ max_entries: 1, max_depth: 0 })).structuredContent;
    await writeFile(path.join(fixture.workspaceRoot, 'added.txt'), 'changed');
    const changed = await call({ max_entries: 1, max_depth: 0, cursor: before.next_cursor });
    assert.equal(changed.isError, true); assert.equal(changed.structuredContent.code, 'WORKSPACE_TREE_CHANGED');
    const huge = path.join(fixture.workspaceRoot, 'huge.bin'); await writeFile(huge, ''); await truncate(huge, 101 * 1024 * 1024);
    const page = (await call()).structuredContent;
    const oversized = page.entries.find((entry: { path: string }) => entry.path === 'huge.bin');
    assert.equal(oversized.error, 'MANIFEST_FILE_TOO_LARGE'); assert.equal(oversized.file_version, null);
    await fixture.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1', [fixture.workspaceId]);
    assert.equal((await call()).isError, true);
    console.log('PASS shared overview/tree/manifest: real OAuth/workspace authority, metadata and links, binary SHA/size/revision, pages, hidden and symlink exclusion, changed cursor, bounded hash, revoked grant');
  });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
