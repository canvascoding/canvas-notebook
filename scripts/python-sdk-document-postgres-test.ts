import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Genuine PG fixture/JWTs and original registered MCP handler over actual TCP.
// The child imports an installed wheel, never an editable/source-tree package.
// This is neither OAuth issuance nor compiled Next/browser acceptance.
type Row = Record<string, unknown>;
const object = (value: unknown): Row => { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function bounded<T>(operation: Promise<T>, label: string, milliseconds = 12000, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
      abort = () => reject(new Error(label));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

async function closeServer(server: http.Server): Promise<void> {
  await bounded(new Promise<void>((resolve, reject) => {
    server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    server.closeIdleConnections();
  }), 'Owned HTTP close was not confirmed.');
  assert.equal(server.listening, false);
}

export async function pythonSdkDocumentPostgresTest(): Promise<void> {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
  assert(python && path.isAbsolute(python)); assert(wheel && path.isAbsolute(wheel) && wheel.endsWith('.whl'));
  const wheelIdentity = await lstat(wheel); assert(wheelIdentity.isFile() && !wheelIdentity.isSymbolicLink());
  const wheelSha256 = createHash('sha256').update(await readFile(wheel)).digest('hex');
  const pythonProbe = path.join(process.cwd(), 'scripts/helpers/python_sdk_document_probe.py');
  const pythonProbeSha256 = createHash('sha256').update(await readFile(pythonProbe)).digest('hex');
  // Keep this real socket bound while the fixture configures its origin and
  // imports the backend; there is no close/rebind free-port race.
  const server = http.createServer();
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  let outerFailure: unknown;
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    }), 'Reserved SDK HTTP socket did not listen.');
    const address = server.address(); assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    await withDocumentReadToolDispatchFixture(async fixture => {
      const { admin, workspaceId, clientId } = fixture;
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1'; process.env.FILE_VERSION_CENTER_MODE = 'shadow';
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'list_workspaces,read_knowledge_source,search_knowledge,create_knowledge_source,edit_knowledge_source';
      assert.equal(process.env.BASE_URL, origin); assert.equal(process.env.BETTER_AUTH_BASE_URL, origin);
      assert.equal((await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active' RETURNING user_id`)).rowCount, 1);
      await admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id=$3',
        [JSON.stringify(['workspace:list', 'knowledge:read', 'knowledge:search', 'knowledge:write']), clientId, 'reader']);
      const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
      assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
      const { handleDirectMcpPost, handleDirectMcpUnsupportedMethod, handleDirectMcpOptions } = await import('../app/lib/mcp/server/streamable-http');
      const { createCollaborationServer, flushCollaborationDocuments } = await import('../server/collaboration-server');
      const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
      const { captureNativeDocumentEditOriginal, captureNativeDocumentEditAfter } = await import('../app/lib/collaboration/native-document-edit-operation-contract');
      const { Hocuspocus } = await import('@hocuspocus/server');
      const schema = String((await admin.query('SELECT current_schema() AS schema')).rows[0].schema);
      assert.match(schema, /^document_tool_dispatch_[a-f0-9]+$/u);
      const applicationName = String((await admin.query("SELECT current_setting('application_name') AS value")).rows[0].value);
      const ownerClients = new Set<Client>(), owners = new Set<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>>();
      const backends: Array<{ pid: number; start: string }> = [];
      const ownerRuntime: { current?: InstanceType<typeof Hocuspocus> } = {}, originalHooks = Hocuspocus.prototype.hooks;
      const controllers = new Set<AbortController>(), requests = new Set<Promise<void>>(), handlers = new Set<Promise<Response>>(), requestErrors: unknown[] = [], childIoErrors: unknown[] = [];
      let wss: ReturnType<typeof createCollaborationServer> | undefined, child: ChildProcessWithoutNullStreams | undefined;
      let childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      let primary: unknown, activatedRevocation = false, rejectedAfterRevocation = 0, actualHttpRequests = 0;
      let beforeRetries: unknown, retryOperation: string | undefined, pythonComplete = false, wheelVerified = false, markerChain = Promise.resolve();
      const cases = new Set<string>(); let stdoutBytes = 0, stdoutRemainder = '', stderrBytes = 0;
      const stderrDigest = createHash('sha256');
      const rows = async () => ({ domain: await fixture.snapshot(),
        operations: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_agent_operations ORDER BY operation_id')).rows,
        payloads: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_agent_native_edit_payloads ORDER BY operation_id')).rows,
        contents: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_revision_contents ORDER BY revision_id')).rows,
        blobs: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_version_blobs ORDER BY blob_id')).rows });
      const send = (value: Row) => { assert(child && !child.stdin.destroyed); const frame = `${JSON.stringify(value)}\n`;
        assert(Buffer.byteLength(frame) <= 65536); child.stdin.write(frame); };
      const marker = async (line: string) => {
        const value = object(JSON.parse(line));
        if (value.event === 'wheel_verified') { assert.equal(value.sha256, wheelSha256); assert.equal(typeof value.version, 'string'); wheelVerified = true; }
        else if (value.event === 'pass') { assert(typeof value.case === 'string' && /^[a-z_]{1,80}$/u.test(value.case)); assert(!cases.has(value.case)); cases.add(value.case); }
        else if (value.event === 'ready_for_retries') {
          assert(safeId(value.operationId) && safeId(value.documentId)); assert.equal(beforeRetries, undefined);
          const row = (await admin.query(`SELECT native_edit_original_json,native_edit_after_json FROM collaboration_agent_operations
            WHERE operation_id=$1 AND workspace_id=$2`, [value.operationId, workspaceId])).rows[0]; assert(row);
          const original = captureNativeDocumentEditOriginal(row.native_edit_original_json), after = captureNativeDocumentEditAfter(row.native_edit_after_json, original);
          assert.equal(original.origin.transport, 'direct-mcp'); assert(original.origin.transport === 'direct-mcp');
          assert.equal(original.origin.clientId, clientId); assert.equal(original.origin.sessionId, 'reader-session');
          assert.equal(original.actor.userId, 'reader'); assert.equal(original.identity.documentId, value.documentId);
          assert.equal(after.afterVersion, value.afterVersion); retryOperation = value.operationId;
          await flushCollaborationDocuments(); beforeRetries = await rows(); send({ event: 'retries_ready' });
        } else if (value.event === 'ready_for_revoke') {
          assert(beforeRetries && retryOperation); await flushCollaborationDocuments(); assert.deepEqual(await rows(), beforeRetries);
          assert.equal((await admin.query(`UPDATE "session" SET expires_at=$1 WHERE id='reader-session' AND user_id='reader' RETURNING id`, [Date.now() - 1000])).rowCount, 1);
          activatedRevocation = true; send({ event: 'session_revoked' });
        } else if (value.event === 'complete') {
          assert.equal(value.groups, 5); assert.equal(value.installedWheel, true); assert.equal(value.actualHttp, true);
          assert.equal(value.oauthIssuance, false); assert.equal(value.compiledNext, false); pythonComplete = true;
        } else { throw new Error('Installed SDK child reported failure or an unknown event.'); }
      };
      const serve = async (incoming: http.IncomingMessage, outgoing: http.ServerResponse): Promise<void> => {
        const abort = new AbortController(); controllers.add(abort);
        const disconnected = () => { if (!outgoing.writableEnded) abort.abort(); };
        incoming.once('aborted', disconnected); outgoing.once('close', disconnected);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          assert.equal(incoming.headers.host, new URL(origin).host);
          const target = incoming.url; assert(typeof target === 'string' && target.startsWith('/'));
          const url = new URL(target, origin);
          if (url.pathname !== '/mcp' || url.search) { outgoing.writeHead(404); outgoing.end(); return; }
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of incoming) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
            assert(size <= 1024 * 1024); chunks.push(bytes); }
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
          const method = incoming.method ?? 'GET';
          const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
          const request = new Request(url, { method, headers, signal: abort.signal,
            ...(['GET', 'HEAD'].includes(method) ? {} : { body }) });
          const handler = method === 'POST' ? handleDirectMcpPost(request)
            : method === 'OPTIONS' ? handleDirectMcpOptions(request) : handleDirectMcpUnsupportedMethod(request);
          handlers.add(handler); void handler.then(() => handlers.delete(handler), () => handlers.delete(handler));
          const response = await bounded(handler, 'Original MCP handler timed out.', 30000, abort.signal);
          actualHttpRequests++;
          const denied: Uint8Array[] = []; let responseBytes = 0;
          outgoing.statusCode = response.status; response.headers.forEach((value, name) => outgoing.setHeader(name, value));
          reader = response.body?.getReader();
          if (reader) for (;;) {
            const part = await bounded(reader.read(), 'Original MCP response stream timed out.', 30000, abort.signal); if (part.done) break;
            responseBytes += part.value.byteLength; assert(responseBytes <= 8 * 1024 * 1024);
            if (activatedRevocation && response.status === 401) { assert(responseBytes <= 16384); denied.push(part.value); }
            if (!outgoing.write(part.value)) await bounded(new Promise<void>((resolve, reject) => {
              const drain = () => { cleanup(); resolve(); }, failure = () => { cleanup(); reject(new Error('Owned HTTP response aborted.')); };
              const cleanup = () => { outgoing.removeListener('drain', drain); outgoing.removeListener('error', failure); abort.signal.removeEventListener('abort', failure); };
              outgoing.once('drain', drain); outgoing.once('error', failure); abort.signal.addEventListener('abort', failure, { once: true });
            }), 'Owned HTTP response backpressure timed out.', 30000, abort.signal);
          }
          if (activatedRevocation && response.status === 401) {
            assert.equal(object(JSON.parse(Buffer.concat(denied).toString('utf8'))).error, 'invalid_token');
            assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer /u); rejectedAfterRevocation++;
          }
          outgoing.end();
        } catch (error) { requestErrors.push(error); outgoing.destroy(); }
        finally {
          try { if (reader) await bounded(reader.cancel(), 'Original response reader cancel did not settle.', 5000); }
          catch (error) { requestErrors.push(error); }
          finally { reader?.releaseLock(); controllers.delete(abort); incoming.removeListener('aborted', disconnected); outgoing.removeListener('close', disconnected); }
        }
      };
      const listener = (request: http.IncomingMessage, response: http.ServerResponse) => {
        const pending = serve(request, response); requests.add(pending); void pending.then(() => requests.delete(pending), error => { requests.delete(pending); requestErrors.push(error); });
      };
      try {
        Hocuspocus.prototype.hooks = (async function(this: InstanceType<typeof Hocuspocus>, name: string, payload: Record<string, unknown>, ...args: unknown[]) {
          if (ownerRuntime.current) assert.equal(ownerRuntime.current, this); ownerRuntime.current = this;
          return Reflect.apply(originalHooks, this, [name, payload, ...args]);
        }) as typeof originalHooks;
        wss = createCollaborationServer(server, { roomOwner: { heartbeatMs: 1000, createSession: async onInvalidated => {
          const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: applicationName,
            options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, connectionTimeoutMillis: 5000 });
          ownerClients.add(client); client.on('error', () => undefined); await client.connect();
          const actual = (await client.query(`SELECT current_schema() AS schema,pg_backend_pid() AS pid,
            extract(epoch FROM backend_start)::text AS start FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(actual.schema, schema); backends.push({ pid: actual.pid, start: actual.start });
          const owner = await createCollaborationRoomOwnerSession({ query: client.query.bind(client), on: client.on.bind(client),
            end: async () => { await client.end(); ownerClients.delete(client); } }, onInvalidated); owners.add(owner); return owner;
        } } });
        server.on('request', listener);
        const seedText = `SDKNeedle start. ${'Bounded UTF8 😀🧪 stable segment. '.repeat(64)}End.`;
        const seed = await fixture.seed({ filePath: 'sdk-seed.bin', text: seedText });
        await assert.rejects(lstat(path.join(fixture.workspaceRoot, seed.filePath)), { code: 'ENOENT' });
        const token = await fixture.issue({ scope: 'workspace:list knowledge:read knowledge:search knowledge:write' });
        const scopeToken = await fixture.issue({ scope: 'workspace:list knowledge:read knowledge:search' });
        child = spawn(python, ['-I', pythonProbe], {
          cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
        childClosed = new Promise((resolve, reject) => { child!.once('error', reject); child!.once('close', (code, signal) => resolve({ code, signal })); });
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > 65536) { markerChain = markerChain.then(() => { throw new Error('SDK child stdout exceeded its safe bound.'); });
            void markerChain.catch(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }); return; }
          stdoutRemainder += chunk.toString('utf8'); let newline: number;
          while ((newline = stdoutRemainder.indexOf('\n')) >= 0) { const line = stdoutRemainder.slice(0, newline); stdoutRemainder = stdoutRemainder.slice(newline + 1); markerChain = markerChain.then(() => marker(line)); }
          void markerChain.catch(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
        });
        child.stdin.on('error', error => { childIoErrors.push(error); });
        child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; stderrDigest.update(chunk);
          if (stderrBytes > 65536 && child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
        send({ endpoint: `${origin}/mcp`, token, scopeToken, workspaceId, seedDocumentId: seed.documentId, seedText,
          wheelUri: pathToFileURL(wheel).href, wheelSha256 });
        const exit = await bounded(childClosed, 'Owned installed SDK child exceeded its deadline.', 180000);
        await markerChain; assert.equal(stdoutRemainder, ''); assert.equal(exit.signal, null); assert.equal(exit.code, 0); assert.equal(childIoErrors.length, 0);
        assert(pythonComplete && wheelVerified && activatedRevocation && beforeRetries);
        assert.deepEqual([...cases].sort(), ['discovery_search_version_bound_multipage_read', 'native_create_and_same_key_create_retry',
          'native_edit_status_same_key_and_stale_conflict', 'actual_write_scope_denial', 'actual_session_revocation'].sort());
        assert(rejectedAfterRevocation > 0);
        assert(actualHttpRequests > 8); assert.equal(requestErrors.length, 0); await flushCollaborationDocuments();
        assert.equal(createHash('sha256').update(await readFile(pythonProbe)).digest('hex'), pythonProbeSha256);
        assert.equal(createHash('sha256').update(await readFile(wheel)).digest('hex'), wheelSha256);
        assert.deepEqual(await rows(), beforeRetries); assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
        console.log(JSON.stringify({ suite: 'python-sdk-document-postgres', groups: cases.size, wheelSha256, pythonProbeSha256,
          installedWheel: true, actualTcpHttpRequests: actualHttpRequests, revokedOriginalHandler401: rejectedAfterRevocation,
          originalRowsUnchangedByRetryStatusConflictAndDenials: true, oauthIssuance: false, compiledNext: false,
          pythonStderrBytes: stderrBytes, pythonStderrSha256: stderrDigest.digest('hex') }));
      } catch (error) { primary = error; }
      finally {
        const cleanup: unknown[] = [];
        if (child && childClosed && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          try { await bounded(childClosed, 'Own Python SIGTERM close not confirmed.', 5000); }
          catch (error) { cleanup.push(error); child.kill('SIGKILL'); try { await bounded(childClosed, 'Own Python SIGKILL close not confirmed.', 5000); } catch (last) { cleanup.push(last); } }
        }
        child?.stdin.destroy(); for (const controller of controllers) controller.abort();
        try { await bounded(Promise.allSettled([...requests]), 'Owned MCP request completion not confirmed.'); } catch (error) { cleanup.push(error); }
        try { await bounded(Promise.allSettled([...handlers]), 'Original MCP handler completion not confirmed.'); } catch (error) { cleanup.push(error); }
        cleanup.push(...requestErrors);
        server.removeListener('request', listener);
        try { await flushCollaborationDocuments(); } catch (error) { cleanup.push(error); }
        if (ownerRuntime.current) {
          for (const doc of [...ownerRuntime.current.documents.values()]) try { assert.equal(doc.getConnectionsCount(), 0); await ownerRuntime.current.unloadDocument(doc); } catch (error) { cleanup.push(error); }
          for (const pending of [...ownerRuntime.current.unloadingDocuments.values()]) try { await bounded(pending, 'Owned room unload not confirmed.'); } catch (error) { cleanup.push(error); }
        }
        if (wss) try { await bounded(new Promise<void>((resolve, reject) => wss!.close(error => error ? reject(error) : resolve())), 'Owned WSS close not confirmed.'); } catch (error) { cleanup.push(error); }
        try { await closeServer(server); } catch (error) { cleanup.push(error); }
        for (const owner of owners) try { await owner.close(); } catch (error) { cleanup.push(error); }
        for (const client of ownerClients) try { await client.end(); ownerClients.delete(client); } catch (error) { cleanup.push(error); }
        Hocuspocus.prototype.hooks = originalHooks;
        for (const backend of backends) try { assert.equal((await admin.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2`, [backend.pid, backend.start])).rows[0].count, 0); } catch (error) { cleanup.push(error); }
        if (primary !== undefined || cleanup.length) throw new AggregateError([...(primary === undefined ? [] : [primary]), ...cleanup], 'Installed SDK probe or own cleanup failed.');
        console.log(JSON.stringify({ closure: 'python-sdk-document-postgres', pythonClosed: true, ownHttpAndWssClosed: true, dedicatedOwnerBackendsClosed: backends.length }));
      }
    }, { loopbackOrigin: origin });
  } catch (error) { outerFailure = error; }
  finally { try { await closeServer(server); } catch (error) { outerFailure = new AggregateError([...(outerFailure === undefined ? [] : [outerFailure]), error], 'Reserved SDK socket closure failed.'); } }
  if (outerFailure !== undefined) throw outerFailure;
  completed = true;
}

pythonSdkDocumentPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
  console.error(JSON.stringify({ suite: 'python-sdk-document-postgres', passed: false,
    name: error instanceof Error ? error.name : 'UnknownError', code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(code) ? code : null }));
  process.exitCode = 1;
});
