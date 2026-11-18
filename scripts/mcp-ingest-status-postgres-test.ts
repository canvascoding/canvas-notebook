import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import { installIngestCommitCloseFault } from './helpers/ingest-commit-close-fault';

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
  let id = 0;
  const call = async (args: Record<string, unknown>) => {
    const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
        params: { name: 'create_knowledge_source', arguments: args } }) }));
    assert.equal(response.status, 200);
    const message = await response.json(); assert.equal(message.error, undefined);
    if (message.result.structuredContent?.correlation_id) {
      assert.equal(message.result.structuredContent.correlation_id, response.headers.get('x-request-id'));
    }
    return message.result;
  };
  const content = '# Receipt test\n\nDurable source bytes.\n';
  const args = { workspace_id: workspaceId, path: 'status/created.md', idempotency_key: randomUUID() };
  const lockedArgs = { ...args, path: 'status/locked.md', idempotency_key: randomUUID() };
  const beforeLock = await fixture.snapshot();
  try {
    await admin.query('BEGIN');
    await admin.query('LOCK TABLE mcp_direct_workspace_grant IN ROW EXCLUSIVE MODE');
    const blocked = await call({ ...lockedArgs, content });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.code, 'MCP_READ_PRINCIPAL_BUSY');
    assert.equal(blocked.structuredContent.retryable, true);
    assert.equal(blocked.structuredContent.retry_after_ms, 250);
    assert.equal(blocked.structuredContent.storage_status, 'unknown');
    assert(blocked.structuredContent.operation_id);
    const blockedStatus = await call({ ...lockedArgs, action: 'status' });
    assert.equal(blockedStatus.isError, true);
    assert.equal(blockedStatus.structuredContent.code, 'MCP_READ_PRINCIPAL_BUSY');
    assert.equal(blockedStatus.structuredContent.error_code, 'MCP_READ_PRINCIPAL_BUSY');
    assert.equal(blockedStatus.structuredContent.retry_after_ms, 250);
  } finally { await admin.query('ROLLBACK'); }
  assert.deepEqual(await fixture.snapshot(), beforeLock);
  const afterLock = await call({ ...lockedArgs, content });
  assert.notEqual(afterLock.isError, true, JSON.stringify(afterLock.structuredContent));
  const sameKey = await call({ ...lockedArgs, content });
  assert.notEqual(sameKey.isError, true);
  assert.equal(sameKey.structuredContent.document_id, afterLock.structuredContent.document_id);
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
    [workspaceId, lockedArgs.path])).rows[0].count, 1);
  const absent = await call({ ...args, action: 'status' });
  assert.notEqual(absent.isError, true); assert.equal(absent.structuredContent.storage_status, 'unknown');
  assert.equal(absent.structuredContent.receipt_status, 'not_found_for_request');
  const created = await call({ ...args, content });
  assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
  const before = await fixture.snapshot();
  const status = await call({ ...args, action: 'status' });
  assert.notEqual(status.isError, true, JSON.stringify(status.structuredContent));
  assert.equal(status.structuredContent.storage_status, 'confirmed');
  assert.equal(status.structuredContent.receipt_status, 'confirmed');
  assert.equal(status.structuredContent.operation_id, created.structuredContent.operation_id);
  assert.equal(status.structuredContent.document_id, created.structuredContent.document_id);
  assert.equal(status.structuredContent.source_sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(status.structuredContent.processing_status, 'completed');
  assert.match(status.structuredContent.original_version, /^canvas-document-v1:[a-f0-9]{64}$/);
  assert.deepEqual(await fixture.snapshot(), before, 'Status must not mutate document state.');
  const wrongPath = await call({ ...args, path: 'status/other.md', action: 'status' });
  assert.equal(wrongPath.isError, true);
  assert.equal(wrongPath.structuredContent.code, 'MCP_INGEST_IDEMPOTENCY_CONFLICT');
  assert.equal(wrongPath.structuredContent.receipt_status, 'request_mismatch');
  const retry = await call({ ...args, content });
  assert.notEqual(retry.isError, true); assert.equal(retry.structuredContent.document_id, created.structuredContent.document_id);
  // Simulate a later editor projection publishing new bytes and a new inode.
  const currentProjection = path.join(fixture.workspaceRoot, args.path);
  const replacement = `${currentProjection}.replacement`;
  await writeFile(replacement, '# Later projection\n', { flag: 'wx' });
  await rename(replacement, currentProjection);
  const beforeHistorical = await fixture.snapshot();
  const historical = await call({ ...args, action: 'status' });
  assert.notEqual(historical.isError, true, JSON.stringify(historical.structuredContent));
  const { correlation_id: _original, ...originalReceipt } = status.structuredContent;
  const { correlation_id: _historical, ...historicalReceipt } = historical.structuredContent;
  assert.deepEqual(historicalReceipt, originalReceipt);
  assert.deepEqual(await fixture.snapshot(), beforeHistorical);
  const fault = installIngestCommitCloseFault();
  const interrupted = { ...args, path: 'status/after-commit.md', idempotency_key: randomUUID() };
  try {
    const recovered = await call({ ...interrupted, content });
    assert.equal(fault.fired(), true, 'The real receipt COMMIT must precede the injected cleanup failure.');
    assert.notEqual(recovered.isError, true, JSON.stringify(recovered.structuredContent));
    assert.equal(recovered.structuredContent.storage_status, 'confirmed');
    assert.equal(recovered.structuredContent.source_sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(recovered.structuredContent.processing_status, 'unconfirmed');
    const later = await call({ ...interrupted, action: 'status' });
    assert.equal(later.structuredContent.document_id, recovered.structuredContent.document_id);
    const resumed = await call({ ...interrupted, content });
    assert.notEqual(resumed.isError, true, JSON.stringify(resumed.structuredContent));
    assert.equal(resumed.structuredContent.document_id, recovered.structuredContent.document_id);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
      [workspaceId, interrupted.path])).rows[0].count, 1);
  } finally { fault.restore(); }
  const legacyArgs = { ...args, path: 'status/source.html', idempotency_key: randomUUID() };
  const legacyCreated = await call({ ...legacyArgs, content: '<p>Original HTML</p>' });
  assert.notEqual(legacyCreated.isError, true, JSON.stringify(legacyCreated.structuredContent));
  const legacyStatus = await call({ ...legacyArgs, action: 'status' });
  assert.notEqual(legacyStatus.isError, true, JSON.stringify(legacyStatus.structuredContent));
  assert.equal(legacyStatus.structuredContent.storage_status, 'confirmed');
  assert.equal(legacyStatus.structuredContent.receipt.sha256, legacyCreated.structuredContent.sha256);
  const beforeUnknown = await fixture.snapshot();
  const unknown = await call({ ...args, idempotency_key: randomUUID(), action: 'status' });
  assert.equal(unknown.structuredContent.storage_status, 'unknown');
  assert.equal(unknown.structuredContent.receipt_status, 'not_found_for_request');
  assert.equal(unknown.structuredContent.document_id, undefined);
  assert.deepEqual(await fixture.snapshot(), beforeUnknown);
  const invalidArgs = { ...args, path: 'status/invalid.md', idempotency_key: randomUUID() };
  const invalid = await call({ ...invalidArgs, content: 'Invalid\u0000text' });
  assert.equal(invalid.isError, true);
  const invalidStatus = await call({ ...invalidArgs, action: 'status' });
  assert.equal(invalidStatus.structuredContent.storage_status, 'unknown');
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
    [workspaceId, invalidArgs.path])).rows[0].count, 0);
  await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=0
    WHERE organization_id='tool-dispatch-org' AND user_id='reader'`);
  const denied = await call({ ...args, action: 'status' });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.document_id, undefined);
  console.log('PASS MCP ingest status: unknown, durable receipt, no writes, identity, request scope, retry, revoked authority');
});
