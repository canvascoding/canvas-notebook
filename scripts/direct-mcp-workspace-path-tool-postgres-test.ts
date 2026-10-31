import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileEvent } from '../app/lib/filesystem/file-watcher';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Real HTTP dispatcher, signed JWTs, current SQL grants and original native
// owners. The fixture observes real SQL; no authority or mutation result is mocked.
const sha = (bytes: string | Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
let completed = false, currentCase = 'setup', groups = 0;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

export async function directMcpWorkspacePathToolPostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { DIRECT_MCP_PROTOCOL_VERSION: protocol, DIRECT_MCP_DEFAULT_TOOL_IDS, DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS } = await import('../app/lib/mcp/server/config');
    const contract = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { getFileWatcher } = await import('../app/lib/filesystem/file-watcher');
    const { fileTreeCache, buildFileTreeCacheKey } = await import('../app/lib/utils/file-tree-cache');
    await upsertPostgresWorkspaceMemberForActor(resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }),
      h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    assert.equal(h.source.permissions.canWrite, false, 'Stale fixture DTO is never made into a grant.');
    const clientId = `path-http-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Actual public path fixture',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) {
      await h.admin.query('INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at) VALUES($1,\'owner\',100,100)', [workspaceId]);
      await h.admin.query('INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,\'member\',$2,100,100)', [clientId, workspaceId]);
    }
    const issue = async (sessionId = 'session-member') => {
      const seconds = Math.floor(Date.now() / 1000), result = await auth.api.signJWT({ body: { payload: {
        sub: 'member', azp: clientId, sid: sessionId, iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp',
        iat: seconds - 1, exp: seconds + 1800, scope: 'knowledge:read knowledge:write' } } }); assert(result.token); return result.token;
    };
    const originalToken = await issue(); let currentToken = originalToken, requestId = 0;
    type Kind = 'move' | 'delete';
    const tool = (kind: Kind) => kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source';
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, token = currentToken) => {
      const id = ++requestId, response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
        'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}), authorization: `Bearer ${token}`,
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'actual-path-dispatch-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }) }));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = object(await response.json()); assert.equal(body.id, id); assert.equal(body.jsonrpc, '2.0'); return body;
    };
    const call = async (kind: Kind, args: Record<string, unknown>, token = currentToken) => {
      const body = await rpc('tools/call', { name: tool(kind), arguments: args }, token);
      assert.equal(Object.hasOwn(body, 'error'), false); const result = object(body.result), content = result.content;
      assert(Array.isArray(content)); assert.equal(content.length, 1); const value = object(result.structuredContent);
      assert.equal(object(content[0]).type, 'text'); assert.deepEqual(JSON.parse(String(object(content[0]).text)), value);
      assert.equal(value.apiVersion, 1); assert(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
      for (const secret of [h.dataRoot, originalToken, token]) assert.equal(JSON.stringify(value).includes(secret), false);
      return { result, value };
    };
    const success = async (kind: Kind, args: Record<string, unknown>, token = currentToken) => {
      const { result, value } = await call(kind, args, token);
      assert.notEqual(result.isError, true, `Public ${kind} unexpectedly failed: ${String(value.code)}`);
      assert.equal(value.action, args.action); return value;
    };
    const failure = async (kind: Kind, args: Record<string, unknown>, expected: string, token = currentToken) => {
      const { result, value } = await call(kind, args, token); assert.equal(result.isError, true);
      assert.equal(value.success, false); assert.equal(value.code, expected);
      assert.deepEqual(Object.keys(value).sort(), ['apiVersion', 'code', ...(value.operationId === undefined ? [] : ['operationId']), 'success'].sort());
      if (args.operation_id) assert.equal(value.operationId, args.operation_id); return { result, value };
    };
    const domain = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 11 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        // The real HTTP diagnostic recorder may insert/prune only this table.
        // Retain its relation identity and every other table, including auth.
        if (table.relname === 'direct_mcp_request_history') continue;
        const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        const actual = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows; assert(actual.length <= 10000);
        // An assertion failure must not print raw session or credential rows.
        rows[table.relname] = { count: actual.length, rowsAndXminSha256: sha(JSON.stringify(actual)) };
      }
      return { tables, rows };
    };
    const filesystem = async () => {
      const rows: unknown[] = [];
      const visit = async (relative: string): Promise<void> => {
        // The original HTTP dispatcher intentionally records successful usage
        // here (diagnostics -> connection-usage), including successful reads.
        // Exclude only that exact operational subtree; retain every other DATA
        // path, including workspace bytes, journals, assets, backups and trash.
        if (relative === path.join('users', 'member', 'mcp', 'server-usage')) return;
        assert(rows.length < 10000); const full = path.join(h.dataRoot, relative), st = await fs.lstat(full, { bigint: true });
        assert(!st.isSymbolicLink()); const entry = { path: relative, dev: String(st.dev), ino: String(st.ino), mode: String(st.mode),
          size: String(st.size), mtime: String(st.mtimeNs), ctime: String(st.ctimeNs) };
        rows.push(st.isFile() ? { ...entry, sha256: sha(await fs.readFile(full)) } : entry);
        if (st.isDirectory()) for (const name of (await fs.readdir(full)).sort()) await visit(path.join(relative, name));
      };
      await visit(''); return rows;
    };
    const requestTraceWrite = (event: MetadataSqlEvent): boolean => {
      const sql = event.text.replace(/\s+/gu, ' ').trim();
      const inserted = /^insert into "direct_mcp_request_history" \(((?:"[a-z_]+"(?:, )?)+)\) values \(((?:\$[0-9]+(?:, )?)+)\)$/iu.exec(sql);
      if (inserted) {
        const columns = [...inserted[1].matchAll(/"([a-z_]+)"/gu)].map(match => match[1]);
        assert.deepEqual([...columns].sort(), ['id','request_id','server_version','flow_ref','phase','http_method','client_name',
          'operation','tool_name','outcome','status_code','code','duration_ms','created_at','expires_at'].sort());
        assert.equal(event.values.length, columns.length); assert.equal(event.result.rowCount, 1);
        assert.deepEqual([...inserted[2].matchAll(/\$([0-9]+)/gu)].map(match => Number(match[1])), columns.map((_, index) => index + 1));
      } else if (/^delete from "direct_mcp_request_history" where "direct_mcp_request_history"\."expires_at" <= \$1$/iu.test(sql)) {
        assert.equal(event.values.length, 1); assert(Number.isFinite(new Date(event.values[0] as string).getTime()));
      } else if (/^delete from "direct_mcp_request_history" where "direct_mcp_request_history"\."id" in \((?:\$[0-9]+(?:, )?)+\)$/iu.test(sql)) {
        assert(event.values.length > 0 && event.values.length <= 100);
        assert(event.values.every(value => typeof value === 'string' && /^direct-mcp-request-[a-f0-9-]{36}$/u.test(value)));
      } else return false;
      for (const value of event.values) if (typeof value === 'string') {
        assert(!value.includes(h.dataRoot) && !value.includes(originalToken) && !value.includes(currentToken));
      }
      return true;
    };
    const noMutation = async <T>(callback: () => Promise<T>) => {
      const before = await domain(), files = await filesystem(), writes: string[] = [];
      const result = await h.withProbe(async event => {
        if (/^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/iu.test(event.text) && !requestTraceWrite(event)) writes.push(event.text);
      }, callback);
      assert.deepEqual(writes, []); assert.deepEqual(await domain(), before); assert.deepEqual(await filesystem(), files); return result;
    };
    const slots = { api_version: 1, workspace_id: h.source.workspaceId };
    const fixture = async (withPdf = false) => {
      const id = crypto.randomUUID(), source = `public-${id}.md`, destination = `public-${id}-moved.md`, incoming = `public-${id}-incoming.md`;
      const pdfPath = `public-${id}.pdf`, destinationPdf = `public-${id}-moved.pdf`, pdf = Buffer.from('%PDF-1.7\nactual public path bytes\n%%EOF\n');
      const note = await h.upload(source, Buffer.from('# Native public path body\n'));
      if (withPdf) await fs.writeFile(path.join(h.source.rootPath, pdfPath), pdf, { flag: 'wx', mode: 0o600 });
      const refs = await h.upload(incoming, Buffer.from(`[Original](${source})${withPdf ? ` [PDF](${pdfPath})` : ''}\n`));
      await h.metadata(h.source, source, { title: `Title ${id}`, isFavorite: true, pinned: true }, 'member');
      await fs.unlink(path.join(h.source.rootPath, source)); const state = await load(h.connection, note.documentId); assert(state);
      const original = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [note.documentId])).rows[0]; assert(original);
      return { source, destination, incoming, pdfPath, destinationPdf, pdf, documentId: note.documentId, incomingId: refs.documentId,
        binary: Buffer.from(state.yjsState), vector: Buffer.from(state.stateVector), lineageId: original.lineage_id };
    };
    const registry = async (documentId: string) => {
      const rows = (await h.admin.query('SELECT id,path,status,lineage_id FROM collaboration_documents WHERE id=$1', [documentId])).rows;
      assert.equal(rows.length, 1); return rows[0];
    };
    const confirmed = (value: Record<string, unknown>, operationId: string, planId: string) => {
      const operation = object(value.operation); assert.equal(operation.operationId, operationId); assert.equal(operation.planId, planId);
      assert.equal(operation.workspaceId, h.source.workspaceId); assert.equal(object(operation.completion).status, 'confirmed');
      assert.equal(object(operation.execution).finalization, 'complete'); assert.equal(object(operation.execution).receiptStatus, 'available'); return operation;
    };
    const watcherRuntime = globalThis as typeof globalThis & { __canvasFileWatcherService?: ReturnType<typeof getFileWatcher> };
    assert.equal(watcherRuntime.__canvasFileWatcherService, undefined); const watcher = getFileWatcher(), events: FileEvent[] = [], listener = `path-http-${crypto.randomUUID()}`;
    const unsubscribe = watcher.subscribe({ id: listener, workspaceId: h.source.workspaceId, workspace: h.source, send: event => events.push(event) });
    try {
      const deadline = Date.now() + 5000;
      while (!watcher.getSubscribedDirs(h.source.workspaceId).includes('.')) {
        assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
      }
      watcher.unsubscribeAll(listener); const cacheKey = buildFileTreeCacheKey('.', 4, h.source.workspaceId);
      const eventSummary = () => events.map(e => ({ path: e.relativePath, type: e.type })).sort((a, b) => a.path.localeCompare(b.path));
      const group = async (name: string, callback: () => Promise<void>) => { currentCase = name; await callback(); groups++; console.log(`passed ${groups}: ${name}`); };
      await group('real tools/list exposes opt-in schemas and malformed requests do not mutate', async () => {
        const listed = object((await rpc('tools/list', {})).result).tools; assert(Array.isArray(listed));
        for (const kind of ['move', 'delete'] as const) {
          assert(!new Set<string>(DIRECT_MCP_DEFAULT_TOOL_IDS).has(tool(kind))); assert(DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS.includes(tool(kind)));
          const selected: Record<string, unknown> | undefined = listed.map(object).find(row => row.name === tool(kind)); assert(selected);
          assert.deepEqual(selected.inputSchema, kind === 'move' ? contract.DIRECT_MCP_WORKSPACE_MOVE_INPUT_SCHEMA_V1 : contract.DIRECT_MCP_WORKSPACE_DELETE_INPUT_SCHEMA_V1);
          await noMutation(() => failure(kind, { ...slots, api_version: 99, action: 'preview', path: '../outside.md' }, 'INVALID_REQUEST'));
        }
      });
      const moved = await fixture(true), moveId = crypto.randomUUID(), moveSelections = [
        { source_path: moved.source, destination_path: moved.destination }, { source_path: moved.pdfPath, destination_path: moved.destinationPdf }];
      let movePlan = '', moveBatch = '';
      await group('preview is stable and read-only for a native document without projection', async () => {
        events.length = 0; const args = { ...slots, action: 'preview', selections: moveSelections };
        const first = await noMutation(() => success('move', args)), second = await noMutation(() => success('move', args));
        assert.deepEqual(first, second); const preview = object(first.preview); movePlan = String(preview.planId);
        assert.match(movePlan, /^[a-f0-9]{64}$/u); assert.equal(preview.kind, 'move'); assert.deepEqual(events, []);
        assert.equal(object(preview.linkChanges).rewrites, 2); assert.equal(object(preview.linkChanges).affectedDocuments, 1);
      });
      await group('public Move preserves native identity/body and updates actual incoming links and views', async () => {
        events.length = 0; fileTreeCache.set(cacheKey, []);
        const value = await success('move', { ...slots, action: 'apply', operation_id: moveId, plan_id: movePlan, selections: moveSelections });
        const operation = confirmed(value, moveId, movePlan); moveBatch = String(operation.batchId); assert.equal(value.alreadyKnown, false);
        const row = await registry(moved.documentId); assert.equal(row.path, moved.destination); assert.equal(row.lineage_id, moved.lineageId); assert.equal(row.status, 'active');
        const state = await load(h.connection, moved.documentId); assert(state); assert.deepEqual(Buffer.from(state.yjsState), moved.binary); assert.deepEqual(Buffer.from(state.stateVector), moved.vector);
        const incoming = await load(h.connection, moved.incomingId); assert(incoming);
        assert.deepEqual(links(incoming).links.map(link => link.targetPathText).sort(), [moved.destination, moved.destinationPdf].sort());
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, moved.destinationPdf)), moved.pdf);
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, moved.pdfPath)), { code: 'ENOENT' });
        assert.equal((await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, moved.destination])).rows[0].title.startsWith('Title '), true);
        assert.deepEqual(eventSummary(), [{ path: moved.source, type: 'unlink' }, { path: moved.destination, type: 'add' },
          { path: moved.pdfPath, type: 'unlink' }, { path: moved.destinationPdf, type: 'add' }].sort((a, b) => a.path.localeCompare(b.path)));
        assert.equal(fileTreeCache.get(cacheKey), undefined);
      });
      await group('completed Move status, duplicate apply and explicit recover do not rewrite rows or files', async () => {
        for (const action of ['status', 'apply', 'recover']) {
          events.length = 0; const value = await noMutation(() => success('move', { ...slots, action, operation_id: moveId,
            ...(action === 'status' ? {} : { plan_id: movePlan, selections: moveSelections }) }));
          assert.equal(confirmed(value, moveId, movePlan).batchId, moveBatch); if (action !== 'status') assert.equal(value.alreadyKnown, true); assert.deepEqual(events, []);
        }
      });
      await group('public Delete archives the same document and removes incoming link markup', async () => {
        const preview = object((await noMutation(() => success('delete', { ...slots, action: 'preview', path: moved.destination }))).preview);
        assert.equal(object(preview.linkChanges).unlinks, 1); const deleteId = crypto.randomUUID(), planId = String(preview.planId);
        events.length = 0; fileTreeCache.set(cacheKey, []);
        const value = await success('delete', { ...slots, action: 'apply', operation_id: deleteId, plan_id: planId, path: moved.destination });
        const operation = confirmed(value, deleteId, planId); assert.equal((await registry(moved.documentId)).status, 'archived');
        const incoming = await load(h.connection, moved.incomingId); assert(incoming); assert.deepEqual(links(incoming).links.map(link => link.targetPathText), [moved.destinationPdf]);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_trash_entries WHERE original_path=$1 AND deleted_by_user_id=\'member\' AND status=\'trashed\'', [moved.destination])).rows[0].n, 1);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_file_operation_delete_receipts WHERE batch_id=$1', [operation.batchId])).rows[0].n, 1);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, moved.destination])).rows[0].n, 0);
        assert.deepEqual(eventSummary(), [{ path: moved.destination, type: 'unlink' }]); assert.equal(fileTreeCache.get(cacheKey), undefined);
        for (const action of ['status', 'recover']) {
          events.length = 0; const repeated = await noMutation(() => success('delete', { ...slots, action, operation_id: deleteId,
            ...(action === 'status' ? {} : { plan_id: planId, path: moved.destination }) })); confirmed(repeated, deleteId, planId); assert.deepEqual(events, []);
        }
      });
      await group('wrong-plan, wrong-workspace and absent recover do not create or change an operation', async () => {
        await noMutation(() => failure('move', { ...slots, action: 'apply', operation_id: moveId,
          plan_id: '0'.repeat(64), selections: moveSelections }, 'PATH_PLAN_CHANGED'));
        await noMutation(() => failure('move', { ...slots, workspace_id: h.destination.workspaceId, action: 'status',
          operation_id: moveId }, 'PATH_STATUS_NOT_FOUND'));
        for (const kind of ['move', 'delete'] as const) await noMutation(() => failure(kind, { ...slots, action: 'recover',
          operation_id: crypto.randomUUID(), plan_id: movePlan,
          ...(kind === 'move' ? { selections: moveSelections } : { path: moved.destination }) }, 'PATH_OPERATION_NOT_FOUND'));
      });
      for (const kind of ['move', 'delete'] as const) for (const phase of ['claim', 'completion'] as const) {
        await group(`${kind}: actual ${phase} COMMIT ACK loss retains caller ID and recovers the original`, async () => {
          const job = await fixture(), selectedPaths = kind === 'move'
            ? { selections: [{ source_path: job.source, destination_path: job.destination }] } : { path: job.source };
          const preview = object((await success(kind, { ...slots, action: 'preview', ...selectedPaths })).preview), planId = String(preview.planId);
          const operationId = crypto.randomUUID(), args = { ...slots, action: 'apply', operation_id: operationId, plan_id: planId, ...selectedPaths };
          const table = phase === 'claim' ? 'workspace_file_operation_batches' : `workspace_file_operation_${kind}_receipts`;
          let selected: MetadataSqlEvent['client'] | undefined, fired = false, batchId = '';
          let insertedRows: unknown;
          events.length = 0; const beforeFiles = await filesystem();
          const value = await h.withProbe(async event => {
            if (/^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(table) && !selected) {
              assert.equal(event.result.command, 'INSERT'); assert.equal(event.result.rowCount, 1);
              batchId = String(event.values[0]); assert.match(batchId, /^[a-f0-9]{64}$/u); selected = event.client;
              insertedRows = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [batchId])).rows;
              assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE batch_id=$1`, [batchId])).rows[0].n, 0);
            }
            if (/^\s*COMMIT\s*$/iu.test(event.text) && event.client === selected && !fired) {
              assert.equal(event.result.command, 'COMMIT');
              assert.deepEqual((await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [batchId])).rows, insertedRows);
              fired = true; throw Object.assign(new Error('Lost ACK after independently visible actual COMMIT.'), { code: 'FIXTURE_PUBLIC_PATH_COMMIT_ACK_LOST' });
            }
          }, () => failure(kind, args, 'PATH_OUTCOME_UNCONFIRMED'));
          assert(fired && selected && batchId); assert.equal(value.value.operationId, operationId);
          const status = await noMutation(() => success(kind, { ...slots, action: 'status', operation_id: operationId }));
          assert.equal(object(status.operation).batchId, batchId);
          if (phase === 'claim') {
            assert.equal(object(object(status.operation).completion).status, 'not_confirmed'); assert.deepEqual(await filesystem(), beforeFiles); assert.deepEqual(events, []);
            assert.equal((await h.admin.query(`UPDATE workspace_file_operation_batches SET lease_expires_at=1
              WHERE batch_id=$1 AND status='applying' RETURNING batch_id`, [batchId])).rowCount, 1);
          } else {
            confirmed(status, operationId, planId);
            assert.equal(object(object(status.operation).journal).status, 'needs_recovery');
          }
          const recovered = await success(kind, { ...args, action: 'recover' }); assert.equal(confirmed(recovered, operationId, planId).batchId, batchId);
          const row = await registry(job.documentId); assert.equal(row.status, kind === 'move' ? 'active' : 'archived');
          if (kind === 'move') assert.equal(row.path, job.destination);
          assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_file_operation_batches WHERE batch_id=$1', [batchId])).rows[0].n, 1);
          const original = (await h.admin.query('SELECT authorization_json FROM workspace_file_operation_batches WHERE batch_id=$1', [batchId])).rows[0];
          assert.equal(object(typeof original.authorization_json === 'string' ? JSON.parse(original.authorization_json) : original.authorization_json).actorSessionId, 'session-member');
        });
      }
      await group('renewed real session reads original attribution and delete-right revocation denies status', async () => {
        const now = Date.now(), sid = `path-current-${crypto.randomUUID()}`, raw = crypto.randomBytes(32).toString('hex');
        await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)', [sid, raw, now + 3600000, now]);
        currentToken = await issue(sid); await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=\'session-member\'');
        confirmed(await noMutation(() => success('move', { ...slots, action: 'status', operation_id: moveId })), moveId, movePlan);
        const row = (await h.admin.query('SELECT authorization_json FROM workspace_file_operation_batches WHERE batch_id=$1', [moveBatch])).rows[0]; assert(row);
        const original = typeof row.authorization_json === 'string' ? JSON.parse(row.authorization_json) : row.authorization_json;
        assert.equal(original.actorSessionId, 'session-member'); assert.equal(original.clientId, clientId);
        await h.admin.query('UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id=\'principal-org\' AND user_id=\'member\'');
        try { await noMutation(() => failure('move', { ...slots, action: 'status', operation_id: moveId }, 'ACCESS_DENIED')); }
        finally { await h.admin.query('UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id=\'principal-org\' AND user_id=\'member\''); }
        // Expired session is rejected by the genuine HTTP authentication layer
        // before dispatch. It must retain its actual 401 and OAuth challenge.
        const denied = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${originalToken}`,
          'mcp-protocol-version': protocol, 'mcp-method': 'tools/call', 'mcp-name': 'move_knowledge_source',
        }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: {
          name: 'move_knowledge_source', arguments: { ...slots, action: 'status', operation_id: moveId },
          _meta: { 'io.modelcontextprotocol/protocolVersion': protocol,
            'io.modelcontextprotocol/clientInfo': { name: 'actual-path-dispatch-fixture', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {} },
        } }) }));
        assert.equal(denied.status, 401); assert(denied.headers.get('www-authenticate')?.includes('resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"'));
        await denied.body?.cancel();
      });
    } finally { unsubscribe(); watcher.stop(); assert.equal(watcherRuntime.__canvasFileWatcherService, watcher); delete watcherRuntime.__canvasFileWatcherService; }
  }); completed = true; console.log(`direct MCP workspace path tool PostgreSQL: ${groups} groups passed`);
  } finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}
void directMcpWorkspacePathToolPostgresTest().catch(error => { console.error('Public path integration failed', { currentCase, error }); process.exitCode = 1; });
