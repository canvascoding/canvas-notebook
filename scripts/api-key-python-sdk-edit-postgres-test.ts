import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';

let stage = 'setup';
async function main() {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
  assert(python && path.isAbsolute(python)); assert(wheel && path.isAbsolute(wheel) && wheel.endsWith('.whl'));
  const wheelStat = await lstat(wheel); assert(wheelStat.isFile() && !wheelStat.isSymbolicLink());
  const wheelSha256 = createHash('sha256').update(await readFile(wheel)).digest('hex');
  const probe = path.resolve('scripts/helpers/python_sdk_api_key_edit_probe.py');
  const probeSha256 = createHash('sha256').update(await readFile(probe)).digest('hex');
  const sourceRoot = path.resolve('packages/canvas-notebook-python/src/canvas_notebook'), sourceHashes: Record<string, string> = {};
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) if (entry.isFile() && (entry.name.endsWith('.py') || entry.name === 'py.typed')) {
    sourceHashes[`canvas_notebook/${entry.name}`] = createHash('sha256').update(await readFile(path.join(sourceRoot, entry.name))).digest('hex');
  }
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,edit_knowledge_source' });
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const { handleDirectMcpPost, handleDirectMcpUnsupportedMethod, handleDirectMcpOptions } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { flushCollaborationDocuments } = await import('../server/collaboration-server');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const headers = new Headers((await h.request(h.source, 'owner')).headers); headers.set('Origin', 'http://localhost');
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Installed native Edit SDK',
      workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
    let currentCredentialId = issued.credential.id, currentKey = issued.key;
    const other = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Another native Edit integration',
      workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
    // A second real manager session allows revocation after removing the issuer.
    const manager = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('sdk-management-session',$1,'owner',$2,$3,$3)",
      [manager, Date.now() + 3_600_000, Date.now()]);
    const text = 'Before native installed SDK edit Äpfel 😀 日本語.';
    const filePath = 'sdk/native-key-edit.md', target = await h.upload(filePath, Buffer.from('Native SDK edit projection seed.'));
    const doc = createPlainTextYDoc(text);
    try { await h.admin.query(`UPDATE collaboration_yjs_states SET representation='plain_text',yjs_state=$2,state_vector=$3,
      document_sequence=document_sequence+1,checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL
      WHERE document_id=$1`, [target.documentId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]); }
    finally { doc.destroy(); }
    await unlink(path.join(h.source.rootPath, filePath));
    const protectedPath = 'sdk/protected.md', protectedBytes = Buffer.from('Unchanged native control.');
    const protectedDoc = await h.upload(protectedPath, protectedBytes);
    const protectedSnapshot = async () => ({
      document: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [protectedDoc.documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [protectedDoc.documentId])).rows,
      bytes: await readFile(path.join(h.source.rootPath, protectedPath)),
    });
    const protectedBefore = await protectedSnapshot();
    const receipt = async (operationId: string) => (await h.admin.query(`SELECT operation_id,actor_id,actor_session_id,native_edit_original_json,
      native_edit_after_json FROM collaboration_agent_operations WHERE operation_id=$1`, [operationId])).rows[0];
    const operationCount = async () => Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_agent_operations')).rows[0].n);
    await withNativeApiKeyEditRuntime(h, async ({ server, origin }) => {
      const requests = new Set<Promise<void>>(), errors: unknown[] = [], statuses: number[] = [];
      let keyHeaders = 0, protocolHeaders = 0, lostAckArmed = false, droppedAcks = 0, lostAckCalls = 0;
      server.on('request', (incoming, outgoing) => {
        const operation = (async () => {
          const chunks: Buffer[] = []; let size = 0;
          for await (const raw of incoming) { const chunk = Buffer.from(raw); size += chunk.length; assert(size <= 32768); chunks.push(chunk); }
          assert.equal(incoming.url, '/mcp'); const actual = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) actual.set(name, Array.isArray(value) ? value.join(',') : value);
          assert(actual.has('x-canvas-api-key')); keyHeaders++;
          assert(!actual.has('authorization') && !actual.has('cookie'));
          if (actual.has('mcp-protocol-version')) protocolHeaders++;
          const body = Buffer.concat(chunks), rpc = incoming.method === 'POST' ? JSON.parse(body.toString()) : null;
          const lostWrite = rpc?.method === 'tools/call' && rpc.params?.name === 'edit_knowledge_source'
            && rpc.params.arguments?.action === 'edit' && rpc.params.arguments?.idempotency_key === 'sdk-key-lost-ack-1';
          if (lostWrite) lostAckCalls++;
          const request = new Request(`${origin}/mcp`, { method: incoming.method, headers: actual,
            ...(incoming.method === 'POST' ? { body } : {}) });
          const response = incoming.method === 'POST' ? await handleDirectMcpPost(request)
            : incoming.method === 'OPTIONS' ? await handleDirectMcpOptions(request) : await handleDirectMcpUnsupportedMethod(request);
          const responseBody = Buffer.from(await response.arrayBuffer()); statuses.push(response.status);
          if (lostAckArmed && lostWrite) {
            const result = JSON.parse(responseBody.toString()).result?.structuredContent;
            assert.equal(response.status, 200); assert.equal(result?.state, 'confirmed');
            lostAckArmed = false; droppedAcks++; outgoing.destroy(); return;
          }
          outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(responseBody);
        })().catch(error => { errors.push(error); if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); });
        requests.add(operation); void operation.finally(() => requests.delete(operation));
      });
      const child = spawn(python, ['-I', probe], { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let remainder = '', stdoutBytes = 0, stderrBytes = 0, complete = false, verified = false, chain = Promise.resolve();
      let initialId = '', originalReceipt: unknown, reducedCount = 0, preLossCount = 0;
      let preLossIds: string[] = [];
      const milestones: string[] = [];
      const send = (value: unknown) => { assert(!child.stdin.destroyed); child.stdin.write(JSON.stringify(value) + '\n'); };
      const marker = async (line: string) => {
        const value = JSON.parse(line); assert(value && typeof value === 'object' && typeof value.event === 'string');
        milestones.push(value.event); stage = value.event;
        if (value.event === 'wheel_verified') { assert.equal(value.sha256, wheelSha256); verified = true; }
        else if (value.event === 'ready_rotate') {
          initialId = value.operationId; assert.match(initialId, /^[A-Za-z0-9._:-]{1,128}$/u);
          originalReceipt = await receipt(initialId); assert.equal(await operationCount(), 1);
          const rotated = await rotateApiKey(headers, issued.integration.id, { expectedRevision: 1, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
          currentCredentialId = rotated.credential.id; currentKey = rotated.key; send({ key: rotated.key });
        } else if (value.event === 'ready_other_integration') {
          assert.deepEqual(await receipt(initialId), originalReceipt); assert.equal(await operationCount(), 1); send({ key: other.key });
        } else if (value.event === 'ready_reduce') {
          await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
            workspaceIds: [h.source.workspaceId], actions: ['read', 'status'] }); reducedCount = await operationCount(); send({ ready: true });
        } else if (value.event === 'ready_logout') {
          assert.equal(await operationCount(), reducedCount); assert.deepEqual(await receipt(initialId), originalReceipt);
          await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 3, name: issued.integration.name,
            workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'] });
          assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-owner'")).rowCount, 1);
          headers.set('Authorization', `Bearer ${manager}`); send({ ready: true });
        } else if (value.event === 'ready_ack_loss') {
          assert.equal(await operationCount(), 2); preLossCount = await operationCount();
          preLossIds = (await h.admin.query('SELECT operation_id FROM collaboration_agent_operations')).rows.map(row => row.operation_id);
          lostAckArmed = true; send({ ready: true });
        } else if (value.event === 'write_ack_lost') {
          assert.equal(lostAckCalls, 1); assert.equal(droppedAcks, 1); assert.equal(lostAckArmed, false);
          await flushCollaborationDocuments(); assert.equal(await operationCount(), preLossCount + 1);
          const rows = (await h.admin.query('SELECT operation_id,actor_session_id FROM collaboration_agent_operations WHERE operation_id<>ALL($1::text[])', [preLossIds])).rows;
          assert.equal(rows.length, 1); const found = rows[0]; assert.equal(found.actor_session_id, null);
          const persisted = (await h.admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
          const snapshot = new Y.Doc();
          try { Y.applyUpdate(snapshot, persisted.yjs_state); assert.equal(snapshot.getText('content').toString(),
            text.replace('Before', 'After') + ' after-logout ack-lost'); } finally { snapshot.destroy(); }
          send({ operationId: found.operation_id, key: currentKey });
        } else if (value.event === 'ready_revoke') {
          assert.equal(lostAckCalls, 2); assert.equal(await operationCount(), 3); assert.deepEqual(await receipt(initialId), originalReceipt);
          await revokeApiKey(headers, issued.integration.id, { expectedRevision: 4, credentialId: currentCredentialId });
          await revokeApiKey(headers, other.integration.id, { expectedRevision: 1, credentialId: other.credential.id }); send({ ready: true });
        } else if (value.event === 'complete') { assert.equal(value.groups, 6); assert.equal(value.oauthIssuance, false); assert.equal(value.compiledNext, false); complete = true; }
        else assert.fail('Unexpected SDK edit milestone.');
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length; if (stdoutBytes > 8192) { errors.push(new Error('SDK stdout exceeds bound.')); child.kill('SIGTERM'); return; }
        remainder += chunk.toString(); let newline: number;
        while ((newline = remainder.indexOf('\n')) >= 0) { const line = remainder.slice(0, newline); remainder = remainder.slice(newline + 1); chain = chain.then(() => marker(line)); }
        void chain.catch(error => { errors.push(error); child.kill('SIGTERM'); });
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) child.kill('SIGTERM'); });
      child.stdin.on('error', error => { errors.push(error); });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      const timeout = setTimeout(() => { errors.push(new Error('SDK edit probe deadline exceeded.')); child.kill('SIGKILL'); }, 90000);
      try {
        send({ endpoint: `${origin}/mcp`, key: issued.key, workspaceId: h.source.workspaceId, documentId: target.documentId, text,
          wheelUri: pathToFileURL(wheel).href, wheelSha256, sourceHashes });
        const exit = await closed; await chain; assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(errors.length, 0);
        assert.equal(remainder, ''); assert(complete && verified); assert(keyHeaders > 20 && protocolHeaders > 0);
        assert.equal(statuses.filter(status => status === 401).length, 2); assert.equal(droppedAcks, 1);
        assert.deepEqual(milestones, ['wheel_verified', 'ready_rotate', 'ready_other_integration', 'ready_reduce', 'ready_logout',
          'ready_ack_loss', 'write_ack_lost', 'ready_revoke', 'complete']);
        assert.deepEqual(await protectedSnapshot(), protectedBefore);
        assert.equal(createHash('sha256').update(await readFile(wheel)).digest('hex'), wheelSha256);
        assert.equal(createHash('sha256').update(await readFile(probe)).digest('hex'), probeSha256);
        console.log(JSON.stringify({ suite: 'installed-api-key-sdk-native-edit-http', passed: true, groups: 6, wheelSha256,
          protectedNativeDocumentUnchanged: true, keyHeaderOnlyRequests: keyHeaders, actual401: 2, droppedWriteAcknowledgements: 1,
          automaticWriteReplays: 0, operationCount: 3, stderrBytes, compiledNext: false, oauthIssuance: false, reviewCenterEnabled: false }));
      } finally {
        if (!complete) console.error(JSON.stringify({ suite: 'installed-api-key-sdk-native-edit-http', stage,
          reached: milestones, keyHeaderOnlyRequests: keyHeaders, lostAckArmed, lostAckCalls, droppedAcks, stderrBytes,
          bridgeErrors: errors.map(error => error instanceof Error ? error.name : 'UnknownError') }));
        clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
        child.stdin.destroy(); await Promise.allSettled([...requests]);
      }
    });
  });
}
main().catch(error => {
  console.error(JSON.stringify({ suite: 'installed-api-key-sdk-native-edit-http', passed: false, stage,
    error: error instanceof Error ? error.name : 'UnknownError' })); process.exitCode = 1;
});
