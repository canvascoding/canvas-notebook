import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, type PoolClient, type QueryResult } from 'pg';
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
  const originalTmpdir = process.env.TMPDIR;
  try {
    // Bind owned fixture storage to the real OS temporary directory. On macOS
    // /var is a symlink; the actual starter publisher rejects symlink ancestors.
    process.env.TMPDIR = await realpath(tmpdir());
    assert.equal(tmpdir(), process.env.TMPDIR);
    await bounded(new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    }), 'Reserved SDK HTTP socket did not listen.');
    const address = server.address(); assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    await withDocumentReadToolDispatchFixture(async fixture => {
      const { admin, workspaceId, clientId } = fixture;
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1'; process.env.FILE_VERSION_CENTER_MODE = 'shadow';
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'auth_probe,list_workspaces,read_knowledge_source,search_knowledge,create_knowledge_source,edit_knowledge_source,copy_knowledge_source';
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
      const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
      const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
      const { createPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
      const { initializeCreatedWorkspaceStarter } = await import('../app/lib/workspaces/starter-document-initialization-api');
      const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
      const reader = (await admin.query<{ id: string; email: string; role: string }>(
        'SELECT id,email,role FROM "user" WHERE id=$1', ['reader'])).rows[0]; assert(reader);
      const destination = await createPostgresWorkspaceForActor(resolveWorkspaceActor(reader), { type: 'personal', name: 'SDK Copy destination' });
      assert.notEqual(destination.workspaceId, workspaceId); assert.notEqual(destination.rootPath, fixture.workspaceRoot);
      assert(destination.permissions.canRead && destination.permissions.canWrite && destination.permissions.canRunAgent);
      const currentSession = (await admin.query<{ token: string }>('SELECT token FROM "session" WHERE id=$1 AND user_id=$2', ['reader-session', reader.id])).rows[0];
      assert(currentSession && typeof currentSession.token === 'string');
      const starter = await initializeCreatedWorkspaceStarter(new Request(`${origin}/api/workspaces`, { method: 'POST', headers: {
        authorization: `Bearer ${currentSession.token}`, 'x-canvas-workspace-id': destination.workspaceId,
      } }), destination.workspaceId);
      assert(starter); assert.equal(starter.status, 'completed');
      await admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
        VALUES($1,$2,100,100)`, [destination.workspaceId, reader.id]);
      await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,$2,$3,100,100)`, [clientId, reader.id, destination.workspaceId]);
      const copyPool = getPostgresRuntimeQueryable(); assert(copyPool);
      const staging = new WorkspaceOperationStaging();
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
      const revokedTools = new Set<string>();
      let beforeRetries: unknown, retryOperation: string | undefined, pythonComplete = false, wheelVerified = false, markerChain = Promise.resolve();
      const cases = new Set<string>(); let stdoutBytes = 0, stdoutRemainder = '', stderrBytes = 0;
      const stderrDigest = createHash('sha256');
      const rows = async () => {
        const tables = (await admin.query<{ relname: string; oid: string }>(`SELECT c.relname,c.oid::text AS oid FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
          AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)' OR c.relname='file_revisions')
          ORDER BY c.relname LIMIT 513`, [schema])).rows;
        assert(tables.length > 11 && tables.length <= 512); const copyDomain: Record<string, unknown> = {};
        for (const table of tables) {
          const name = `"${table.relname.replaceAll('"', '""')}"`;
          const values = (await admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
            ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
          assert(values.length <= 10000); copyDomain[table.relname] = values;
        }
        return { domain: await fixture.snapshot(), copyDomain: { tables, rows: copyDomain },
        operations: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_agent_operations ORDER BY operation_id')).rows,
        payloads: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_agent_native_edit_payloads ORDER BY operation_id')).rows,
        contents: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_revision_contents ORDER BY revision_id')).rows,
        blobs: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_version_blobs ORDER BY blob_id')).rows };
      };
      const copyFiles = async () => {
        const result: unknown[] = [], data = await realpath(fixture.dataRoot);
        const roots = [await realpath(fixture.workspaceRoot), await realpath(destination.rootPath),
          path.join(data, 'collaboration-assets'), path.join(data, 'workspace-operation-staging')];
        const visit = async (root: string, relative: string, label: number): Promise<void> => {
          assert(result.length < 10000); const file = path.join(root, relative);
          const stat = await lstat(file, { bigint: true }).catch((error: unknown) => {
            if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null; throw error;
          });
          if (!stat) { result.push({ root: label, path: relative, absent: true }); return; }
          assert(!stat.isSymbolicLink()); const value = { root: label, path: relative, dev: String(stat.dev), ino: String(stat.ino),
            mode: String(stat.mode), uid: String(stat.uid), nlink: String(stat.nlink), size: String(stat.size),
            mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
          if (stat.isFile()) { assert(stat.size <= BigInt(16 * 1024 * 1024)); result.push({ ...value, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }); }
          else { assert(stat.isDirectory()); result.push(value); for (const name of (await readdir(file)).sort()) await visit(root, path.join(relative, name), label); }
        };
        for (const [index, root] of roots.entries()) {
          const relative = path.relative(data, root); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
          await visit(root, '.', index);
        }
        return result;
      };
      const copyReceipt = async (operationId: string) => {
        const row = (await admin.query(`SELECT actor_user_id,actor_session_id,publication_status,private_result,xmin::text AS xmin
          FROM collaboration_native_copy_receipts WHERE operation_id=$1 AND workspace_id=$2`, [operationId, destination.workspaceId])).rows;
        assert.equal(row.length, 1); return object(row[0]);
      };
      type CopyCheck = { sourceDocumentId: string; sourcePath: string; destinationPath: string; planId: string;
        sourceBefore: unknown; privateResult?: unknown; cloneRows?: unknown; checkpoint?: { rows: unknown; files: unknown }; completed: boolean };
      const copyChecks = new Map<string, CopyCheck>();
      const sourceRows = async (documentId: string) => (await admin.query(`SELECT to_jsonb(d)::text AS registry,to_jsonb(s)::text AS state,
        to_jsonb(l)::text AS lineage,to_jsonb(m)::text AS metadata,d.xmin::text AS registry_xmin,s.xmin::text AS state_xmin,
        l.xmin::text AS lineage_xmin,m.xmin::text AS metadata_xmin FROM collaboration_documents d
        JOIN collaboration_yjs_states s ON s.document_id=d.id JOIN file_collaboration_lineages l ON l.id=d.lineage_id
        LEFT JOIN workspace_file_metadata m ON m.workspace_id=d.workspace_id AND m.path=d.path
        WHERE d.id=$1 AND d.workspace_id=$2`, [documentId, workspaceId])).rows;
      const copyClients = new Map<PoolClient, PropertyDescriptor | undefined>();
      const copyFaultState: { current?: { operationId: string; client?: PoolClient; xmin?: string; fired: boolean } } = {};
      let copyFaultCount = 0, copyObserverAttached = false;
      const observeCopyClient = (client: PoolClient) => {
        if (copyClients.has(client)) return; const descriptor = Object.getOwnPropertyDescriptor(client, 'query'); copyClients.set(client, descriptor);
        const original = client.query, raw = original.bind(client) as (sql: string, values?: unknown[]) => Promise<QueryResult>;
        Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
          if (typeof args[0] !== 'string' || typeof args.at(-1) === 'function') return Reflect.apply(original, client, args);
          const sql = args[0], values = args[1] as unknown[] | undefined;
          return (async () => {
            const actual = await raw(sql, values), fault = copyFaultState.current;
            if (fault && !fault.fired && /^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(sql) && values?.includes(fault.operationId)) {
              const stored = (await raw('SELECT xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [fault.operationId])).rows;
              assert.equal(stored.length, 1); fault.client = client; fault.xmin = String(stored[0].xmin);
            }
            if (fault && !fault.fired && fault.client === client && fault.xmin && /^\s*COMMIT\s*$/iu.test(sql)) {
              assert.equal(actual.command, 'COMMIT'); const visible = await copyReceipt(fault.operationId);
              assert.equal(visible.xmin, fault.xmin); assert.equal(visible.publication_status, 'native_committed');
              fault.fired = true; copyFaultCount++;
              throw Object.assign(new Error('Actual SDK Copy B1 COMMIT ACK lost after independent visibility.'), { code: 'EIO' });
            }
            return actual;
          })();
        } });
      };
      const send = (value: Row) => { assert(child && !child.stdin.destroyed); const frame = `${JSON.stringify(value)}\n`;
        assert(Buffer.byteLength(frame) <= 65536); child.stdin.write(frame); };
      const marker = async (line: string) => {
        const value = object(JSON.parse(line));
        if (value.event === 'wheel_verified') { assert.equal(value.sha256, wheelSha256); assert.equal(typeof value.version, 'string'); wheelVerified = true; }
        else if (value.event === 'pass') { assert(typeof value.case === 'string' && /^[a-z_]{1,80}$/u.test(value.case)); assert(!cases.has(value.case)); cases.add(value.case); }
        else if (value.event === 'ready_for_copy_source') {
          assert(safeId(value.documentId)); assert.equal(value.path, 'sdk-created.md');
          const actual = (await admin.query('SELECT path,status FROM collaboration_documents WHERE id=$1 AND workspace_id=$2', [value.documentId, workspaceId])).rows;
          assert.equal(actual.length, 1); assert.equal(actual[0].path, value.path); assert.equal(actual[0].status, 'active');
          const projection = path.join(fixture.workspaceRoot, 'sdk-created.md'), info = await lstat(projection);
          assert(info.isFile() && !info.isSymbolicLink()); await unlink(projection); await assert.rejects(lstat(projection), { code: 'ENOENT' });
          send({ event: 'copy_source_ready' });
        } else if (value.event === 'ready_for_copy_apply') {
          assert(safeId(value.operationId) && safeId(value.sourceDocumentId));
          assert.equal(value.sourcePath, 'sdk-created.md'); assert(typeof value.destinationPath === 'string' && /^sdk-copy-[a-z0-9 ()-]+\.md$/u.test(value.destinationPath));
          assert(typeof value.planId === 'string' && /^[a-f0-9]{64}$/u.test(value.planId)); assert.equal(typeof value.injectAckLoss, 'boolean');
          assert(!copyChecks.has(value.operationId)); assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operations WHERE operation_id=$1', [value.operationId])).rows[0].n, 0);
          await assert.rejects(lstat(path.join(fixture.workspaceRoot, 'sdk-created.md')), { code: 'ENOENT' });
          const sourceBefore = await sourceRows(value.sourceDocumentId); assert.equal(sourceBefore.length, 1);
          copyChecks.set(value.operationId, { sourceDocumentId: value.sourceDocumentId, sourcePath: value.sourcePath,
            destinationPath: value.destinationPath, planId: value.planId, sourceBefore, completed: false });
          if (value.injectAckLoss) { assert.equal(copyFaultState.current, undefined); copyFaultState.current = { operationId: value.operationId, fired: false }; }
          send({ event: 'copy_apply_ready' });
        } else if (value.event === 'copy_pending' || value.event === 'copy_complete') {
          assert(safeId(value.operationId)); const check = copyChecks.get(value.operationId); assert(check);
          const receipt = await copyReceipt(value.operationId), privateResult = object(receipt.private_result);
          assert.equal(receipt.actor_user_id, 'reader'); assert.equal(receipt.actor_session_id, 'reader-session');
          assert(Array.isArray(privateResult.documents) && privateResult.documents.length === 1);
          const pair = object(privateResult.documents[0]), source = object(pair.source), clone = object(pair.clone);
          assert.equal(source.documentId, check.sourceDocumentId); assert(safeId(clone.documentId) && safeId(clone.lineageId));
          assert.notEqual(clone.documentId, check.sourceDocumentId); assert.equal(clone.path, check.destinationPath);
          const born = (await admin.query(`SELECT d.lineage_id,d.workspace_id,d.path,s.lifecycle_generation,s.document_sequence,
            s.checkpoint_sequence,s.checkpointed_at,s.status,l.status AS lineage_status
            FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
            JOIN file_collaboration_lineages l ON l.id=d.lineage_id WHERE d.id=$1`, [clone.documentId])).rows;
          assert.equal(born.length, 1); assert.equal(born[0].lineage_id, clone.lineageId); assert.equal(born[0].workspace_id, destination.workspaceId);
          assert.equal(born[0].path, check.destinationPath); assert.equal(Number(born[0].lifecycle_generation), 1);
          assert.equal(Number(born[0].document_sequence), 0); assert.equal(Number(born[0].checkpoint_sequence), 0); assert.equal(born[0].checkpointed_at, null);
          assert.equal(born[0].status, 'active'); assert.equal(born[0].lineage_status, 'active');
          const header = (await admin.query('SELECT request_json,plan_id FROM workspace_file_operations WHERE operation_id=$1', [value.operationId])).rows[0]; assert(header);
          const request = object(JSON.parse(header.request_json)), original = object(request.origin), actor = object(original.actor);
          assert.equal(header.plan_id, check.planId); assert.equal(original.version, 2); assert.equal(original.transport, 'direct-mcp'); assert.equal(original.clientId, clientId);
          assert.equal(actor.userId, 'reader'); assert.equal(actor.sessionId, 'reader-session');
          assert.equal(object(original.sourceScope).workspaceId, workspaceId); assert.equal(object(original.destinationScope).workspaceId, destination.workspaceId);
          assert.deepEqual(request.selections, [{ sourcePath: check.sourcePath, destinationPath: check.destinationPath }]);
          assert.deepEqual(await sourceRows(check.sourceDocumentId), check.sourceBefore);
          const clones = (await admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [clone.documentId])).rows;
          if (value.event === 'copy_pending') {
            assert(copyFaultState.current?.fired && copyFaultState.current.operationId === value.operationId); assert.equal(receipt.publication_status, 'native_committed');
            const retained = await staging.loadManagedCopyByOperationId(value.operationId); assert(retained); assert.equal(retained.plan.planId, check.planId);
            assert.deepEqual(retained.request.selections, request.selections); check.privateResult = structuredClone(privateResult); check.cloneRows = clones;
            check.checkpoint = { rows: await rows(), files: await copyFiles() }; send({ event: 'copy_pending_ready' });
          } else {
            assert.equal(receipt.publication_status, 'published');
            if (check.privateResult !== undefined) { assert.deepEqual(privateResult, check.privateResult); assert.deepEqual(clones, check.cloneRows); }
            await assert.rejects(lstat(path.join(destination.rootPath, check.destinationPath)), { code: 'ENOENT' });
            assert.equal(await staging.loadManagedCopyByOperationId(value.operationId), null); check.completed = true;
            send({ event: 'copy_complete_checked', cloneDocumentId: clone.documentId, cloneLineageId: clone.lineageId });
          }
        } else if (value.event === 'copy_pending_status_done' || value.event === 'copy_checks_done') {
          assert(safeId(value.operationId)); const check = copyChecks.get(value.operationId); assert(check?.checkpoint);
          assert.deepEqual(await rows(), check.checkpoint.rows); assert.deepEqual(await copyFiles(), check.checkpoint.files);
          check.checkpoint = undefined; send({ event: 'copy_checks_checked' });
        } else if (value.event === 'ready_for_copy_checks') {
          assert(safeId(value.operationId)); const check = copyChecks.get(value.operationId); assert(check?.completed); assert.equal(check.checkpoint, undefined);
          await flushCollaborationDocuments(); check.checkpoint = { rows: await rows(), files: await copyFiles() }; send({ event: 'copy_checks_ready' });
        }
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
          assert.equal(value.groups, 7); assert.equal(value.installedWheel, true); assert.equal(value.actualHttp, true);
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
            const rpc = object(JSON.parse(body));
            if (rpc.method === 'tools/call') { const parameters = object(rpc.params); assert.equal(typeof parameters.name, 'string'); revokedTools.add(String(parameters.name)); }
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
        copyObserverAttached = true; copyPool.on('connect', observeCopyClient); copyPool.on('acquire', observeCopyClient);
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
        const beforeAnonymous = await rows();
        let anonymousRequestId = 0;
        const anonymousRpc = async (method: string, params: Row, modern: boolean) => {
          const protocol = modern ? '2026-07-28' : '2025-06-18';
          const headers: Record<string, string> = { accept: 'application/json, text/event-stream',
            'content-type': 'application/json', 'mcp-protocol-version': protocol };
          // Legacy metadata-free calls can carry mcp-method too: use the real
          // protocol envelope, not that header alone, to classify requests.
          if (modern || method === 'tools/call') headers['mcp-method'] = method;
          if (method === 'tools/call') { assert(typeof params.name === 'string'); headers['mcp-name'] = params.name; }
          const body = JSON.stringify({ jsonrpc: '2.0', id: ++anonymousRequestId, method, params: modern ? { ...params,
            _meta: { 'io.modelcontextprotocol/protocolVersion': protocol,
              'io.modelcontextprotocol/clientInfo': { name: 'canvas-sdk-anonymous-boundary', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {} } } : params });
          const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 12000);
          try {
            const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
              const request = http.request(new URL('/mcp', origin), { method: 'POST', headers, signal: abort.signal }, resolve);
              request.once('error', reject); request.end(body);
            });
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of response) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.length; assert(size <= 65536); chunks.push(bytes); }
            const parsed = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            return { status: response.statusCode, headers: response.headers, body: parsed };
          } finally { clearTimeout(deadline); abort.abort(); }
        };
        const discovery = await anonymousRpc('server/discover', {}, true);
        assert.equal(discovery.status, 200); assert.equal(discovery.body.jsonrpc, '2.0');
        const discovered = object(discovery.body.result);
        assert(Array.isArray(discovered.supportedVersions) && discovered.supportedVersions.includes('2026-07-28'));
        assert(object(object(discovered.capabilities).tools));
        assert.equal(object(object(discovered._meta)['io.modelcontextprotocol/serverInfo']).name, 'canvas-notebook-direct-mcp');
        const listing = await anonymousRpc('tools/list', {}, true);
        assert.equal(listing.status, 200); const listed = object(listing.body.result); assert(Array.isArray(listed.tools));
        assert(listed.tools.some(value => object(value).name === 'list_workspaces'));
        assert.equal(listed.cacheScope, 'private'); assert.equal(listed.ttlMs, 0);
        const initialized = await anonymousRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
          clientInfo: { name: 'canvas-sdk-legacy-probe', version: '1.0.0' } }, false);
        assert.equal(initialized.status, 200);
        assert.equal(object(object(initialized.body.result).serverInfo).name, 'canvas-notebook-direct-mcp');
        const probe = await anonymousRpc('tools/call', { name: 'auth_probe', arguments: {} }, false);
        assert.equal(probe.status, 200); const probeResult = object(probe.body.result); assert.equal(probeResult.isError, true);
        const legacyChallenges = object(probeResult._meta)['mcp/www_authenticate'];
        assert(Array.isArray(legacyChallenges) && legacyChallenges.length === 1 && typeof legacyChallenges[0] === 'string');
        assert(legacyChallenges[0].includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`));
        assert(legacyChallenges[0].includes('error="invalid_token"'));
        const denied = await anonymousRpc('tools/call', { name: 'list_workspaces', arguments: {} }, true);
        assert.deepEqual(await rows(), beforeAnonymous);
        console.log(JSON.stringify({ boundary: 'anonymous-modern-tool-call', observedHttpStatus: denied.status,
          originalDomainRowsUnchanged: true, modernDiscoveryAndList: true, legacyHeaderProbePreserved: true }));
        assert.equal(denied.status, 401, 'Anonymous modern tools/call must return a real HTTP 401.');
        assert.equal(denied.body.error, 'invalid_token'); assert.equal(denied.body.result, undefined);
        const challenge = denied.headers['www-authenticate']; assert(typeof challenge === 'string');
        assert.match(challenge, /^Bearer /u);
        assert(challenge.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`));
        assert.equal(denied.headers['cache-control'], 'no-store'); assert.equal(denied.headers['x-content-type-options'], 'nosniff');
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
        send({ endpoint: `${origin}/mcp`, token, scopeToken, workspaceId, copyWorkspaceId: destination.workspaceId, seedDocumentId: seed.documentId, seedText,
          wheelUri: pathToFileURL(wheel).href, wheelSha256 });
        const exit = await bounded(childClosed, 'Owned installed SDK child exceeded its deadline.', 180000);
        await markerChain; assert.equal(stdoutRemainder, ''); assert.equal(exit.signal, null); assert.equal(exit.code, 0); assert.equal(childIoErrors.length, 0);
        assert(pythonComplete && wheelVerified && activatedRevocation && beforeRetries);
        assert.deepEqual([...cases].sort(), ['discovery_search_version_bound_multipage_read', 'native_create_and_same_key_create_retry',
          'native_copy_preview_apply_status_and_same_id_retry', 'native_copy_pending_status_explicit_recover_same_id',
          'native_edit_status_same_key_and_stale_conflict', 'actual_write_scope_denial', 'actual_session_revocation'].sort());
        assert.equal(copyChecks.size, 2); assert([...copyChecks.values()].every(check => check.completed && check.checkpoint === undefined));
        assert.equal(copyFaultCount, 1); assert(copyFaultState.current?.fired); assert(rejectedAfterRevocation >= 2);
        assert(revokedTools.has('edit_knowledge_source') && revokedTools.has('copy_knowledge_source'));
        assert(actualHttpRequests > 8); assert.equal(requestErrors.length, 0); await flushCollaborationDocuments();
        assert.equal(createHash('sha256').update(await readFile(pythonProbe)).digest('hex'), pythonProbeSha256);
        assert.equal(createHash('sha256').update(await readFile(wheel)).digest('hex'), wheelSha256);
        assert.deepEqual(await rows(), beforeRetries); assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
        console.log(JSON.stringify({ suite: 'python-sdk-document-postgres', groups: cases.size + 1, sdkGroups: cases.size,
          anonymousHttpBoundary: true, anonymousBoundaryRequests: anonymousRequestId, wheelSha256, pythonProbeSha256,
          installedWheel: true, actualTcpHttpRequests: actualHttpRequests, revokedOriginalHandler401: rejectedAfterRevocation,
          revokedOriginalToolCalls: [...revokedTools].sort(),
          nativeCopyOperations: copyChecks.size, actualB1CommitAckFaults: copyFaultCount,
          originalCopyAttributionAndCloneIdsVerified: true, pendingAndCompletedStatusRowsAndFilesystemUnchanged: true,
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
        if (copyObserverAttached) {
          copyPool.removeListener('connect', observeCopyClient); copyPool.removeListener('acquire', observeCopyClient); copyObserverAttached = false;
          for (const [client, descriptor] of copyClients) try {
            if (descriptor) Object.defineProperty(client, 'query', descriptor); else assert(Reflect.deleteProperty(client, 'query'));
          } catch (error) { cleanup.push(error); }
          copyClients.clear();
        }
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
  finally {
    try { await closeServer(server); }
    catch (error) { outerFailure = new AggregateError([...(outerFailure === undefined ? [] : [outerFailure]), error], 'Reserved SDK socket closure failed.'); }
    finally { if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir; }
  }
  if (outerFailure !== undefined) throw outerFailure;
  completed = true;
}

pythonSdkDocumentPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
  console.error(JSON.stringify({ suite: 'python-sdk-document-postgres', passed: false,
    name: error instanceof Error ? error.name : 'UnknownError', code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(code) ? code : null }));
  process.exitCode = 1;
});
