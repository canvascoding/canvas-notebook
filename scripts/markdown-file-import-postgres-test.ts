import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Pool, types, type PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { MARKDOWN_FILE_IMPORT_STATEMENTS } from '../app/lib/db/markdown-file-import-migration';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { persistMarkdownFileImport, type MarkdownFileImportRequest, type MarkdownImportTarget } from '../app/lib/collaboration/markdown-file-import-persistence';
import { MarkdownFileImportError } from '../app/lib/collaboration/markdown-file-import';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { loadCollaborationStateOnConnection, serializeCanonicalText, type PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { collaborationAdmissionActionDigest, type CollaborationAdmissionDocument, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationRoomOwnerSession, lockIdentity, type CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';
import { installCollaborationRoomInspector } from '../app/lib/collaboration/runtime-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { WorkspaceFileLifecycleBusyError } from '../app/lib/files/workspace-file-lifecycle-guard';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { nativeRichDocumentFixture } from './helpers/rich-markdown-projection-fixtures';

const SCHEMA = /^canvas_markdown_import_test_[0-9a-f]{32}$/u;
const TABLES = ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states',
  'collaboration_yjs_state_backups', 'collaboration_agent_operations', 'file_revisions',
  'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets', 'collaboration_room_release_receipts'] as const;
type Fault = { commit?: 'before' | 'after'; afterCommit?: () => Promise<void> };
function managedDatabase(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '55433' || decodeURIComponent(url.pathname) !== '/canvas_notebook') throw new Error('Markdown import test accepts only managed loopback PG18.');
  return url;
}
function namespace(schema: string): string {
  if (!SCHEMA.test(schema)) throw new Error('Refusing a non-generated Markdown-import schema.');
  return `"${schema}"`;
}
function connections(pool: Pool, fault: Fault = {}) {
  return async (): Promise<SqlConnection> => {
    const client = await pool.connect(); let closed = false, imported = false;
    const query = async (sql: string, values: unknown[] = []) => {
      if (/INSERT INTO collaboration_markdown_file_import_receipts/u.test(sql)) imported = true;
      if (/^COMMIT$/iu.test(sql) && imported && fault.commit === 'before') { delete fault.commit; throw new Error('Injected import COMMIT failure'); }
      const result = await client.query(sql, values);
      if (/^COMMIT$/iu.test(sql) && imported && fault.commit === 'after') {
        delete fault.commit; await fault.afterCommit?.(); throw new Error('Injected lost import COMMIT response');
      }
      return result.rows;
    };
    return { run: query, all: query, get: async (sql, values) => (await query(sql, values))[0],
      close: async error => { if (!closed) { closed = true; client.release(error); } } };
  };
}
type ImportTraceStep = 'open' | 'lineage' | 'registry' | 'state' | 'receipt' | 'retry' | 'begin' | 'commit' | 'rollback' | 'close' | 'removed';
type ImportConnectionIdentity = { backendPid: number; xid: string | null; schema: string; isolation: string; readOnly: string };
type ImportTrace = ImportConnectionIdentity & { step: ImportTraceStep; outcome: 'done' | 'failed' | 'discard' };
function tracedImportConnections(pool: Pool, schema: string, fault: Fault = {}, rejectReceipt = false) {
  const events: ImportTrace[] = [], opened = new Map<number, ImportConnectionIdentity>(), factory = connections(pool, fault);
  const removed = (client: PoolClient) => {
    const identity = opened.get((client as PoolClient & { processID: number }).processID);
    if (identity) events.push({ ...identity, step: 'removed', outcome: 'done' });
  };
  pool.on('remove', removed);
  const openConnection = async (): Promise<SqlConnection> => {
    const inner = await factory();
    const inspect = async () => {
      const identity = await inner.get(`SELECT pg_backend_pid()::int AS "backendPid",pg_current_xact_id_if_assigned()::text AS xid,
        current_schema() AS schema,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS "readOnly"`) as ImportConnectionIdentity;
      assert.equal(identity.schema, schema, 'trace must stay inside the isolated PostgreSQL schema');
      return identity;
    };
    let identity: ImportConnectionIdentity;
    try { identity = await inspect(); }
    catch (error) { await inner.close(new Error('Discarding failed import trace connection.', { cause: error })); throw error; }
    opened.set(identity.backendPid, identity);
    events.push({ ...identity, step: 'open', outcome: 'done' });
    const query = async (sql: string, values: unknown[] = []) => {
      const command = sql.trimStart();
      const step: ImportTraceStep | undefined = /^(?:INSERT INTO|UPDATE) file_collaboration_lineages\b/u.test(command) ? 'lineage'
        : /^(?:INSERT INTO|UPDATE) collaboration_documents\b/u.test(command) ? 'registry'
        : /^(?:INSERT INTO|UPDATE) collaboration_yjs_states\b/u.test(command) ? 'state'
        : /^INSERT INTO collaboration_markdown_file_import_receipts\b/u.test(command) ? 'receipt'
        : /^SELECT \* FROM collaboration_markdown_file_import_receipts\b/u.test(command) ? 'retry'
        : /^BEGIN\b/iu.test(command) ? 'begin' : /^COMMIT$/iu.test(command) ? 'commit' : /^ROLLBACK$/iu.test(command) ? 'rollback' : undefined;
      if (!step) return inner.all(sql, values);
      // A failed PostgreSQL statement poisons its transaction: ROLLBACK must
      // execute without an extra SELECT in that aborted transaction.
      if (step !== 'rollback') identity = await inspect();
      const before = identity;
      const parameters = step === 'receipt' && rejectReceipt ? values.map((value, index) => index === 3 ? 'x'.repeat(257) : value) : values;
      try {
        const rows = await inner.all(sql, parameters);
        identity = step === 'commit' || step === 'rollback' ? before : await inspect();
        events.push({ ...identity, step, outcome: 'done' }); return rows;
      } catch (error) { events.push({ ...before, step, outcome: 'failed' }); throw error; }
    };
    return { run: query, all: query, get: async (sql, values) => (await query(sql, values))[0],
      close: async error => { await inner.close(error); events.push({ ...identity, step: 'close', outcome: error ? 'discard' : 'done' }); } };
  };
  return { events, openConnection, dispose: () => pool.off('remove', removed) };
}
function assertImportRecoveryOrder(events: ImportTrace[]) {
  const mutation = events.find(event => event.step === 'state' && event.outcome === 'done'); assert.ok(mutation?.xid);
  const failedCommit = events.findIndex(event => event.backendPid === mutation.backendPid && event.step === 'commit' && event.outcome === 'failed');
  const removed = events.findIndex(event => event.backendPid === mutation.backendPid && event.step === 'removed');
  const discarded = events.findIndex(event => event.backendPid === mutation.backendPid && event.step === 'close' && event.outcome === 'discard');
  const recovery = events.findIndex((event, index) => index > discarded && event.step === 'retry');
  // pg-pool removes the client from its reusable set synchronously, but emits
  // `remove` only when client.end completes; both must precede the ledger read.
  assert.ok(failedCommit >= 0 && removed > failedCommit && discarded > failedCommit && recovery > discarded && recovery > removed,
    'uncertain mutation backend must be removed from the actual Pool and closed before recovery reads its ledger');
  assert.notEqual(events[recovery].backendPid, mutation.backendPid);
  assert.equal(events[recovery].isolation, 'repeatable read'); assert.equal(events[recovery].readOnly, 'on');
  assert.equal(events.filter(event => event.backendPid === events[recovery].backendPid && ['registry', 'state', 'receipt'].includes(event.step)).length, 0);
  assert.equal(events.filter(event => event.backendPid === mutation.backendPid && event.step === 'close').length, 1);
  assert.ok(events.some(event => event.backendPid === events[recovery].backendPid && event.step === 'close'));
}
const code = (expected: string) => (error: unknown) => error instanceof MarkdownFileImportError && error.code === expected;
const busy = (error: unknown) => error instanceof WorkspaceFileLifecycleBusyError;
function expected(state: PersistedCollaborationState): MarkdownImportTarget {
  return { kind: 'initialized', documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
    path: state.path, representation: state.representation, schemaVersion: state.schemaVersion, lifecycleGeneration: state.lifecycleGeneration,
    documentSequence: state.documentSequence, stateProof: authoritativeNativeCollaborationSnapshot(state).version.stateProof,
    newlineStyle: state.newlineStyle, hasBom: state.hasBom };
}
async function main() {
  const url = managedDatabase();
  if (!url) { console.log('SKIP complete Markdown import PostgreSQL fixtures: managed PG18 connection not supplied.'); return; }
  const schema = `canvas_markdown_import_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 3000, allowExitOnIdle: true });
  let pool: Pool | undefined, owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-markdown-import-'));
  const previousData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = directory;
  try {
    assert.equal(Math.floor(Number((await admin.query(`SELECT current_setting('server_version_num')::int AS version`)).rows[0].version) / 10000), 18);
    await admin.query(`CREATE SCHEMA ${namespace(schema)}`);
    const options = `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=8000`;
    pool = new Pool({ connectionString: url.href, max: 8, connectionTimeoutMillis: 3000, allowExitOnIdle: true, options,
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8 ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) } });
    const fixturePool = pool, openConnection = connections(pool);
    for (const table of TABLES) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    // Exercise an upgrade from the original standalone v1 table as well as
    // repeated installation. Its missing length CHECKs must not bypass the guard.
    await pool.query(`CREATE TABLE collaboration_markdown_file_import_receipts (
      workspace_id text NOT NULL,operation_id text NOT NULL,organization_id text,actor_user_id text NOT NULL,
      actor_session_id text,request_id text NOT NULL,version integer NOT NULL CHECK(version=1),
      request_fingerprint text NOT NULL,private_result jsonb NOT NULL,after_state_snapshot bytea NOT NULL,created_at bigint NOT NULL,
      PRIMARY KEY(workspace_id,operation_id),UNIQUE NULLS NOT DISTINCT(workspace_id,actor_user_id,actor_session_id,request_id))`);
    for (let repeat = 0; repeat < 2; repeat++) for (const statement of MARKDOWN_FILE_IMPORT_STATEMENTS) await pool.query(statement);
    const workspace: WorkspaceContext = { workspaceId: `${schema}-workspace`, organizationId: null, workspaceType: 'personal',
      rootPath: directory, legacy: false, status: 'active', actor: { userId: 'import-tester', role: 'owner' },
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } };
    let authorityChecks = 0;
    const request = (filePath: string, source: string, expectedTarget: MarkdownImportTarget = { kind: 'absent' }): MarkdownFileImportRequest => ({
      workspace, path: filePath, operationId: `operation-${filePath}`, requestId: `request-${filePath}`, actorUserId: 'import-tester',
      actorSessionId: 'import-session', bytes: Buffer.from(source), expectedTarget, validateAuthority: async () => { authorityChecks++; },
    });
    const load = async (documentId: string) => { const connection = await openConnection();
      try { const state = await loadCollaborationStateOnConnection(connection, documentId); assert.ok(state); return state; }
      finally { await connection.close(); } };
    const seed = async (filePath: string, representation: PersistedCollaborationState['representation'], content = '', profile = { newlineStyle: 'lf' as 'lf' | 'crlf', hasBom: false }) => {
      const document = representation === 'plain_text' ? createPlainTextYDoc(content) : content
        ? createRichMarkdownYDoc(content, representation)
        : nativeRichDocumentFixture({ type: 'doc', content: [{ type: 'paragraph' }] }, representation);
      const documentId = `collab-${randomUUID()}`, lineageId = `lineage-${randomUUID()}`;
      try {
        await fixturePool.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,path,status,created_at) VALUES($1,$2,'personal',$3,'active',1)`, [lineageId, workspace.workspaceId, filePath]);
        await fixturePool.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
          VALUES($1,$2,$3,'personal',$4,'yjs','active',0,1,1,'initialized')`, [documentId, lineageId, workspace.workspaceId, filePath]);
        await fixturePool.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
          document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status) VALUES($1,$2,$3,$4,3,1,$5,$6,4,1,0,$7,$8,0,'active')`,
        [documentId, workspace.workspaceId, filePath, representation, Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document)), profile.newlineStyle, profile.hasBom ? 1 : 0]);
      } finally { document.destroy(); }
      return load(documentId);
    };
    const actualContent = (state: PersistedCollaborationState) => {
      const doc = new Y.Doc(); try { Y.applyUpdate(doc, state.yjsState);
        const canonical = state.representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc);
        return serializeCanonicalText(canonical, state);
      } finally { doc.destroy(); }
    };
    const originalPhysical = '# Physical sentinel\n';
    await writeFile(path.join(directory, 'fresh.md'), originalPhysical);
    const full = '\uFEFF---\r\ntitle: Complete import\r\n---\r\n\r\n# Heading\r\n';
    const freshRequest = request('fresh.md', full);
    const first = await persistMarkdownFileImport(freshRequest, { openConnection });
    assert.equal(first.disposition, 'applied'); assert.equal(first.receipt.target.representation, 'tiptap_blocks');
    const fresh = await load(first.receipt.target.documentId);
    assert.equal(actualContent(fresh), full); assert.equal(fresh.documentSequence, 0); assert.equal(fresh.checkpointedAt, null);
    assert.equal(fresh.canonicalHash, null); assert.equal(fresh.serializedHash, null); assert.equal(first.receipt.checkpointRequired, true);
    assert.equal(JSON.stringify(first).includes('Complete import'), false);
    assert.equal(JSON.stringify(first).includes('yjsState'), false); assert.equal(JSON.stringify(first).includes('stateVector'), false);
    assert.equal((await pool.query(`SELECT octet_length(after_state_snapshot)>0 AS present FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1`, [freshRequest.operationId])).rows[0].present, true);
    assert.equal(await readFile(path.join(directory, 'fresh.md'), 'utf8'), originalPhysical, 'import never overwrites a physical projection');
    assert.equal((await persistMarkdownFileImport(freshRequest, { openConnection })).disposition, 'already-applied');
    const storedReceipt = (await pool.query(`SELECT * FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1`, [freshRequest.operationId])).rows[0];
    assert.equal(storedReceipt.live_yjs_state_sha256, createHash('sha256').update(fresh.yjsState).digest('hex'));
    assert.equal(storedReceipt.live_state_vector_sha256, createHash('sha256').update(fresh.stateVector).digest('hex'));
    for (const sql of [
      `UPDATE collaboration_markdown_file_import_receipts SET private_result=private_result WHERE operation_id=$1`,
      `UPDATE collaboration_markdown_file_import_receipts SET actor_user_id='other-user' WHERE operation_id=$1`,
      `DELETE FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1`,
    ]) await assert.rejects(() => fixturePool.query(sql, [freshRequest.operationId]), error => (error as { code?: string }).code === '55000');
    const invalidInsert = async (mutate: (row: typeof storedReceipt) => void, label: string) => {
      const row = { ...storedReceipt, private_result: structuredClone(storedReceipt.private_result),
        operation_id: `invalid-${randomUUID()}`, request_id: `invalid-request-${randomUUID()}` };
      row.private_result.operationId = row.operation_id; mutate(row);
      await assert.rejects(() => fixturePool.query(`INSERT INTO collaboration_markdown_file_import_receipts(workspace_id,operation_id,organization_id,
        actor_user_id,actor_session_id,request_id,version,request_fingerprint,private_result,after_state_snapshot,created_at,live_yjs_state_sha256,live_state_vector_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
      [row.workspace_id, row.operation_id, row.organization_id, row.actor_user_id, row.actor_session_id, row.request_id,
        row.version, row.request_fingerprint, JSON.stringify(row.private_result), row.after_state_snapshot, row.created_at,
        row.live_yjs_state_sha256, row.live_state_vector_sha256]), error => (error as { code?: string }).code === '23514', label);
    };
    for (const [label, mutate] of [
      ['foreign document', (row: typeof storedReceipt) => { row.private_result.target.documentId = 'foreign-document'; }],
      ['foreign workspace', (row: typeof storedReceipt) => { row.private_result.target.workspaceId = 'foreign-workspace'; }],
      ['foreign organization', (row: typeof storedReceipt) => { row.private_result.target.organizationId = 'foreign-organization'; }],
      ['foreign lineage', (row: typeof storedReceipt) => { row.private_result.target.lineageId = 'foreign-lineage'; }],
      ['foreign path', (row: typeof storedReceipt) => { row.private_result.target.path = 'foreign.md'; }],
      ['wrong representation', (row: typeof storedReceipt) => { row.private_result.target.representation = 'plain_text'; }],
      ['wrong schema', (row: typeof storedReceipt) => { row.private_result.target.schemaVersion = 2; }],
      ['wrong generation', (row: typeof storedReceipt) => { row.private_result.target.lifecycleGeneration++; }],
      ['wrong sequence', (row: typeof storedReceipt) => { row.private_result.target.initialSequence++; }],
      ['wrong timestamp', (row: typeof storedReceipt) => { row.private_result.target.persistedAt++; row.created_at++; }],
      ['wrong BOM profile', (row: typeof storedReceipt) => { row.private_result.target.hasBom = false; }],
      ['wrong newline profile', (row: typeof storedReceipt) => { row.private_result.target.newlineStyle = 'lf'; }],
      ['wrong snapshot proof', (row: typeof storedReceipt) => { row.after_state_snapshot = Buffer.from([0, 0]); }],
      ['wrong native binary digest', (row: typeof storedReceipt) => { row.live_yjs_state_sha256 = '0'.repeat(64); }],
      ['wrong native vector digest', (row: typeof storedReceipt) => { row.live_state_vector_sha256 = '0'.repeat(64); }],
      ['missing target field', (row: typeof storedReceipt) => { delete row.private_result.target.organizationId; }],
      ['unknown target field', (row: typeof storedReceipt) => { row.private_result.target.futureField = true; }],
      ['string sequence', (row: typeof storedReceipt) => { row.private_result.target.initialSequence = '0'; }],
      ['fractional source bytes', (row: typeof storedReceipt) => { row.private_result.sourceBytes = 1.5; }],
      ['oversized private JSON', (row: typeof storedReceipt) => { row.private_result.padding = 'x'.repeat(32769); }],
      ['oversized actor', (row: typeof storedReceipt) => { row.actor_user_id = 'x'.repeat(257); }],
      ['oversized session', (row: typeof storedReceipt) => { row.actor_session_id = 'x'.repeat(257); }],
      ['oversized request', (row: typeof storedReceipt) => { row.request_id = 'x'.repeat(257); }],
      ['control in operation', (row: typeof storedReceipt) => { row.operation_id += '\n'; row.private_result.operationId = row.operation_id; }],
    ] as const) await invalidInsert(mutate, label);
    const deletionSensitive = await seed('deleted-empty.md', 'plain_text', 'previous text');
    const emptiedDoc = new Y.Doc();
    try { Y.applyUpdate(emptiedDoc, deletionSensitive.yjsState); emptiedDoc.getText('content').delete(0, emptiedDoc.getText('content').length);
      await pool.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2 WHERE document_id=$3`,
      [Buffer.from(Y.encodeStateAsUpdate(emptiedDoc)), Buffer.from(Y.encodeStateVector(emptiedDoc)), deletionSensitive.documentId]);
    } finally { emptiedDoc.destroy(); }
    const emptied = await load(deletionSensitive.documentId);
    const deletionRequest = request(emptied.path, '# Native import\n', expected(emptied));
    const deletionImport = await persistMarkdownFileImport(deletionRequest, { openConnection });
    const deletionRow = (await pool.query(`SELECT * FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1`, [deletionRequest.operationId])).rows[0];
    const snapshot = Y.decodeSnapshot(deletionRow.after_state_snapshot);
    assert.ok(snapshot.ds.clients.size > 0, 'receipt proof must contain actual delete ranges');
    assert.equal(deletionImport.receipt.target.initialStateProof,
      `yjs-snapshot-sha256-v1:${createHash('sha256').update(deletionRow.after_state_snapshot).digest('hex')}`);
    for (const override of [{ actorUserId: 'other-user', workspace: { ...workspace, actor: undefined } }, { actorSessionId: 'other-session' },
      { requestId: 'other-request' }, { operationId: 'different-operation' }, { bytes: Buffer.from('# changed\n') }]) {
      await assert.rejects(() => persistMarkdownFileImport({ ...freshRequest, ...override }, { openConnection }), code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));
    }
    const sourceOnly = '---\ninvalid: [\n---\nA\tB😀\n';
    const plain = await persistMarkdownFileImport(request('source.md', sourceOnly), { openConnection });
    assert.equal(plain.receipt.target.representation, 'plain_text'); assert.equal(actualContent(await load(plain.receipt.target.documentId)), sourceOnly);
    for (const representation of ['plain_text', 'tiptap_blocks'] as const) {
      const emptyRequest = { ...request(`new-empty-${representation}.md`, ''), representation };
      const empty = await persistMarkdownFileImport(emptyRequest, { openConnection });
      assert.equal(actualContent(await load(empty.receipt.target.documentId)), '');
      assert.equal((await persistMarkdownFileImport(emptyRequest, { openConnection })).disposition, 'already-applied');
    }
    const pristineId = `collab-${randomUUID()}`;
    await pool.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
      VALUES($1,$2,'personal','pristine.md','yjs','active',0,1,1,'never_initialized')`, [pristineId, workspace.workspaceId]);
    const pristine = await persistMarkdownFileImport(request('pristine.md', '# Pristine\n', { kind: 'pristine', documentId: pristineId }), { openConnection });
    assert.equal(pristine.receipt.target.documentId, pristineId);
    assert.equal((await pool.query(`SELECT yjs_state_lifecycle FROM collaboration_documents WHERE id=$1`, [pristineId])).rows[0].yjs_state_lifecycle, 'initialized');
    const legacyId = `collab-${randomUUID()}`;
    await pool.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
      VALUES($1,$2,'personal','legacy.md','yjs','active',0,1,1,'legacy_unknown')`, [legacyId, workspace.workspaceId]);
    await assert.rejects(() => persistMarkdownFileImport(request('legacy.md', '# Heading\n', { kind: 'pristine', documentId: legacyId }), { openConnection }), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    const mutable = request('frozen.md', '# Frozen request\n');
    const frozenPromise = persistMarkdownFileImport(mutable, { openConnection }); mutable.bytes.fill(65);
    const frozen = await frozenPromise;
    assert.equal(actualContent(await load(frozen.receipt.target.documentId)), '# Frozen request\n');
    let accessCalls = 0;
    await assert.rejects(() => persistMarkdownFileImport({ ...request('permission-denied.md', '# Heading\n'), validateAuthority: async () => {
      if (++accessCalls === 2) throw Object.assign(new Error('Current write permission revoked.'), { status: 403 });
    } }, { openConnection }), /permission revoked/u);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM file_collaboration_lineages WHERE path='permission-denied.md'`)).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_documents WHERE path='permission-denied.md'`)).rows[0].count, 0);
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const state = await seed(`empty-${representation}.md`, representation, '', { newlineStyle: 'crlf', hasBom: true });
      const input = request(state.path, full, expected(state));
      const imported = await persistMarkdownFileImport(input, { openConnection }), after = await load(state.documentId);
      assert.equal(imported.receipt.target.documentId, state.documentId); assert.equal(after.lifecycleGeneration, state.lifecycleGeneration);
      assert.equal(after.representation, representation); assert.equal(after.documentSequence, state.documentSequence + 1);
      assert.equal(actualContent(after), full);
      const originalVector = Y.decodeStateVector(state.stateVector), newVector = Y.decodeStateVector(after.stateVector);
      for (const [clientId, clock] of originalVector) assert.ok((newVector.get(clientId) ?? 0) >= clock, 'native operation retains original client history');
      assert.equal((await persistMarkdownFileImport(input, { openConnection })).disposition, 'already-applied');
      // Later peers preserve the initial receipt, even though the current proof differs.
      const peer = new Y.Doc(); try { Y.applyUpdate(peer, after.yjsState);
        peer.getText(representation === 'plain_text' ? 'content' : 'frontmatter').insert(0, 'peer addition\n');
        await pool.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=document_sequence+1 WHERE document_id=$3`,
        [Buffer.from(Y.encodeStateAsUpdate(peer)), Buffer.from(Y.encodeStateVector(peer)), state.documentId]);
      } finally { peer.destroy(); }
      const retry = await persistMarkdownFileImport(input, { openConnection });
      assert.deepEqual(retry.receipt, imported.receipt); assert.equal(retry.currentObservation.documentSequence, after.documentSequence + 1);
      assert.notEqual(retry.currentObservation.stateProof, retry.receipt.target.initialStateProof);
      const currentPeer = await load(state.documentId);
      assert.equal(actualContent(currentPeer), `\uFEFFpeer addition\r\n${full.slice(1)}`);
      assert.equal(retry.currentObservation.stateProof, authoritativeNativeCollaborationSnapshot(currentPeer).version.stateProof);
      const historical: { private_result: unknown; after_state_snapshot: Uint8Array; live_yjs_state_sha256: string; live_state_vector_sha256: string } = (await pool.query(`SELECT private_result,after_state_snapshot,live_yjs_state_sha256,live_state_vector_sha256
        FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2`, [workspace.workspaceId, input.operationId])).rows[0];
      assert.deepEqual(historical.private_result, imported.receipt);
      assert.equal(`yjs-snapshot-sha256-v1:${createHash('sha256').update(historical.after_state_snapshot).digest('hex')}`, imported.receipt.target.initialStateProof);
      assert.equal(historical.live_yjs_state_sha256, createHash('sha256').update(after.yjsState).digest('hex'));
      assert.equal(historical.live_state_vector_sha256, createHash('sha256').update(after.stateVector).digest('hex'));
      assert.notEqual(historical.live_yjs_state_sha256, createHash('sha256').update(currentPeer.yjsState).digest('hex'));
    }
    const nonempty = await seed('nonempty.md', 'plain_text', 'peer content');
    await assert.rejects(() => persistMarkdownFileImport(request(nonempty.path, '# Heading\n', expected(nonempty)), { openConnection }), code('MARKDOWN_IMPORT_TARGET_NOT_EMPTY'));
    const metadata = await seed('metadata.md', 'tiptap_blocks', '---\ntitle: Existing metadata\n---\n\n');
    await assert.rejects(() => persistMarkdownFileImport(request(metadata.path, '# Heading\n', expected(metadata)), { openConnection }), code('MARKDOWN_IMPORT_TARGET_NOT_EMPTY'));
    const activeAgent = await seed('agent-busy.md', 'plain_text');
    await pool.query(`INSERT INTO collaboration_agent_operations(operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,
      idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at) VALUES($1,$2,$3,'import-tester','agent-fixture','busy','synthetic','ready',$4,1,1)`,
    [`agent-${schema}`, activeAgent.documentId, workspace.workspaceId, Buffer.from(activeAgent.stateVector)]);
    await assert.rejects(() => persistMarkdownFileImport(request(activeAgent.path, '# Heading\n', expected(activeAgent)), { openConnection }), code('MARKDOWN_IMPORT_BUSY'));
    const missing = await seed('lost-state.md', 'plain_text');
    const missingInput = request(missing.path, '# Heading\n', expected(missing));
    await pool.query(`DELETE FROM collaboration_yjs_states WHERE document_id=$1`, [missing.documentId]);
    await assert.rejects(() => persistMarkdownFileImport(missingInput, { openConnection }), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    const brokenLineage = await seed('lost-lineage.md', 'plain_text');
    const brokenInput = request(brokenLineage.path, '# Heading\n', expected(brokenLineage));
    await pool.query(`DELETE FROM file_collaboration_lineages WHERE path=$1`, [brokenLineage.path]);
    await assert.rejects(() => persistMarkdownFileImport(brokenInput, { openConnection }), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM file_collaboration_lineages WHERE path=$1`, [brokenLineage.path])).rows[0].count, 0);
    const registryAhead = await seed('registry-ahead.md', 'plain_text');
    await pool.query(`UPDATE collaboration_documents SET state_version=5 WHERE id=$1`, [registryAhead.documentId]);
    await assert.rejects(() => persistMarkdownFileImport(request(registryAhead.path, '# Heading\n', expected(registryAhead)), { openConnection }), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    const proofStale = await seed('proof-stale.md', 'plain_text');
    const proofInput = request(proofStale.path, '# Heading\n', expected(proofStale));
    const peerDoc = createPlainTextYDoc('peer before import');
    try { await pool.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2 WHERE document_id=$3`,
      [Buffer.from(Y.encodeStateAsUpdate(peerDoc)), Buffer.from(Y.encodeStateVector(peerDoc)), proofStale.documentId]); }
    finally { peerDoc.destroy(); }
    await assert.rejects(() => persistMarkdownFileImport(proofInput, { openConnection }), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    // Same scope/generation with unrelated reset bytes cannot impersonate an applied import.
    const reset = createPlainTextYDoc('unrelated reset');
    try { await pool.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=document_sequence+1 WHERE document_id=$3`,
      [Buffer.from(Y.encodeStateAsUpdate(reset)), Buffer.from(Y.encodeStateVector(reset)), plain.receipt.target.documentId]); }
    finally { reset.destroy(); }
    await assert.rejects(() => persistMarkdownFileImport(request('source.md', sourceOnly), { openConnection }), code('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'));
    const stale = await seed('stale.md', 'plain_text');
    const staleInput = request(stale.path, '# Heading\n', expected(stale));
    await pool.query(`UPDATE collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE document_id=$1`, [stale.documentId]);
    await assert.rejects(() => persistMarkdownFileImport(staleInput, { openConnection }), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    const lifecycle = await seed('lifecycle.md', 'plain_text');
    await assert.rejects(() => persistMarkdownFileImport({ ...request(lifecycle.path, '# Heading\n', expected(lifecycle)), representation: 'tiptap_blocks' }, { openConnection }), code('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED'));
    await assert.rejects(() => persistMarkdownFileImport(request(lifecycle.path, full, expected(lifecycle)), { openConnection }), code('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED'));
    const guarded = await seed('owned.md', 'plain_text');
    const scope: CollaborationRoomOwnerScope = { documentId: guarded.documentId, workspaceId: workspace.workspaceId, organizationId: null,
      path: guarded.path, representation: guarded.representation, lifecycleGeneration: guarded.lifecycleGeneration, schemaVersion: guarded.schemaVersion };
    const ownerClient = new Client({ connectionString: url.href, options }); await ownerClient.connect();
    owner = await createCollaborationRoomOwnerSession(ownerClient); const fence = await owner.acquire(scope);
    await assert.rejects(() => persistMarkdownFileImport(request(guarded.path, '# Heading\n', expected(guarded)), { openConnection }), busy);
    await owner.release(fence, { releaseId: randomUUID(), yjsState: guarded.yjsState, stateVector: guarded.stateVector });
    const inspector = installCollaborationRoomInspector(documentId => documentId === guarded.documentId ? 1 : 0);
    try { await assert.rejects(() => persistMarkdownFileImport(request(guarded.path, '# Heading\n', expected(guarded)), { openConnection }), busy); }
    finally { inspector(); }
    const holder = new Client({ connectionString: url.href, options }); await holder.connect();
    try { await holder.query('SELECT pg_advisory_lock($1::bigint)', [lockIdentity(guarded.documentId).key]);
      await assert.rejects(() => persistMarkdownFileImport(request(guarded.path, '# Heading\n', expected(guarded)), { openConnection }), busy);
    } finally { await holder.end(); }
    const admission = createCollaborationAdmissionService({ openConnection });
    const actionPayloadText = JSON.stringify({ importReservation: true });
    const admissionDocument: CollaborationAdmissionDocument = { ...scope, status: 'active' };
    const reservation: CollaborationAdmissionRequest = { requestId: randomUUID(), actorId: 'import-tester', action: 'rename', actionPayloadText,
      actionDigest: collaborationAdmissionActionDigest('rename', actionPayloadText), scopes: [{ workspaceId: workspace.workspaceId, organizationId: null, path: guarded.path, kind: 'exact' }], expectedDocuments: [admissionDocument] };
    const reserved = await admission.reserve(reservation);
    await assert.rejects(() => persistMarkdownFileImport(request(guarded.path, '# Heading\n', expected(guarded)), { openConnection }), busy);
    await admission.cancel(reservation, reserved.revision);
    const atomicRequest = request('same-transaction.markdown', full), atomicTrace = tracedImportConnections(fixturePool, schema);
    try {
      const atomic = await persistMarkdownFileImport(atomicRequest, { openConnection: atomicTrace.openConnection });
      const writes = atomicTrace.events.filter(event => ['lineage', 'registry', 'state', 'receipt'].includes(event.step) && event.outcome === 'done');
      assert.deepEqual(writes.map(event => event.step), ['lineage', 'registry', 'state', 'receipt']);
      assert.equal(new Set(writes.map(event => event.backendPid)).size, 1); assert.equal(new Set(writes.map(event => event.xid)).size, 1);
      const transactionId = writes[0].xid; assert.ok(transactionId);
      assert.equal(writes[0].isolation, 'read committed'); assert.equal(writes[0].readOnly, 'off');
      assert.ok(atomicTrace.events.some(event => event.step === 'open' && event.backendPid !== writes[0].backendPid),
        'actual owner-lease connection remains separate from the mutation connection');
      const rows = (await fixturePool.query(`SELECT 'lineage' AS part,xmin::text AS xid FROM file_collaboration_lineages WHERE id=$1
        UNION ALL SELECT 'registry',xmin::text FROM collaboration_documents WHERE id=$2
        UNION ALL SELECT 'state',xmin::text FROM collaboration_yjs_states WHERE document_id=$2
        UNION ALL SELECT 'receipt',xmin::text FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$3 AND operation_id=$4`,
      [atomic.receipt.target.lineageId, atomic.receipt.target.documentId, workspace.workspaceId, atomicRequest.operationId])).rows;
      assert.deepEqual(rows.map(row => row.part).sort(), ['lineage', 'receipt', 'registry', 'state']);
      assert.ok(rows.every(row => row.xid === (BigInt(transactionId) & BigInt('4294967295')).toString()),
        'actual committed row versions must carry the same PostgreSQL transaction ID');
      assert.equal(actualContent(await load(atomic.receipt.target.documentId)), full);
    } finally { atomicTrace.dispose(); }
    const failedReceipt = request('receipt-rollback.md', '# Must roll back\n'), rollbackTrace = tracedImportConnections(fixturePool, schema, {}, true);
    try {
      await assert.rejects(() => persistMarkdownFileImport(failedReceipt, { openConnection: rollbackTrace.openConnection }),
        error => (error as { code?: string }).code === '23514');
      const failed = rollbackTrace.events.find(event => event.step === 'receipt' && event.outcome === 'failed'); assert.ok(failed?.xid);
      assert.deepEqual(rollbackTrace.events.filter(event => event.backendPid === failed.backendPid && event.outcome === 'done'
        && ['lineage', 'registry', 'state'].includes(event.step)).map(event => event.step), ['lineage', 'registry', 'state']);
      assert.ok(rollbackTrace.events.some(event => event.backendPid === failed.backendPid && event.step === 'rollback' && event.outcome === 'done'));
      assert.equal(rollbackTrace.events.filter(event => event.backendPid === failed.backendPid && event.step === 'commit').length, 0);
      for (const table of ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states']) {
        assert.equal((await fixturePool.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1 AND path=$2`,
        [workspace.workspaceId, failedReceipt.path])).rows[0].count, 0);
      }
      assert.equal((await fixturePool.query(`SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2`,
      [workspace.workspaceId, failedReceipt.operationId])).rows[0].count, 0);
    } finally { rollbackTrace.dispose(); }
    const recoveredRequest = request('lost-after.md', '# Recovered\n');
    const afterTrace = tracedImportConnections(fixturePool, schema, { commit: 'after' });
    try {
      const recovered = await persistMarkdownFileImport(recoveredRequest, { openConnection: afterTrace.openConnection });
      assert.equal(recovered.disposition, 'commit-recovered'); assert.equal(actualContent(await load(recovered.receipt.target.documentId)), '# Recovered\n');
      assertImportRecoveryOrder(afterTrace.events);
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1`, [recoveredRequest.operationId])).rows[0].count, 1);
    } finally { afterTrace.dispose(); }
    const rejectedRequest = request('lost-before.md', '# Not committed\n');
    const beforeTrace = tracedImportConnections(fixturePool, schema, { commit: 'before' });
    try {
      await assert.rejects(() => persistMarkdownFileImport(rejectedRequest, { openConnection: beforeTrace.openConnection }), code('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'));
      assertImportRecoveryOrder(beforeTrace.events);
    } finally { beforeTrace.dispose(); }
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_documents WHERE path='lost-before.md'`)).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM file_collaboration_lineages WHERE path='lost-before.md'`)).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE path='lost-before.md'`)).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1`, [rejectedRequest.operationId])).rows[0].count, 0);
    assert.equal((await persistMarkdownFileImport(rejectedRequest, { openConnection })).disposition, 'applied');
    const concurrent = request('concurrent.md', '# Exactly once\n');
    const attempts = await Promise.all([persistMarkdownFileImport(concurrent, { openConnection }), persistMarkdownFileImport(concurrent, { openConnection })]);
    assert.deepEqual(attempts.map(item => item.disposition).sort(), ['already-applied', 'applied']);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1`, [concurrent.operationId])).rows[0].count, 1);
    assert.ok(authorityChecks > 20);
    console.log('complete Markdown import PostgreSQL: exact full-file/profile, native mutation, immutable bounded/scoped SQL receipts and real deletion proof, rights/identity/actor/session conflicts, peers/retries, live-owner/reservation Busy, concurrent exactly-once, SAME backend/XID row versions, receipt failure rollback, lost COMMIT before/after with actual Pool disposal before fresh read-only recovery OK');
  } finally {
    await owner?.close(); await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${namespace(schema)} CASCADE`); await admin.end();
    if (previousData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousData;
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.stack?.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]') : 'Markdown import fixture failed.'); process.exitCode = 1; });
