import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, types, type PoolClient } from 'pg';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { COLLABORATION_NATIVE_COPY_STATEMENTS } from '../app/lib/db/collaboration-native-copy-migration';
import { completeNativeCopyPublication, persistNativeWorkspaceCopies,
  type NativeCopyReceipt, type NativeCopyRequest } from '../app/lib/collaboration/native-copy-persistence';
import { NativeCopyHistoryError, readHistoricalNativeWorkspaceCopyReceiptOnConnection,
  readNativeCopyReceiptStorageIdentityOnConnection } from '../app/lib/collaboration/native-copy-historical-receipt';
import { loadCollaborationStateOnConnection } from '../app/lib/collaboration/persistence';
import { readNativeWorkspaceRecoveryRecords } from '../app/lib/collaboration/workspace-native-recovery';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { nativeRichDocumentFixture, nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const PREFIX = 'canvas_native_copy_history_';
const SCHEMA = new RegExp(`^${PREFIX}[0-9a-f]{32}$`, 'u');
const TABLES = ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states',
  'collaboration_yjs_state_backups', 'collaboration_agent_operations', 'collaboration_excalidraw_states',
  'file_revisions', 'file_locks', 'file_guest_invitations', 'collaboration_admission_requests',
  'collaboration_admission_scopes', 'collaboration_admission_targets'] as const;
type Representation = 'plain_text' | 'tiptap_xml' | 'tiptap_blocks';
type Fixture = { pool: Pool; schema: string; openConnection: () => Promise<SqlConnection>;
  sourceWorkspace: WorkspaceContext; targetWorkspace: WorkspaceContext; createShadow: () => Promise<string> };
type PublishedCopy = { request: NativeCopyRequest; committed: NativeCopyReceipt; published: NativeCopyReceipt;
  sourceId: string; sourcePath: string; targetPath: string };
type HistoryInput = Parameters<typeof readHistoricalNativeWorkspaceCopyReceiptOnConnection>[1];
type Storage = Awaited<ReturnType<typeof readNativeCopyReceiptStorageIdentityOnConnection>>;

function managedDatabase(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  const url = new URL(process.env.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55433' && decodeURIComponent(url.pathname) === '/canvas_notebook' && !url.search && !url.hash,
  'Native copy history tests require managed loopback PostgreSQL at 55433/canvas_notebook.');
  return url;
}

function identifier(schema: string): string {
  assert(SCHEMA.test(schema), 'Only this test\'s generated schemas may be addressed.');
  return `"${schema}"`;
}

function workspace(id: string): WorkspaceContext {
  return { workspaceId: id, organizationId: null, workspaceType: 'personal', ownerUserId: 'native-copy-history-tester',
    rootPath: '/unused-native-copy-history-fixture', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true } };
}

function borrowed(client: PoolClient, observe?: (sql: string) => void,
  afterQuery?: (sql: string) => Promise<void>): SqlConnection {
  const query = async (sql: string, values: unknown[] = []) => {
    observe?.(sql);
    const rows = (await client.query(sql, values)).rows;
    await afterQuery?.(sql);
    return rows;
  };
  return { run: query, all: query, get: async (sql, values) => (await query(sql, values))[0],
    close: async () => { assert.fail('The borrowed history reader must not close its caller\'s connection.'); } };
}

function connectionFactory(pool: Pool): () => Promise<SqlConnection> {
  return async () => {
    const client = await pool.connect();
    const actual = borrowed(client);
    let closed = false;
    return { ...actual, close: async error => { if (!closed) { closed = true; client.release(error); } } };
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const url = managedDatabase();
  if (!url) {
    console.log('SKIP native copy history PostgreSQL: managed PG18 connection not supplied.');
    return;
  }
  const schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 3_000, allowExitOnIdle: true });
  let pool: Pool | undefined, created = false, failed = false, primary: unknown;
  const shadows: string[] = [];
  try {
    const identity = (await admin.query(`SELECT current_setting('server_version_num')::int AS version,
      current_database() AS database,current_user AS role,pg_get_userbyid(datdba) AS owner
      FROM pg_database WHERE datname=current_database()`)).rows[0];
    assert.equal(Math.floor(identity.version / 10_000), 18);
    assert.equal(identity.database, 'canvas_notebook');
    for (const table of TABLES) {
      assert.equal((await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`])).rows[0].present, true);
    }
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`); created = true;
    assert.equal((await admin.query(`SELECT pg_get_userbyid(nspowner)=current_user AS owned
      FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0].owned, true);
    pool = new Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 3_000, allowExitOnIdle: true,
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8
        ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
      options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=8000`,
      application_name: 'native-copy-history-isolated-fixtures' });
    for (const table of TABLES) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    for (let pass = 0; pass < 2; pass++) {
      for (const statement of COLLABORATION_NATIVE_COPY_STATEMENTS) await pool.query(statement);
    }
    const fixturePool = pool;
    await run({ pool, schema, openConnection: connectionFactory(pool), createShadow: async () => {
      const shadow = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA ${identifier(shadow)}`); shadows.push(shadow);
      const client = await fixturePool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path=${identifier(shadow)}`);
        for (const statement of COLLABORATION_NATIVE_COPY_STATEMENTS) await client.query(statement);
        await client.query(`INSERT INTO collaboration_native_copy_receipts
          SELECT * FROM ${identifier(schema)}.collaboration_native_copy_receipts`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      return shadow;
    },
      sourceWorkspace: workspace(`${schema}-source`), targetWorkspace: workspace(`${schema}-target`) });
  } catch (error) { failed = true; primary = error; }
  finally {
    const cleanup: unknown[] = [];
    try { await pool?.end(); } catch (error) { cleanup.push(error); }
    for (const shadow of shadows.reverse()) {
      try { await admin.query(`DROP SCHEMA ${identifier(shadow)} CASCADE`); } catch (error) { cleanup.push(error); }
    }
    if (created) try { await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`); } catch (error) { cleanup.push(error); }
    try { await admin.end(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Owned native copy history fixture cleanup failed.');
    if (failed) throw primary;
  }
}

async function publishCopy(fixture: Fixture, representation: Representation, publish = true,
  sourceBlockIds?: readonly string[]): Promise<PublishedCopy> {
  const nonce = randomUUID(), sourceId = `history-source-${nonce}`, sourcePath = `source-${nonce}.md`, targetPath = `copy-${nonce}.md`;
  const document = representation === 'plain_text' ? new Y.Doc() : sourceBlockIds
    ? nativeRichDocumentFixture({ type: 'doc', content: sourceBlockIds.map((id, index) => ({ type: 'paragraph', attrs: { id },
      content: [{ type: 'text', text: `Original legacy paragraph ${index} 😀` }] })) }, representation)
    : nativeTableWidthFixture(representation, 'Original 😀');
  try {
    if (representation === 'plain_text') document.getText('content').insert(0, 'Original plain text 😀\n');
    else document.getText('frontmatter').insert(0, '---\ntitle: Original copy history\n---\n');
    const lineageId = `history-lineage-${nonce}`;
    await fixture.pool.query(`INSERT INTO file_collaboration_lineages (id,workspace_id,workspace_type,path,status,created_at)
      VALUES ($1,$2,'personal',$3,'active',1)`, [lineageId, fixture.sourceWorkspace.workspaceId, sourcePath]);
    await fixture.pool.query(`INSERT INTO collaboration_documents
      (id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
      VALUES ($1,$2,$3,'personal',$4,'yjs','active',0,1,1,'initialized')`,
    [sourceId, lineageId, fixture.sourceWorkspace.workspaceId, sourcePath]);
    await fixture.pool.query(`INSERT INTO collaboration_yjs_states
      (document_id,workspace_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
      document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
      VALUES ($1,$2,$3,$4,1,1,$5,$6,3,1,0,'lf',0,0,'active')`,
    [sourceId, fixture.sourceWorkspace.workspaceId, sourcePath, representation,
      Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document))]);
    const connection = await fixture.openConnection();
    let records;
    try { records = await readNativeWorkspaceRecoveryRecords(connection, fixture.sourceWorkspace, sourcePath); }
    finally { await connection.close(); }
    assert.equal(records.length, 1);
    const request: NativeCopyRequest = { operationId: `history-copy-${nonce}`, actorUserId: 'native-copy-history-tester',
      actorSessionId: 'native-copy-history-session', kind: 'native_clone', sourceWorkspace: fixture.sourceWorkspace,
      targetWorkspace: fixture.targetWorkspace, targetScopes: [targetPath], expectedTargets: [],
      copies: [{ source: records[0], targetPath }],
      publicationFingerprint: createHash('sha256').update(JSON.stringify(['owned-native-copy-history', nonce])).digest('hex') };
    const committed = await persistNativeWorkspaceCopies(request, fixture.openConnection);
    assert.equal(committed.publicationStatus, 'native_committed'); assert.equal(committed.documents.length, 1);
    assert.notEqual(committed.documents[0].clone.documentId, sourceId);
    if (publish) await completeNativeCopyPublication({ workspace: fixture.targetWorkspace, operationId: request.operationId,
      actorUserId: request.actorUserId, actorSessionId: request.actorSessionId,
      requestFingerprint: committed.requestFingerprint, publicationFingerprint: request.publicationFingerprint! }, fixture.openConnection);
    const published = { ...committed, publicationStatus: 'published' as const };
    const actual = (await fixture.pool.query(`SELECT publication_status FROM collaboration_native_copy_receipts
      WHERE workspace_id=$1 AND operation_id=$2`, [fixture.targetWorkspace.workspaceId, request.operationId])).rows[0];
    assert.equal(actual.publication_status, publish ? 'published' : 'native_committed');
    return { request, committed, published, sourceId, sourcePath, targetPath };
  } finally { document.destroy(); }
}

async function editCurrentClone(fixture: Fixture, copy: PublishedCopy): Promise<void> {
  const connection = await fixture.openConnection();
  let state;
  try { state = await loadCollaborationStateOnConnection(connection, copy.published.documents[0].clone.documentId); }
  finally { await connection.close(); }
  assert(state);
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state.yjsState);
    const text = document.getText(state.representation === 'plain_text' ? 'content' : 'frontmatter');
    const position = state.representation === 'plain_text' ? 0 : text.toString().indexOf('Original');
    assert(position >= 0); text.insert(position, 'Later ');
    const result = await fixture.pool.query(`UPDATE collaboration_yjs_states
      SET yjs_state=$1,state_vector=$2,document_sequence=document_sequence+1,persisted_at=persisted_at+1 WHERE document_id=$3`,
    [Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document)), state.documentId]);
    assert.equal(result.rowCount, 1);
  } finally { document.destroy(); }
}

function historyInput(copy: PublishedCopy, storage: Storage): HistoryInput {
  return { storage, workspaceId: copy.request.targetWorkspace.workspaceId,
    organizationId: copy.request.targetWorkspace.organizationId ?? null, operationId: copy.request.operationId,
    actorUserId: copy.request.actorUserId, actorSessionId: copy.request.actorSessionId ?? null,
    kind: copy.request.kind, requestFingerprint: copy.published.requestFingerprint,
    publicationFingerprint: copy.request.publicationFingerprint ?? null };
}

async function captureStorage(fixture: Fixture): Promise<Storage> {
  const connection = await fixture.openConnection();
  try { return await readNativeCopyReceiptStorageIdentityOnConnection(connection, fixture.schema); }
  finally { await connection.close(); }
}

async function readOnly<T>(fixture: Fixture, operation: (client: PoolClient, database: SqlConnection,
  statements: string[]) => Promise<T>): Promise<T> {
  const client = await fixture.pool.connect(), statements: string[] = [];
  let failed = false, primary: unknown, value: T | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before = (await client.query('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
    assert.equal(before.xid, null);
    value = await operation(client, borrowed(client, sql => { statements.push(sql); }), statements);
    const after = (await client.query('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
    assert.equal(after.xid, null, 'Historical reads must not allocate an XID.');
    assert(!statements.some(sql => /\b(?:INSERT|UPDATE|DELETE|FOR\s+SHARE|FOR\s+UPDATE|BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)),
      'The reader must leave the caller-owned read-only transaction intact.');
    assert(!statements.some(sql => /\b(?:collaboration_yjs_states|collaboration_documents|file_collaboration_lineages|pg_current_xact_id\s*\()/iu.test(sql)),
      'Historical reads must not load current document, namespace or mutating XID state.');
  } catch (error) { failed = true; primary = error; }
  finally {
    try { await client.query('ROLLBACK'); }
    catch (error) { client.release(error as Error); if (failed) throw new AggregateError([primary, error]); throw error; }
    client.release();
    if (failed) throw primary;
  }
  return value!;
}

function historyError(error: unknown): error is NativeCopyHistoryError {
  return error instanceof NativeCopyHistoryError && /^NATIVE_COPY_HISTORY_/u.test(error.code);
}

async function historical(fixture: Fixture, input: HistoryInput): Promise<NativeCopyReceipt | null> {
  return readOnly(fixture, async (_client, database) => readHistoricalNativeWorkspaceCopyReceiptOnConnection(database, input));
}

async function ledgerRows(fixture: Fixture): Promise<string> {
  return JSON.stringify((await fixture.pool.query(`SELECT row_to_json(r) AS row FROM
    collaboration_native_copy_receipts r ORDER BY workspace_id,operation_id`)).rows);
}

async function currentRows(fixture: Fixture): Promise<string> {
  const rows = [];
  for (const [table, key] of [['collaboration_yjs_states', 'document_id'], ['collaboration_documents', 'id'],
    ['file_collaboration_lineages', 'id']]) {
    rows.push([table, (await fixture.pool.query(`SELECT row_to_json(r) AS row FROM ${table} r ORDER BY ${key}`)).rows]);
  }
  return JSON.stringify(rows);
}

async function setCurrentPath(fixture: Fixture, documentId: string, nextPath: string, archive = false): Promise<void> {
  const client = await fixture.pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT lineage_id FROM collaboration_documents WHERE id=$1`, [documentId])).rows[0];
    assert(row?.lineage_id);
    const status = archive ? 'archived' : 'active';
    await client.query(`UPDATE collaboration_yjs_states SET path=$1,status=$2,
      lifecycle_generation=lifecycle_generation+$3 WHERE document_id=$4`, [nextPath, status, archive ? 1 : 0, documentId]);
    await client.query('UPDATE collaboration_documents SET path=$1,status=$2 WHERE id=$3', [nextPath, status, documentId]);
    await client.query(`UPDATE file_collaboration_lineages SET path=$1,status=$2,archived_at=$3 WHERE id=$4`,
    [nextPath, status, archive ? Date.now() : null, row.lineage_id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function insertReplacement(fixture: Fixture, owner: WorkspaceContext, filePath: string): Promise<string> {
  const id = `history-replacement-${randomUUID()}`, lineage = `lineage-${id}`, doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, 'Foreign replacement remains independent.\n');
    await fixture.pool.query(`INSERT INTO file_collaboration_lineages (id,workspace_id,workspace_type,path,status,created_at)
      VALUES ($1,$2,'personal',$3,'active',1)`, [lineage, owner.workspaceId, filePath]);
    await fixture.pool.query(`INSERT INTO collaboration_documents
      (id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
      VALUES ($1,$2,$3,'personal',$4,'yjs','active',0,1,1,'initialized')`, [id, lineage, owner.workspaceId, filePath]);
    await fixture.pool.query(`INSERT INTO collaboration_yjs_states
      (document_id,workspace_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
      document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
      VALUES ($1,$2,$3,'plain_text',1,1,$4,$5,0,1,0,'lf',0,0,'active')`,
    [id, owner.workspaceId, filePath, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
    return id;
  } finally { doc.destroy(); }
}

async function malformedRow(fixture: Fixture, copy: PublishedCopy, change: {
  column?: 'actor_user_id' | 'actor_session_id' | 'request_fingerprint' | 'publication_fingerprint' | 'scope_paths';
  value?: string; privateSql?: string;
}): Promise<string> {
  const operationId = `history-malformed-${randomUUID()}`;
  const params: unknown[] = [operationId, copy.request.targetWorkspace.workspaceId, copy.request.operationId];
  const columns = ['workspace_id', 'operation_id', 'organization_id', 'actor_user_id', 'actor_session_id', 'version', 'kind',
    'request_fingerprint', 'scope_paths', 'private_result', 'publication_status', 'publication_fingerprint', 'created_at'];
  const select = columns.map(column => {
    if (column === 'operation_id') return '$1';
    if (column === 'publication_status') return "'native_committed'";
    if (column === 'private_result') return change.privateSql
      ? change.privateSql.replaceAll('original_result', `jsonb_set(private_result,'{operationId}',to_jsonb($1::text))`)
      : `jsonb_set(private_result,'{operationId}',to_jsonb($1::text))`;
    if (column === change.column) { params.push(change.value); return `$${params.length}${column === 'scope_paths' ? '::jsonb' : ''}`; }
    return column;
  });
  await fixture.pool.query(`INSERT INTO collaboration_native_copy_receipts (${columns.join(',')})
    SELECT ${select.join(',')} FROM collaboration_native_copy_receipts WHERE workspace_id=$2 AND operation_id=$3`, params);
  return operationId;
}

/** Stored-format fixture only. It does not claim that a document with this many
 * blocks was cloned, nor does it authorize a native publication or a retry. */
async function storedFormatReceipt(fixture: Fixture, copy: PublishedCopy, change: {
  uuidPairs?: number; scopes?: readonly string[];
}): Promise<{ operationId: string; expected: NativeCopyReceipt; compactBytes: number; sqlBytes: number }> {
  const operationId = await malformedRow(fixture, copy, {
    ...(change.uuidPairs ? { privateSql: `jsonb_set(original_result,'{documents,0,blockIdMapping}',
      (SELECT jsonb_object_agg('00000000-0000-4000-8000-'||lpad(i::text,12,'0'),
        '11111111-1111-4111-8111-'||lpad(i::text,12,'0')) FROM generate_series(1,${change.uuidPairs}) AS i))` } : {}),
    ...(change.scopes ? { column: 'scope_paths' as const, value: JSON.stringify(change.scopes) } : {}),
  });
  await fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET publication_status='published'
    WHERE workspace_id=$1 AND operation_id=$2`, [copy.request.targetWorkspace.workspaceId, operationId]);
  const row = (await fixture.pool.query(`SELECT private_result,octet_length(private_result::text) AS sql_bytes
    FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
  [copy.request.targetWorkspace.workspaceId, operationId])).rows[0];
  return { operationId, expected: { ...row.private_result, publicationStatus: 'published' },
    compactBytes: Buffer.byteLength(JSON.stringify(row.private_result)), sqlBytes: Number(row.sql_bytes) };
}

/** Run the identical boundary assertion against the unchanged original two-DDL
 * prefix and the additive immutable migration, each in its own rolled-back TX. */
async function immutableDdlCounterexample(fixture: Fixture, copy: PublishedCopy): Promise<void> {
  const client = await fixture.pool.connect(), schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
  const assertion = () => assert.rejects(() => client.query(`UPDATE collaboration_native_copy_receipts SET actor_user_id='changed'
    WHERE workspace_id=$1 AND operation_id=$2`, [copy.request.targetWorkspace.workspaceId, copy.request.operationId]), { code: '55000' });
  try {
    for (const immutable of [false, true]) {
      await client.query('BEGIN');
      try {
        await client.query(`CREATE SCHEMA ${identifier(schema)}`);
        await client.query(`SET LOCAL search_path=${identifier(schema)}`);
        for (const statement of immutable ? COLLABORATION_NATIVE_COPY_STATEMENTS : COLLABORATION_NATIVE_COPY_STATEMENTS.slice(0, 2)) {
          await client.query(statement);
        }
        const inserted = await client.query(`INSERT INTO collaboration_native_copy_receipts
          SELECT * FROM ${identifier(fixture.schema)}.collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
        [copy.request.targetWorkspace.workspaceId, copy.request.operationId]);
        assert.equal(inserted.rowCount, 1);
        if (immutable) await assertion();
        else {
          await assert.rejects(assertion, error => error instanceof assert.AssertionError
            && error.code === 'ERR_ASSERTION' && /Missing expected rejection/u.test(error.message));
          assert.equal((await client.query(`SELECT actor_user_id FROM collaboration_native_copy_receipts
            WHERE workspace_id=$1 AND operation_id=$2`, [copy.request.targetWorkspace.workspaceId, copy.request.operationId])).rows[0].actor_user_id,
          'changed', 'The old DDL must actually allow the unsafe update to reproduce the red boundary.');
        }
      } finally { await client.query('ROLLBACK'); }
      assert.equal((await client.query('SELECT to_regnamespace($1) IS NULL AS absent', [schema])).rows[0].absent, true);
      console.log(JSON.stringify({ probe: 'native-copy-immutable-DDL-counterexample',
        ddl: immutable ? 'additive-immutable-migration' : 'unchanged-original-two-statement-prefix',
        boundary: immutable ? 'green-update-rejected-55000' : 'red-reproduced-update-accepted',
        transactionRolledBack: true, ownedSchemaAbsent: true }));
    }
  } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
}

async function main(): Promise<void> {
  const completed: string[] = [];
  await withFixture(async fixture => {
    const storage = await captureStorage(fixture);
    const legacyIds = ['constructor', 'prototype', '__proto__', `legacy-${'long-source-id-'.repeat(24)}`];
    assert(legacyIds[3].length > 256);
    const cases: { representation: Representation; sourceBlockIds?: readonly string[] }[] = [
      { representation: 'plain_text' }, { representation: 'tiptap_xml' }, { representation: 'tiptap_blocks' },
      { representation: 'tiptap_xml', sourceBlockIds: legacyIds }, { representation: 'tiptap_blocks', sourceBlockIds: legacyIds },
    ];
    for (const { representation, sourceBlockIds } of cases) {
      const copy = await publishCopy(fixture, representation, true, sourceBlockIds), input = historyInput(copy, storage);
      assert.deepEqual(await historical(fixture, input), copy.published);
      if (sourceBlockIds) {
        const actual = await historical(fixture, input); assert(actual);
        const mapping = actual.documents[0].blockIdMapping;
        assert.deepEqual(Object.keys(mapping).sort(), [...sourceBlockIds].sort());
        assert.equal(Object.getPrototypeOf(mapping), Object.prototype);
        for (const id of sourceBlockIds) {
          assert(Object.hasOwn(mapping, id)); assert.match(mapping[id], /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
        }
      }
      const originalLedger = await ledgerRows(fixture);
      await editCurrentClone(fixture, copy);
      assert.deepEqual(await historical(fixture, input), copy.published);
      const clone = copy.published.documents[0].clone;
      await setCurrentPath(fixture, clone.documentId, `moved-${randomUUID()}.md`);
      await setCurrentPath(fixture, copy.sourceId, `source-moved-${randomUUID()}.md`);
      const d2 = await insertReplacement(fixture, fixture.targetWorkspace, copy.targetPath);
      const s2 = await insertReplacement(fixture, fixture.sourceWorkspace, copy.sourcePath);
      const before = await currentRows(fixture);
      assert.deepEqual(await historical(fixture, input), copy.published);
      assert.equal(await currentRows(fixture), before);
      await setCurrentPath(fixture, clone.documentId, `archived-${randomUUID()}.md`, true);
      await setCurrentPath(fixture, copy.sourceId, `source-archived-${randomUUID()}.md`, true);
      const archived = await currentRows(fixture);
      assert.deepEqual(await historical(fixture, input), copy.published);
      assert.equal(await currentRows(fixture), archived); assert.equal(await ledgerRows(fixture), originalLedger);
      assert.notEqual(d2, clone.documentId); assert.notEqual(s2, copy.sourceId);
      completed.push(`${representation}${sourceBlockIds ? ' legacy dictionary and long source IDs' : ''}: real original clone/publish;
        history survives later SQL edit/path/archive fixtures and D2/S2 without mutation`);
    }

    const copy = await publishCopy(fixture, 'plain_text'), input = historyInput(copy, storage);
    await immutableDdlCounterexample(fixture, copy);
    completed.push('separate original-DDL red reproduction and additive-DDL green, both TXs rolled back');

    const largeMapping = await storedFormatReceipt(fixture, copy, { uuidPairs: 106_000 });
    assert(largeMapping.compactBytes <= 8 * 1024 * 1024);
    assert(largeMapping.sqlBytes > 8 * 1024 * 1024 && largeMapping.sqlBytes <= 16 * 1024 * 1024);
    assert.equal(Object.keys(largeMapping.expected.documents[0].blockIdMapping).length, 106_000);
    assert.deepEqual(await historical(fixture, { ...input, operationId: largeMapping.operationId }), largeMapping.expected);
    console.log(JSON.stringify({ probe: 'stored-receipt-format-and-spacing', uuidPairs: 106_000,
      compactBytes: largeMapping.compactBytes, sqlBytes: largeMapping.sqlBytes, actualNativeBlockCloneClaimed: false }));
    completed.push('stored-format 106000 UUID pairs: compact <=8MiB and actual PG JSONB text >8MiB, <=16MiB');

    const scopes = [copy.targetPath, ...Array.from({ length: 1_000 }, (_, index) => `format-scope-${index}.md`)];
    const manyScopes = await storedFormatReceipt(fixture, copy, { scopes });
    assert.equal(scopes.length, 1_001);
    assert.deepEqual(await historical(fixture, { ...input, operationId: manyScopes.operationId }), manyScopes.expected);
    completed.push('stored-format 1001 scopes retains valid original receipt membership');

    assert.equal(await historical(fixture, { ...input, operationId: `missing-${randomUUID()}` }), null);
    completed.push('missing operation returns null inside caller-owned RO-RR');

    for (const patch of [{ actorUserId: 'other-user' }, { actorSessionId: 'other-session' }, { organizationId: 'other-organization' },
      { requestFingerprint: '0'.repeat(64) }, { publicationFingerprint: '0'.repeat(64) }, { kind: 'native_restore' as const }]) {
      await assert.rejects(() => historical(fixture, { ...input, ...patch }), { code: 'NATIVE_COPY_HISTORY_SCOPE_CHANGED' });
    }
    completed.push('original actor/session/organization/kind/request/publication binding');

    for (const patch of [{ operationId: '' }, { requestFingerprint: 'bad' }, { actorSessionId: undefined }, { organizationId: undefined }]) {
      await assert.rejects(() => historical(fixture, { ...input, ...patch } as HistoryInput),
        error => historyError(error) && error.code === 'NATIVE_COPY_HISTORY_INVALID');
    }
    completed.push('invalid shapes and implicit nullable pins reject');

    for (const change of [
      { column: 'actor_user_id' as const, value: 'other-user' },
      { column: 'actor_session_id' as const, value: 'other-session' },
      { column: 'request_fingerprint' as const, value: '0'.repeat(64) },
      { column: 'publication_fingerprint' as const, value: '0'.repeat(64) },
      { column: 'scope_paths' as const, value: '["foreign.md"]' },
      { privateSql: `jsonb_set(original_result,'{version}','99'::jsonb)` },
      { privateSql: `jsonb_set(original_result,'{documents}',(original_result->'documents')||(original_result->'documents'))` },
      { privateSql: `jsonb_set(original_result,'{documents,0,clone,lifecycleGeneration}','2'::jsonb)` },
      { privateSql: `jsonb_set(original_result,'{documents,0,clone,stateProof}','"invalid"'::jsonb)` },
      { privateSql: `original_result || '{"unexpected":true}'::jsonb` },
    ]) {
      const operationId = await malformedRow(fixture, copy, change);
      await assert.rejects(() => historical(fixture, { ...input, operationId }), { code: 'NATIVE_COPY_HISTORY_UNCONFIRMED' });
      await fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET publication_status='published'
        WHERE workspace_id=$1 AND operation_id=$2`, [input.workspaceId, operationId]);
      await assert.rejects(() => historical(fixture, { ...input, operationId }), {
        code: change.column && change.column !== 'scope_paths' ? 'NATIVE_COPY_HISTORY_SCOPE_CHANGED' : 'NATIVE_COPY_HISTORY_INVALID',
      });
    }
    completed.push('actual malformed ledger actor/session/fingerprints/scopes/version/private-result reject');

    const bodyBefore = await ledgerRows(fixture);
    for (const expression of ["actor_user_id='changed'", "actor_session_id='changed'", "request_fingerprint=repeat('0',64)",
      "scope_paths='[\"foreign.md\"]'::jsonb", "private_result=jsonb_set(private_result,'{version}','99'::jsonb)",
      'created_at=created_at+1', "publication_fingerprint=repeat('0',64)"]) {
      await assert.rejects(() => fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET ${expression}
        WHERE workspace_id=$1 AND operation_id=$2`, [input.workspaceId, input.operationId]));
    }
    await assert.rejects(() => fixture.pool.query(`DELETE FROM collaboration_native_copy_receipts
      WHERE workspace_id=$1 AND operation_id=$2`, [input.workspaceId, input.operationId]));
    assert.equal(await ledgerRows(fixture), bodyBefore);
    completed.push('SQL body update and delete are blocked; exact original rows remain');

    const pending = await publishCopy(fixture, 'plain_text', false), pendingInput = historyInput(pending, storage);
    await assert.rejects(() => historical(fixture, pendingInput), { code: 'NATIVE_COPY_HISTORY_UNCONFIRMED' });
    await fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET publication_status='publication_failed'
      WHERE workspace_id=$1 AND operation_id=$2`, [pendingInput.workspaceId, pendingInput.operationId]);
    await assert.rejects(() => historical(fixture, pendingInput), { code: 'NATIVE_COPY_HISTORY_UNCONFIRMED' });
    await fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET publication_status='published'
      WHERE workspace_id=$1 AND operation_id=$2`, [pendingInput.workspaceId, pendingInput.operationId]);
    assert.deepEqual(await historical(fixture, pendingInput), pending.published);
    await fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET publication_status='published'
      WHERE workspace_id=$1 AND operation_id=$2`, [pendingInput.workspaceId, pendingInput.operationId]);
    await assert.rejects(() => fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET publication_status='native_committed'
      WHERE workspace_id=$1 AND operation_id=$2`, [pendingInput.workspaceId, pendingInput.operationId]));
    completed.push('unconfirmed statuses reject; failed to published and repeated published are allowed');

    const shadow = await fixture.createShadow();
    await readOnly(fixture, async (client, database) => {
      await client.query(`SET LOCAL search_path=${identifier(shadow)}`);
      const present = (await client.query(`SELECT count(*)::int AS count FROM collaboration_native_copy_receipts
        WHERE workspace_id=$1 AND operation_id=$2`, [input.workspaceId, input.operationId])).rows[0];
      assert.equal(present.count, 1, 'The shadow must contain the same receipt rather than only missing tables.');
      await assert.rejects(() => readHistoricalNativeWorkspaceCopyReceiptOnConnection(database, input),
        { code: 'NATIVE_COPY_HISTORY_STORAGE_CHANGED' });
    });
    completed.push('actual same-body schema shadow cannot replace pinned storage');

    const client = await fixture.pool.connect();
    try {
      await assert.rejects(() => readHistoricalNativeWorkspaceCopyReceiptOnConnection(borrowed(client), input),
        { code: 'NATIVE_COPY_HISTORY_TRANSACTION_CHANGED' });
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await assert.rejects(() => readHistoricalNativeWorkspaceCopyReceiptOnConnection(borrowed(client), input),
        { code: 'NATIVE_COPY_HISTORY_TRANSACTION_CHANGED' });
      await client.query('ROLLBACK');
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
      await assert.rejects(() => readHistoricalNativeWorkspaceCopyReceiptOnConnection(borrowed(client), input),
        { code: 'NATIVE_COPY_HISTORY_TRANSACTION_CHANGED' });
      await client.query('ROLLBACK');
    } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
    completed.push('autocommit, wrong isolation and read-write transaction reject');

    await readOnly(fixture, async (client) => {
      let changed = false;
      const database = borrowed(client, undefined, async () => {
        if (changed) return;
        changed = true;
        await client.query('COMMIT');
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      });
      await assert.rejects(() => readHistoricalNativeWorkspaceCopyReceiptOnConnection(database, input),
        { code: 'NATIVE_COPY_HISTORY_TRANSACTION_CHANGED' });
      assert.equal(changed, true);
    });
    completed.push('actual same-backend transaction replacement between reader queries rejects');

    for (const entries of [22_000, 45_000]) {
      const operationId = await malformedRow(fixture, copy,
        { privateSql: `jsonb_set(original_result,'{documents,0,blockIdMapping}',
          (SELECT jsonb_object_agg('old-'||lpad(i::text,190,'x'),'new-'||lpad(i::text,190,'y')) FROM generate_series(1,${entries}) AS i))` });
      await fixture.pool.query(`UPDATE collaboration_native_copy_receipts SET publication_status='published'
        WHERE workspace_id=$1 AND operation_id=$2`, [input.workspaceId, operationId]);
      const bytes = Number((await fixture.pool.query(`SELECT octet_length(private_result::text) AS bytes
        FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`, [input.workspaceId, operationId])).rows[0].bytes);
      assert(bytes > (entries === 22_000 ? 8 : 16) * 1024 * 1024);
      if (entries === 22_000) assert(bytes < 16 * 1024 * 1024);
      await readOnly(fixture, async (_client, database, statements) => {
        await assert.rejects(() => readHistoricalNativeWorkspaceCopyReceiptOnConnection(database, { ...input, operationId }),
          { code: 'NATIVE_COPY_HISTORY_TOO_LARGE' });
        assert.equal(statements.some(sql => sql.includes('CASE WHEN octet_length(scope_paths::text)')), entries === 22_000,
          'The SQL text limit must reject the larger body before transferring the payload.');
      });
    }
    completed.push('compact payload and pre-transfer SQL text bounds reject actual oversized rows');
    console.log(JSON.stringify({ suite: 'native-copy-historical-receipt-postgres', families: completed.length, completed }));
  });
}

// Execution is deliberately a separate explicit command after the owner marks
// its implementation stable. Importing this helper never starts a fixture.
if (process.argv[1]?.endsWith('/native-copy-historical-receipt-postgres-test.ts')) {
  void main().catch(() => { console.error('Native copy historical receipt PostgreSQL tests failed.'); process.exitCode = 1; });
}
