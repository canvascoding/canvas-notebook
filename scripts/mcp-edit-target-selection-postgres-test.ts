import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';

type Node = { attrs?: { id?: string }; content?: Node[] };
await withDocumentReadToolDispatchFixture(async fixture => {
  const target = await fixture.seed({ representation: 'tiptap_blocks',
    text: Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ${'Large source text. '.repeat(30)}`).join('\n\n') });
  const token = await fixture.issue();
  const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
  let id = 0;
  const call = async (extra: Record<string, unknown> = {}) => {
    const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: {
        name: 'read_knowledge_source', arguments: { workspace_id: fixture.workspaceId, document_id: target.documentId, ...extra },
      } }) }));
    assert.equal(response.status, 200);
    const message = await response.json(); assert.equal(message.error, undefined);
    return message.result;
  };
  const read = async (extra: Record<string, unknown> = {}): Promise<DocumentReadPageV1> => {
    const result = await call(extra); assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const initial = await read({ max_bytes: 262144 }); assert(initial.complete);
  const body = JSON.parse(initial.fragment);
  const ids: string[] = [];
  const visit = (node: Node) => { if (node.attrs?.id) ids.push(node.attrs.id); for (const child of node.content ?? []) visit(child); };
  visit(body.content.document); assert.equal(ids.length, 200);
  const whole = await call({ include_edit_targets: true, max_bytes: 4 });
  assert.equal(whole.isError, true); assert.equal(whole.structuredContent.code, 'DOCUMENT_TOO_LARGE');
  const baseline = await fixture.snapshot();
  const selected = (block: string) => ({ include_edit_targets: true, edit_target_block_id: block,
    expected_version: initial.document.version });
  const seen = new Set<string>();
  for (const block of ids) {
    const page = await read(selected(block)); assert(page.complete); assert(page.totalBytes < 2048);
    const targetBody = JSON.parse(page.fragment); assert.equal(targetBody.content, undefined);
    assert.equal(targetBody.editTargetBlockId, block); assert.equal(targetBody.editTargets.length, 1);
    assert.equal(targetBody.editTargets[0].id, block); assert.match(targetBody.editTargets[0].subtreeHash, /^[a-f0-9]{64}$/);
    assert(!seen.has(block)); seen.add(block);
  }
  assert.equal(seen.size, 200); assert.deepEqual(await fixture.snapshot(), baseline);
  const first = await read({ ...selected(ids[0]), max_bytes: 32 }); assert(first.nextCursor);
  const changedSelection = await call({ ...selected(ids[1]), max_bytes: 32, cursor: first.nextCursor });
  assert.equal(changedSelection.isError, true); assert.equal(changedSelection.structuredContent.code, 'DOCUMENT_VERSION_CONFLICT');
  let fragments = first.fragment, cursor = first.nextCursor;
  while (cursor) { const page = await read({ ...selected(ids[0]), max_bytes: 32, cursor }); fragments += page.fragment; cursor = page.nextCursor; }
  assert.equal(JSON.parse(fragments).editTargets[0].id, ids[0]);
  await fixture.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 AND workspace_id=$2', [fixture.clientId, fixture.workspaceId]);
  const denied = await call({ ...selected(ids[0]), max_bytes: 32, cursor: first.nextCursor });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.code, 'ACCESS_DENIED');
  await fixture.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'reader',$2,100,100)`, [fixture.clientId, fixture.workspaceId]);
  const stale = await call({ ...selected(ids[0]), expected_version: `canvas-document-v1:${'f'.repeat(64)}`, cursor: first.nextCursor });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.code, 'DOCUMENT_VERSION_CONFLICT');
  // Advance actual persisted Yjs content in the isolated fixture, then prove
  // that an old target continuation cannot cross the version change.
  const { Y } = await import('../app/lib/collaboration/server-runtime');
  const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
  const { getSchema } = await import('@tiptap/core');
  const { richMarkdownSchemaExtensions } = await import('../app/lib/collaboration/markdown-state');
  const doc = new Y.Doc({ gc: false });
  try {
    const row = (await fixture.admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
    Y.applyUpdate(doc, new Uint8Array(row.yjs_state));
    const schema = getSchema(richMarkdownSchemaExtensions());
    new CollaborationBlockTree(doc, schema).updateInlineContent(ids[0], schema.nodeFromJSON({ type: 'paragraph',
      attrs: { id: ids[0] }, content: [{ type: 'text', text: 'Changed in native fixture' }] }), 'target-version-fixture');
    await fixture.admin.query('UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,document_sequence=document_sequence+1,persisted_at=101 WHERE document_id=$1',
      [target.documentId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
    const changed = await call({ ...selected(ids[0]), cursor: first.nextCursor });
    assert.equal(changed.isError, true); assert.equal(changed.structuredContent.code, 'DOCUMENT_VERSION_CONFLICT');
    const fresh = await read({ max_bytes: 262144 }); assert.notEqual(fresh.document.version, initial.document.version);
    const freshTarget = await read({ ...selected(ids[0]), expected_version: fresh.document.version });
    assert.equal(JSON.parse(freshTarget.fragment).editTargets[0].id, ids[0]);
  } finally { doc.destroy(); }
  console.log('PASS selected edit-target HTTP/PG: 200 unique targets beyond full-list limit, no body/state writes, bounded continuation, selection/version/access rejection');
});
