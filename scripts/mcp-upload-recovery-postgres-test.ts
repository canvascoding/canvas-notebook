import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

type Row = Record<string, unknown>;
function record(value: unknown): Row { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; }
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'upload_knowledge_asset';
    await fixture.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await fixture.admin.query('UPDATE oauth_consent SET scopes=$1', [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write'])]);
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { withUploadBeginReceipt } = await import('../app/lib/mcp/server/upload-begin-receipt');
    const token = await fixture.issue({ scope: 'knowledge:write', exp: Math.floor(Date.now() / 1000) + 3600 });
    let id = 0;
    const rpc = async (method: string, params: Row): Promise<Row> => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25', authorization: `Bearer ${token}`,
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }));
      assert.equal(response.status, 200); const body = await response.json();
      assert.equal(body.error, undefined, JSON.stringify(body.error)); return body.result;
    };
    const call = (args: Row) => rpc('tools/call', { name: 'upload_knowledge_asset', arguments: { workspace_id: fixture.workspaceId, ...args } });
    const success = (value: Row): Row => { assert.notEqual(value.isError, true, JSON.stringify(value.structuredContent)); return record(value.structuredContent); };
    const failure = (value: Row, code: string) => { assert.equal(value.isError, true); assert.equal(record(value.structuredContent).code, code); };
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'upload-acceptance', version: '1' } });
    const catalog = await rpc('tools/list', {});
    assert(Array.isArray(catalog.tools));
    const schema = record(record(catalog.tools.find(tool => record(tool).name === 'upload_knowledge_asset')).inputSchema);
    const properties = record(schema.properties);
    for (const key of ['workspace_id', 'path', 'size', 'sha256', 'upload_id', 'data_base64', 'chunk_sha256', 'idempotency_key']) assert.ok(properties[key]);
    assert.equal(schema.oneOf, undefined); assert(Array.isArray(record(properties.operation).enum)); assert.ok((record(properties.operation).enum as unknown[]).includes('status'));
    const bytes = Buffer.from([0, 255, 17, 3, 0, 240, 14, 1]);
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const request = { operation: 'begin', path: 'recovery.bin', size: bytes.length, sha256: hash(bytes), idempotency_key: 'upload-recovery-1' };
    const [first, concurrent] = (await Promise.all([call(request), call(request)])).map(success);
    assert.equal(first.upload_id, concurrent.upload_id);
    assert.equal(first.already_started || concurrent.already_started, true);
    failure(await call({ ...request, sha256: '0'.repeat(64) }), 'UPLOAD_IDEMPOTENCY_CONFLICT');
    const chunk = { operation: 'chunk', upload_id: first.upload_id, offset: 0, data_base64: bytes.subarray(0, 4).toString('base64') };
    failure(await call({ ...chunk, chunk_sha256: '0'.repeat(64) }), 'UPLOAD_CHUNK_CHECKSUM_MISMATCH');
    assert.equal(success(await call({ operation: 'status', upload_id: first.upload_id })).next_offset, 0);
    assert.equal(success(await call({ ...chunk, chunk_sha256: hash(bytes.subarray(0, 4)) })).next_offset, 4);
    assert.equal(success(await call(chunk)).already_received, true);
    assert.equal(success(await call(request)).next_offset, 4);
    success(await call({ operation: 'chunk', upload_id: first.upload_id, offset: 4, data_base64: bytes.subarray(4).toString('base64') }));
    const completed = success(await call({ operation: 'complete', upload_id: first.upload_id }));
    assert.equal(completed.after_sha256, request.sha256);
    assert.deepEqual(await readFile(path.join(fixture.workspaceRoot, request.path)), bytes);
    assert.equal(success(await call({ operation: 'complete', upload_id: first.upload_id })).already_completed, true);
    assert.equal(success(await call(request)).state, 'completed');
    assert.equal(success(await call({ operation: 'status', upload_id: first.upload_id })).state, 'completed');
    assert.deepEqual((await readdir(fixture.workspaceRoot)).filter(name => name.endsWith('.bin')), ['recovery.bin']);
    await writeFile(path.join(fixture.workspaceRoot, request.path), Buffer.from([0, 1]));
    failure(await call({ operation: 'status', upload_id: first.upload_id }), 'FILE_REVISION_CONFLICT');
    const incorrect = success(await call({ ...request, path: 'bad-hash.bin', idempotency_key: 'upload-wrong-hash', sha256: '0'.repeat(64) }));
    success(await call({ operation: 'chunk', upload_id: incorrect.upload_id, offset: 0, data_base64: bytes.toString('base64') }));
    failure(await call({ operation: 'complete', upload_id: incorrect.upload_id }), 'UPLOAD_CHECKSUM_MISMATCH');
    await assert.rejects(readFile(path.join(fixture.workspaceRoot, 'bad-hash.bin')), { code: 'ENOENT' });
    const cancelled = success(await call({ ...request, path: 'abort.bin', idempotency_key: 'upload-abort-key' }));
    success(await call({ operation: 'abort', upload_id: cancelled.upload_id }));
    const afterAbort = await call({ operation: 'status', upload_id: cancelled.upload_id }); assert.equal(afterAbort.isError, true);
    // A genuinely persisted prepared receipt must never create a second session.
    let creates = 0;
    const uncertain = { workspaceId: fixture.workspaceId, principalBinding: 'test-binding', key: 'crash-before-receipt', request: ['original'],
      create: async (): Promise<{ uploadId: string }> => { creates++; throw new Error('simulated lost acknowledgement'); },
      resume: async () => ({ uploadId: 'unused' }) };
    await assert.rejects(withUploadBeginReceipt(uncertain), /lost acknowledgement/);
    await assert.rejects(withUploadBeginReceipt(uncertain), { code: 'UPLOAD_STATE_UNCONFIRMED' }); assert.equal(creates, 1);
    const durable = { workspaceId: fixture.workspaceId, principalBinding: 'restart-binding', key: 'restart-receipt-1', request: ['same'] };
    await withUploadBeginReceipt({ ...durable, create: async () => ({ uploadId: 'original-durable-handle' }),
      resume: async () => { throw new Error('First begin must create'); } });
    const childSource = `const imported = await import('./app/lib/mcp/server/upload-begin-receipt.ts');
      const { withUploadBeginReceipt } = imported.default ?? imported;
      const value = await withUploadBeginReceipt({ ...JSON.parse(process.argv[1]),
        create: async () => { throw Error('A new process must not create a duplicate'); },
        resume: async uploadId => ({ uploadId }) });
      if (value.uploadId !== 'original-durable-handle') throw Error('Lost durable handle');
      console.log('durable receipt resumed');`;
    const child = await promisify(execFile)(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module',
      '-e', childSource, JSON.stringify(durable)], { cwd: process.cwd(), env: process.env });
    assert.match(child.stdout, /durable receipt resumed/);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 16 * 60 * 1000;
      failure(await call({ operation: 'status', upload_id: first.upload_id }), 'UPLOAD_EXPIRED');
    } finally { Date.now = realNow; }
    // Current permission is checked even when a durable handle exists.
    await fixture.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1', [fixture.workspaceId]);
    assert.equal((await call({ operation: 'status', upload_id: first.upload_id })).isError, true);
    console.log('PASS upload: flat schema, concurrent begin, conflict, durable resume, chunk hash/retry, original hash, completion retry, changed destination, abort and revoked grant');
  });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
