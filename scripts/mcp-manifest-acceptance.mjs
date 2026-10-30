import assert from 'node:assert/strict';
export async function verifyManifestAcceptance(call, paths) {
  const found = new Map(); let cursor;
  do {
    const result = await call('get_knowledge_manifest', { max_entries: 1, max_depth: 0, ...(cursor ? { cursor } : {}) });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    for (const row of result.structuredContent.entries) {
      assert(!found.has(row.path)); found.set(row.path, row);
      assert.match(row.sha256, /^[a-f0-9]{64}$/u); assert.equal(row.revision, `sha256:${row.sha256}`);
      assert.equal(row.hash_basis, 'original_file_bytes'); assert.ok(row.document_url);
    }
    cursor = result.structuredContent.next_cursor;
  } while (cursor);
  for (const path of paths) {
    const row = found.get(path); assert.ok(row);
    const read = await call('read_knowledge_source', { path });
    assert.notEqual(read.isError, true);
    assert.equal(row.document.sha256, read.structuredContent.sha256);
    assert.equal(row.document.hash_basis, 'authoritative_markdown_utf8');
  }
}
