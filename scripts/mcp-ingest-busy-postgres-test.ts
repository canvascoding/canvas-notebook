import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

await withDocumentReadToolDispatchFixture(async fixture => {
  const { admin, workspaceId, clientId } = fixture;
  process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
  process.env.FILE_VERSION_CENTER_MODE = 'shadow';
  process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,create_knowledge_source,import_knowledge_file';
  await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
    WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`);
  await admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id=$3',
    [JSON.stringify(['knowledge:read', 'knowledge:write']), clientId, 'reader']);
  const token = await fixture.issue({ scope: 'knowledge:read knowledge:write' });
  const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
  const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
  const lock = collaborationAdmissionLockKey(workspaceId);
  let id = 0;
  const call = async (args: Record<string, unknown>) => {
    const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
        params: { name: 'create_knowledge_source', arguments: args } }) }));
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.error, undefined, 'A lifecycle conflict is a tool result, not INVALID_ARGUMENT/JSON-RPC InvalidParams.');
    return message.result;
  };
  const args = { workspace_id: workspaceId, path: 'busy/one.md', idempotency_key: randomUUID(), content: '# Retry safely\n' };
  const expectedId = createHash('sha256').update(JSON.stringify([clientId, 'reader', workspaceId, args.idempotency_key])).digest('hex');
  await admin.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
  try {
    const busy = await call(args);
    assert.equal(busy.isError, true);
    assert.equal(busy.structuredContent.code, 'COLLABORATION_FILE_LIFECYCLE_BUSY');
    assert.equal(busy.structuredContent.error_code, busy.structuredContent.code);
    assert.equal(busy.structuredContent.retryable, true);
    assert.equal(busy.structuredContent.retry_after_ms, 250);
    assert.equal(busy.structuredContent.phase, 'admission');
    assert.equal(busy.structuredContent.operation_id, expectedId);
    assert.equal(busy.structuredContent.storage_status, 'unknown');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
      [workspaceId, args.path])).rows[0].count, 0);
  } finally { await admin.query('SELECT pg_advisory_unlock($1::bigint)', [lock]); }
  const created = await call(args);
  assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
  assert.equal(created.structuredContent.operation_id, expectedId);
  const repeated = await call(args);
  assert.equal(repeated.structuredContent.document_id, created.structuredContent.document_id);
  // A new attempt can be busy even though the original operation completed.
  await admin.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
  try {
    const recovered = await call(args);
    assert.notEqual(recovered.isError, true, JSON.stringify(recovered.structuredContent));
    assert.equal(recovered.structuredContent.storage_status, 'confirmed');
    assert.equal(recovered.structuredContent.processing_status, 'completed');
    assert.equal(recovered.structuredContent.processing_error_code, undefined);
    assert.equal(recovered.structuredContent.attempt_error_code, 'COLLABORATION_FILE_LIFECYCLE_BUSY');
    assert.equal(recovered.structuredContent.document_id, created.structuredContent.document_id);
  } finally { await admin.query('SELECT pg_advisory_unlock($1::bigint)', [lock]); }
  for (let index = 0; index < 12; index++) {
    // Short real read fences overlap each Create. The writer must wait and
    // release its own session lease before the next sequential operation.
    await admin.query('SELECT pg_advisory_lock_shared($1::bigint)', [lock]);
    const release = new Promise<void>((resolve, reject) => setTimeout(() => {
      admin.query('SELECT pg_advisory_unlock_shared($1::bigint)', [lock]).then(() => resolve(), reject);
    }, 150));
    try {
      const next = await call({ ...args, path: `busy/sequential-${index}.md`, idempotency_key: randomUUID() });
      assert.notEqual(next.isError, true, JSON.stringify(next.structuredContent));
    } finally { await release; }
  }
  const { executeDirectMcpIngestTool } = await import('../app/lib/mcp/server/ingest-tools');
  const abort = new AbortController();
  const abortedArgs = { ...args, path: 'busy/aborted.md', idempotency_key: randomUUID() };
  await admin.query('SELECT pg_advisory_lock_shared($1::bigint)', [lock]);
  const cancel = setTimeout(() => abort.abort(), 50);
  const release = new Promise<void>((resolve, reject) => setTimeout(() => {
    admin.query('SELECT pg_advisory_unlock_shared($1::bigint)', [lock]).then(() => resolve(), reject);
  }, 250));
  try {
    const cancelled = await executeDirectMcpIngestTool('create_knowledge_source', abortedArgs,
      { token, clientId: 'untrusted', scopes: [] }, abort.signal);
    assert.equal(cancelled.isError, true);
  } finally { clearTimeout(cancel); await release; }
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
    [workspaceId, abortedArgs.path])).rows[0].count, 0);
  const afterAbort = await call(abortedArgs);
  assert.notEqual(afterAbort.isError, true, JSON.stringify(afterAbort.structuredContent));
  assert.equal((await admin.query(`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory'
    AND pid=pg_backend_pid()`)).rows[0].count, 0);
  console.log('PASS MCP busy: real contention, structured retry, stable operation, no duplicate, 12 sequential writes with read fences, cancellation and retry');
});
