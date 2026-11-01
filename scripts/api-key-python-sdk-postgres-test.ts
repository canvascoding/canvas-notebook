import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup';
async function main() {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
  assert(python && path.isAbsolute(python)); assert(wheel && path.isAbsolute(wheel) && wheel.endsWith('.whl'));
  const wheelStat = await lstat(wheel); assert(wheelStat.isFile() && !wheelStat.isSymbolicLink());
  const wheelSha256 = createHash('sha256').update(await readFile(wheel)).digest('hex');
  const probe = path.resolve('scripts/helpers/python_sdk_api_key_probe.py');
  const probeSha256 = createHash('sha256').update(await readFile(probe)).digest('hex');
  const sourceRoot = path.resolve('packages/canvas-notebook-python/src/canvas_notebook');
  const sourceHashes: Record<string, string> = {};
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) if (entry.isFile() && (entry.name.endsWith('.py') || entry.name === 'py.typed')) {
    sourceHashes[`canvas_notebook/${entry.name}`] = createHash('sha256').update(await readFile(path.join(sourceRoot, entry.name))).digest('hex');
  }
  const server = http.createServer(); server.requestTimeout = 20000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); assert(address && typeof address === 'object'); const origin = `http://127.0.0.1:${address.port}`;
  try {
    await withDocumentReadToolDispatchFixture(async fixture => {
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'list_workspaces,get_workspace_overview,list_knowledge_tree,get_knowledge_manifest,read_knowledge_source,search_knowledge';
      const { handleDirectMcpPost, handleDirectMcpUnsupportedMethod, handleDirectMcpOptions } = await import('../app/lib/mcp/server/streamable-http');
      const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
      const sessionToken = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token;
      const headers = new Headers({ Authorization: `Bearer ${sessionToken}`, Origin: origin });
      const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Installed API-key SDK',
        workspaceIds: [fixture.workspaceId], expiresAt: Date.now() + 3_600_000 });
      const managementToken = randomBytes(32).toString('hex');
      await fixture.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('sdk-management-session',$1,'reader',$2,$3,$3)",
        [managementToken, Date.now() + 3_600_000, Date.now()]);
      let currentCredentialId = issued.credential.id;
      const text = 'SDKKeyneedle Äpfel 😀 日本語 – vollständiger nativer SDK-Inhalt.';
      const target = await fixture.seed({ representation: 'plain_text', text, filePath: 'sdk/native.payload' });
      const blocks = await fixture.seed({ representation: 'tiptap_blocks',
        text: '# Selected SDK block\n\nKeep the other paragraph unchanged.\n', filePath: 'blocks.payload' });
      await mkdir(path.join(fixture.workspaceRoot, 'sdk'));
      await writeFile(path.join(fixture.workspaceRoot, target.filePath), 'physical SDK fixture');
      await writeFile(path.join(fixture.workspaceRoot, 'sdk/bytes.bin'), Buffer.from([0, 255, 3, 4]));
      const before = await fixture.snapshot(), requests = new Set<Promise<void>>(), errors: unknown[] = [];
      const statuses: number[] = []; let keyHeaders = 0, protocolHeaders = 0;
      server.on('request', (incoming, outgoing) => {
        const operation = (async () => {
          const chunks: Buffer[] = []; let size = 0;
          for await (const raw of incoming) { const chunk = Buffer.from(raw); size += chunk.length; assert(size <= 32768); chunks.push(chunk); }
          assert.equal(incoming.url, '/mcp'); const actual = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) actual.set(name, Array.isArray(value) ? value.join(',') : value);
          assert(actual.has('x-canvas-api-key'), 'Installed SDK must send the explicit key header.'); keyHeaders++;
          assert(!actual.has('authorization') && !actual.has('cookie'), 'API-key SDK must not manufacture OAuth or a browser session.');
          if (actual.has('mcp-protocol-version')) protocolHeaders++;
          const request = new Request(`${origin}/mcp`, { method: incoming.method, headers: actual,
            ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
          const response = incoming.method === 'POST' ? await handleDirectMcpPost(request)
            : incoming.method === 'OPTIONS' ? await handleDirectMcpOptions(request) : await handleDirectMcpUnsupportedMethod(request);
          statuses.push(response.status); outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        })().catch(error => { errors.push(error); if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); });
        requests.add(operation); void operation.finally(() => requests.delete(operation));
      });
      const child = spawn(python, ['-I', probe], {
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let remainder = '', stdoutBytes = 0, stderrBytes = 0, complete = false, verified = false, chain = Promise.resolve();
      const milestones: string[] = [];
      const send = (value: unknown) => { assert(!child.stdin.destroyed); child.stdin.write(JSON.stringify(value) + '\n'); };
      const marker = async (line: string) => {
        const value = JSON.parse(line); assert(value && typeof value === 'object' && typeof value.event === 'string');
        milestones.push(value.event); stage = value.event;
        if (value.event === 'wheel_verified') { assert.equal(value.sha256, wheelSha256); verified = true; }
        else if (value.event === 'ready_rotate') {
          const rotated = await rotateApiKey(headers, issued.integration.id, { expectedRevision: 1, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
          currentCredentialId = rotated.credential.id; send({ key: rotated.key });
        } else if (value.event === 'ready_reduce') {
          await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
            workspaceIds: [fixture.workspaceId], actions: ['status'] }); send({ ready: true });
        } else if (value.event === 'ready_logout') {
          await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 3, name: issued.integration.name,
            workspaceIds: [fixture.workspaceId], actions: ['read'] });
          await fixture.admin.query("DELETE FROM session WHERE id='reader-session'");
          headers.set('Authorization', `Bearer ${managementToken}`); send({ ready: true });
        } else if (value.event === 'ready_revoke') {
          await revokeApiKey(headers, issued.integration.id, { expectedRevision: 4, credentialId: currentCredentialId }); send({ ready: true });
        } else if (value.event === 'complete') { assert.equal(value.groups, 4); assert.equal(value.oauthIssuance, false); assert.equal(value.compiledNext, false); complete = true; }
        else assert.fail('Unexpected SDK milestone.');
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length; if (stdoutBytes > 8192) { errors.push(new Error('SDK stdout exceeds its bound.')); child.kill('SIGTERM'); return; }
        remainder += chunk.toString(); let newline: number;
        while ((newline = remainder.indexOf('\n')) >= 0) { const line = remainder.slice(0, newline); remainder = remainder.slice(newline + 1); chain = chain.then(() => marker(line)); }
        void chain.catch(error => { errors.push(error); child.kill('SIGTERM'); });
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) child.kill('SIGTERM'); });
      child.stdin.on('error', error => { errors.push(error); });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      const timeout = setTimeout(() => { errors.push(new Error('SDK probe deadline exceeded.')); child.kill('SIGKILL'); }, 60000);
      try {
        send({ endpoint: `${origin}/mcp`, key: issued.key, workspaceId: fixture.workspaceId, documentId: target.documentId, text,
          blockDocumentId: blocks.documentId,
          wheelUri: pathToFileURL(wheel).href, wheelSha256, sourceHashes });
        const exit = await closed; await chain; assert.equal(exit.code, 0); assert.equal(exit.signal, null);
        assert.equal(errors.length, 0); assert.equal(remainder, ''); assert(complete && verified); assert(keyHeaders > 10 && protocolHeaders > 0);
        assert(statuses.filter(status => status === 401).length >= 2, 'Actual HTTP must reject the old and explicitly revoked keys.');
        assert.deepEqual(milestones, ['wheel_verified', 'ready_rotate', 'ready_reduce', 'ready_logout', 'ready_revoke', 'complete']);
        assert.deepEqual(await fixture.snapshot(), before);
        assert.equal(createHash('sha256').update(await readFile(wheel)).digest('hex'), wheelSha256);
        assert.equal(createHash('sha256').update(await readFile(probe)).digest('hex'), probeSha256);
        console.log(JSON.stringify({ suite: 'installed-api-key-sdk-native-http', passed: true, groups: 4, wheelSha256,
          nativeDocumentsUnchanged: true, keyHeaderOnlyRequests: keyHeaders, actual401: statuses.filter(status => status === 401).length,
          stderrBytes, compiledNext: false, oauthIssuance: false }));
      } finally {
        clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
        child.stdin.destroy(); await Promise.allSettled([...requests]);
      }
    }, { loopbackOrigin: origin });
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    assert.equal(server.listening, false);
  }
}
main().catch(error => {
  console.error(JSON.stringify({ suite: 'installed-api-key-sdk-native-http', passed: false, stage,
    error: error instanceof Error ? error.name : 'UnknownError' })); process.exitCode = 1;
});
