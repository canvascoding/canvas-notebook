import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Same acceptance contract for HTTP MCP and the installed Codex client. */
export async function verifyUploadAcceptance(call, nonce, restart) {
  const bytes = Buffer.from([0, 255, 17, 3, 0, 240, 14, 1]);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const success = result => { assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent)); return result.structuredContent; };
  const upload = async args => call('upload_knowledge_asset', args);
  const begin = { operation: 'begin', path: `upload-${nonce}.bin`, size: bytes.length, sha256: hash(bytes), idempotency_key: `upload-${nonce}` };
  const first = success(await upload(begin));
  assert.equal(success(await upload(begin)).upload_id, first.upload_id);
  const chunk = { operation: 'chunk', upload_id: first.upload_id, offset: 0, data_base64: bytes.subarray(0, 4).toString('base64') };
  const failed = await upload({ ...chunk, chunk_sha256: '0'.repeat(64) });
  assert.equal(failed.isError, true); assert.equal(failed.structuredContent.code, 'UPLOAD_CHUNK_CHECKSUM_MISMATCH');
  assert.equal(success(await upload({ ...chunk, chunk_sha256: hash(bytes.subarray(0, 4)) })).next_offset, 4);
  assert.equal(success(await upload(chunk)).already_received, true);
  if (restart) await restart();
  assert.equal(success(await upload({ operation: 'status', upload_id: first.upload_id })).next_offset, 4);
  const resumed = success(await upload(begin)); assert.equal(resumed.upload_id, first.upload_id); assert.equal(resumed.next_offset, 4);
  success(await upload({ operation: 'chunk', upload_id: first.upload_id, offset: 4, data_base64: bytes.subarray(4).toString('base64') }));
  const receipt = success(await upload({ operation: 'complete', upload_id: first.upload_id }));
  assert.equal(receipt.after_sha256, begin.sha256); assert.equal(receipt.total_size, bytes.length); assert.ok(receipt.document_url);
  assert.equal(success(await upload({ operation: 'complete', upload_id: first.upload_id })).already_completed, true);
  assert.equal(success(await upload(begin)).state, 'completed');
  const conflict = await upload({ ...begin, sha256: '0'.repeat(64) });
  assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.code, 'UPLOAD_IDEMPOTENCY_CONFLICT');
  return { path: receipt.path, sha256: receipt.after_sha256, size: receipt.total_size, restarted: Boolean(restart) };
}
