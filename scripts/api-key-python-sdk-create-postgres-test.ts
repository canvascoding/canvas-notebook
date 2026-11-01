import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let stage = 'setup';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function main() {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
  assert(python && path.isAbsolute(python)); assert(wheel && path.isAbsolute(wheel) && wheel.endsWith('.whl'));
  const stat = await lstat(wheel); assert(stat.isFile() && !stat.isSymbolicLink());
  const wheelSha256 = sha(await readFile(wheel)), probe = path.resolve('scripts/helpers/python_sdk_api_key_create_probe.py');
  const probeSha256 = sha(await readFile(probe)), sourceHashes: Record<string, string> = {};
  const sourceRoot = path.resolve('packages/canvas-notebook-python/src/canvas_notebook');
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) if (entry.isFile() && (entry.name.endsWith('.py') || entry.name === 'py.typed')) {
    sourceHashes[`canvas_notebook/${entry.name}`] = sha(await readFile(path.join(sourceRoot, entry.name)));
  }
  const sourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
  const response = await fetch(sourceUrl, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200); const sourceBytes = Buffer.from(await response.arrayBuffer());
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,create_knowledge_source,import_knowledge_file' });
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const { handleDirectMcpPost, handleDirectMcpUnsupportedMethod, handleDirectMcpOptions } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const manager = new Headers((await h.request(h.source, 'owner')).headers); manager.set('Origin', 'http://localhost');
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Installed Create Import SDK',
      workspaceIds: [h.source.workspaceId], actions: ['read', 'create', 'import'], expiresAt: Date.now() + 3_600_000 });
    const managerToken = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('sdk-create-manager',$1,'owner',$2,$3,$3)",
      [managerToken, Date.now() + 3_600_000, Date.now()]);
    let credentialId = issued.credential.id;
    const controlPath = 'sdk-create/protected.md', controlBytes = Buffer.from('SDK original must remain unchanged.');
    const control = await h.upload(controlPath, controlBytes);
    const snapshot = async () => ({ document: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [control.documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [control.documentId])).rows,
      bytes: await readFile(path.join(h.source.rootPath, controlPath)) });
    const before = await snapshot();
    const count = async () => Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_markdown_file_import_receipts')).rows[0].n);
    const receipt = async (operationId: string) => (await h.admin.query('SELECT to_jsonb(r) AS row,xmin::text AS xmin FROM collaboration_markdown_file_import_receipts r WHERE operation_id=$1', [operationId])).rows[0];
    const baseline = await count(), requests = new Set<Promise<void>>(), errors: unknown[] = [], statuses: number[] = [];
    const denials: string[] = [];
    const server = http.createServer(); server.requestTimeout = 40000; server.headersTimeout = 10000;
    let keyHeaders = 0, armed: 'create' | 'import' | null = null;
    const lostCalls = { create: 0, import: 0 }, drops = { create: 0, import: 0 };
    server.on('request', (incoming, outgoing) => {
      const operation = (async () => {
        const chunks: Buffer[] = []; let size = 0;
        for await (const raw of incoming) { const chunk = Buffer.from(raw); size += chunk.length; assert(size <= 65536); chunks.push(chunk); }
        assert.equal(incoming.url, '/mcp'); const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
        assert(headers.has('x-canvas-api-key') && !headers.has('authorization') && !headers.has('cookie')); keyHeaders++;
        const body = Buffer.concat(chunks), rpc = incoming.method === 'POST' ? JSON.parse(body.toString()) : null;
        const lostKind = rpc?.method === 'tools/call' && rpc.params?.name === 'create_knowledge_source'
          && rpc.params.arguments?.idempotency_key === 'sdk-native-lost-create-1' ? 'create'
          : rpc?.method === 'tools/call' && rpc.params?.name === 'import_knowledge_file'
            && rpc.params.arguments?.idempotency_key === 'sdk-native-lost-import-1' ? 'import' : null;
        if (lostKind) lostCalls[lostKind]++;
        const request = new Request(`${origin}/mcp`, { method: incoming.method, headers,
          ...(incoming.method === 'POST' ? { body } : {}) });
        const response = incoming.method === 'POST' ? await handleDirectMcpPost(request)
          : incoming.method === 'OPTIONS' ? await handleDirectMcpOptions(request) : await handleDirectMcpUnsupportedMethod(request);
        statuses.push(response.status);
        if (response.status === 401) denials.push(String(rpc?.method));
        const responseBody = Buffer.from(await response.arrayBuffer());
        if (lostKind && armed === lostKind) {
          const result = JSON.parse(responseBody.toString()).result?.structuredContent;
          assert.equal(response.status, 200); assert.equal(result?.outcome, 'created'); assert.equal(result?.projection.status, 'current');
          armed = null; drops[lostKind]++; outgoing.destroy(); return;
        }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(responseBody);
      })().catch(error => { errors.push(error); if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); });
      requests.add(operation); void operation.finally(() => requests.delete(operation));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject); resolve(); }); });
    const address = server.address(); assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const child = spawn(python, ['-I', probe], { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let remainder = '', stdoutBytes = 0, stderrBytes = 0, complete = false, verified = false, chain = Promise.resolve();
    let originalCreate = '', originalImport = '', originalCreateReceipt: unknown, originalImportReceipt: unknown;
    let beforeLossCount = 0, beforeLossIds: string[] = [], lostReceipt: unknown, lostOperationId = '';
    const milestones: string[] = [];
    const send = (value: unknown) => { assert(!child.stdin.destroyed); child.stdin.write(JSON.stringify(value) + '\n'); };
    const marker = async (line: string) => {
      const value = JSON.parse(line); assert(value && typeof value === 'object' && typeof value.event === 'string');
      milestones.push(value.event); stage = value.event;
      if (value.event === 'wheel_verified') { assert.equal(value.sha256, wheelSha256); verified = true; }
      else if (value.event === 'ready_rotate') {
        originalCreate = value.createOperation; originalImport = value.importOperation;
        assert.match(originalCreate, /^[a-f0-9]{64}$/u); assert.match(originalImport, /^[a-f0-9]{64}$/u);
        assert.equal(await count(), baseline + 2);
        originalCreateReceipt = await receipt(originalCreate); originalImportReceipt = await receipt(originalImport);
        assert.deepEqual(await readFile(path.join(h.source.rootPath, 'sdk-create/import.md')), sourceBytes);
        const rotated = await rotateApiKey(manager, issued.integration.id, { expectedRevision: 1, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
        credentialId = rotated.credential.id; send({ key: rotated.key });
      } else if (value.event === 'ready_reduce') {
        assert.equal(await count(), baseline + 2); assert.deepEqual(await receipt(originalCreate), originalCreateReceipt);
        assert.deepEqual(await receipt(originalImport), originalImportReceipt);
        await updateApiIntegration(manager, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
          workspaceIds: [h.source.workspaceId], actions: ['read', 'import'] }); send({ ready: true });
      } else if (value.event === 'ready_logout') {
        assert.equal(await count(), baseline + 2);
        await updateApiIntegration(manager, issued.integration.id, { expectedRevision: 3, name: issued.integration.name,
          workspaceIds: [h.source.workspaceId], actions: ['read', 'create', 'import'] });
        assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-owner'")).rowCount, 1);
        manager.set('Authorization', `Bearer ${managerToken}`); send({ ready: true });
      } else if (value.event === 'ready_loss') {
        assert(value.kind === 'create' || value.kind === 'import'); armed = value.kind;
        beforeLossCount = await count(); assert.equal(beforeLossCount, baseline + (value.kind === 'create' ? 3 : 4));
        beforeLossIds = (await h.admin.query('SELECT operation_id FROM collaboration_markdown_file_import_receipts')).rows.map(row => row.operation_id);
        send({ ready: true });
      } else if (value.event === 'loss_seen') {
        assert(value.kind === 'create' || value.kind === 'import'); const kind: 'create' | 'import' = value.kind;
        assert.equal(armed, null); assert.equal(lostCalls[kind], 1); assert.equal(drops[kind], 1);
        assert.equal(await count(), beforeLossCount + 1);
        const rows = (await h.admin.query('SELECT operation_id FROM collaboration_markdown_file_import_receipts WHERE operation_id<>ALL($1::text[])', [beforeLossIds])).rows;
        assert.equal(rows.length, 1); lostOperationId = rows[0].operation_id; lostReceipt = await receipt(lostOperationId);
        if (kind === 'import') assert.deepEqual(await readFile(path.join(h.source.rootPath, 'sdk-create/lost-import.md')), sourceBytes);
        send({ operationId: lostOperationId });
      } else if (value.event === 'loss_recovered') {
        assert(value.kind === 'create' || value.kind === 'import'); const kind: 'create' | 'import' = value.kind;
        assert.equal(value.operationId, lostOperationId); assert.equal(lostCalls[kind], 2); assert.equal(drops[kind], 1);
        assert.equal(await count(), beforeLossCount + 1); assert.deepEqual(await receipt(lostOperationId), lostReceipt); send({ ready: true });
      } else if (value.event === 'ready_revoke') {
        assert.equal(await count(), baseline + 5);
        await revokeApiKey(manager, issued.integration.id, { expectedRevision: 4, credentialId }); send({ ready: true });
      } else if (value.event === 'complete') { assert.equal(value.groups, 7); assert.equal(value.compiledNext, false); assert.equal(value.oauthIssuance, false); complete = true; }
      else assert.fail('Unexpected installed SDK Create/Import milestone.');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length; if (stdoutBytes > 8192) { errors.push(new Error('SDK output exceeds bound.')); child.kill('SIGTERM'); return; }
      remainder += chunk.toString(); let newline: number;
      while ((newline = remainder.indexOf('\n')) >= 0) { const line = remainder.slice(0, newline); remainder = remainder.slice(newline + 1); chain = chain.then(() => marker(line)); }
      void chain.catch(error => { errors.push(error); child.kill('SIGTERM'); });
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) child.kill('SIGTERM'); });
    child.stdin.on('error', error => { errors.push(error); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const timeout = setTimeout(() => { errors.push(new Error('Installed SDK Create/Import deadline exceeded.')); child.kill('SIGKILL'); }, 180000);
    try {
      send({ endpoint: `${origin}/mcp`, key: issued.key, workspaceId: h.source.workspaceId,
        sourceUrl, wheelUri: pathToFileURL(wheel).href, wheelSha256, sourceHashes });
      const exit = await closed; await chain; assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(errors.length, 0);
      assert.equal(remainder, ''); assert(verified && complete); assert.equal(denials.length, 3);
      // The revoked fresh connection tries modern discovery and the official
      // legacy initialization fallback. Neither is a mutation replay.
      assert.equal(denials.filter(method => method === 'tools/call').length, 1);
      assert(denials.every(method => ['tools/call', 'server/discover', 'initialize'].includes(method)));
      assert.equal(keyHeaders, statuses.length); assert(keyHeaders > 20); assert.equal(await count(), baseline + 5);
      assert.deepEqual(await receipt(originalCreate), originalCreateReceipt); assert.deepEqual(await receipt(originalImport), originalImportReceipt);
      assert.deepEqual(await snapshot(), before); assert.equal(sha(await readFile(probe)), probeSha256); assert.equal(sha(await readFile(wheel)), wheelSha256);
      console.log(JSON.stringify({ suite: 'installed-api-key-sdk-native-create-import-http', passed: true, groups: 7, wheelSha256,
        keyHeaderOnlyRequests: keyHeaders, actual401: denials.length, deniedMethods: denials, nativeOperationsCreated: 5, droppedWriteAcknowledgements: drops,
        automaticWriteReplays: 0, protectedNativeDocumentUnchanged: true, stderrBytes, compiledNext: false, oauthIssuance: false, reviewCenterEnabled: false }));
    } finally {
      if (!complete) console.error(JSON.stringify({ suite: 'installed-api-key-sdk-native-create-import-http', stage,
        milestones, keyHeaders, drops, lostCalls, stderrBytes, bridgeErrors: errors.map(error => error instanceof Error ? error.name : 'UnknownError') }));
      clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
      child.stdin.destroy(); await Promise.allSettled([...requests]);
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      assert.equal(server.listening, false);
    }
  });
}
main().catch(error => { console.error(JSON.stringify({ suite: 'installed-api-key-sdk-native-create-import-http', passed: false, stage,
  error: error instanceof Error ? error.name : 'UnknownError',
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });
