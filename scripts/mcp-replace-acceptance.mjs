import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function verifyReplaceAcceptance(call, document, key) {
  const ok = response => {
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent;
  };
  const original = ok(await call('read_knowledge_source', { path: document.path, max_characters: 100000 }));
  assert.equal(original.truncated, false);
  const content = original.content.replace('Unicode', 'Replaced via complete Markdown');
  const args = { path: document.path, content, expected_sha256: original.sha256, idempotency_key: key };
  const applied = ok(await call('replace_knowledge_source', args));
  assert.equal(applied.status, 'applied');
  assert.equal(applied.authoritative_updated, true);
  const expected = createHash('sha256').update(content).digest('hex');
  assert.equal(applied.after_sha256, expected);
  const retry = ok(await call('replace_knowledge_source', args));
  assert.equal(retry.operation_id, applied.operation_id);
  const read = ok(await call('read_knowledge_source', { path: document.path, max_characters: 100000 }));
  assert.equal(read.content, content);
  assert.equal(read.sha256, expected);
  const stale = await call('replace_knowledge_source', { ...args, idempotency_key: `${key}-stale` });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.code, 'FILE_REVISION_CONFLICT');
  const conflict = await call('replace_knowledge_source', { ...args, content: 'different request' });
  assert.equal(conflict.isError, true);
  return applied;
}
