import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, types, type PoolClient } from 'pg';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import { COLLABORATION_NATIVE_COPY_STATEMENTS } from '../app/lib/db/collaboration-native-copy-migration';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { completeNativeCopyPublication, completeNativeCopyPublicationOnConnection,
  persistNativeWorkspaceCopies, persistNativeWorkspaceCopiesOnConnection,
  type NativeCopyReceipt, type NativeCopyRequest } from '../app/lib/collaboration/native-copy-persistence';
import type { NativeRecoveryRecord } from '../app/lib/collaboration/native-document-recovery';
import { loadCollaborationStateOnConnection } from '../app/lib/collaboration/persistence';
import { readNativeWorkspaceRecoveryRecords } from '../app/lib/collaboration/workspace-native-recovery';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const PREFIX = 'canvas_native_copy_borrowed_';
const SCHEMA = new RegExp(`^${PREFIX}[0-9a-f]{32}$`, 'u');
const TABLES = ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states',
  'collaboration_yjs_state_backups', 'collaboration_agent_operations', 'collaboration_excalidraw_states',
  'file_revisions', 'file_locks', 'file_guest_invitations', 'collaboration_admission_requests',
  'collaboration_admission_scopes', 'collaboration_admission_targets', 'collaboration_native_copy_receipts'] as const;
type Representation = 'plain_text' | 'tiptap_xml' | 'tiptap_blocks';
type Publication = Parameters<typeof completeNativeCopyPublicationOnConnection>[1];
type SqlResult = Record<string, unknown>[];
type Witness = { pid: number; backendStart: string; xid: string; schema: string; searchPath: string };
type Fixture = { pool: Pool; source: WorkspaceContext; target: WorkspaceContext;
  records: Record<Representation, NativeRecoveryRecord>; schema: string;
  openConnection: () => Promise<SqlConnection>; checkouts: () => number };

function managedDatabase(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  const url = new URL(process.env.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55433' && decodeURIComponent(url.pathname) === '/canvas_notebook' && !url.search && !url.hash,
  'Borrowed native-copy fixtures require managed loopback PostgreSQL 18 at 55433/canvas_notebook.');
  return url;
}
function identifier(schema: string): string {
  assert(SCHEMA.test(schema), 'Only the generated private borrowed-copy schema may be addressed.');
  return `"${schema}"`;
}
function workspace(id: string): WorkspaceContext {
  return { workspaceId: id, organizationId: null, customerId: null, projectId: null,
    workspaceType: 'personal', ownerUserId: 'borrowed-copy-user', rootPath: `/unused-borrowed-copy/${id}`,
    rootRelativePath: `users/${id}`, legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function borrowed(client: PoolClient) {
  const sql: string[] = [];
  let nextResult: ((sql: string, rows: SqlResult) => Promise<void>) | undefined;
  const query = async (statement: string, values: unknown[] = []): Promise<SqlResult> => {
    assert(!/^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|SET\s+LOCAL)\b/iu.test(statement),
      'Borrowed cores must not control their caller transaction or replace owner timeouts.');
    sql.push(statement);
    const rows = (await client.query(statement, values)).rows;
    if (nextResult) { const after = nextResult; nextResult = undefined; await after(statement, rows); }
    return rows;
  };
  const database: SqlConnection = { all: query, run: query, get: async (statement, values) => (await query(statement, values))[0],
    close: async () => { assert.fail('Borrowed cores must not release their caller connection.'); } };
  return { database, sql, afterNextResult: (after: NonNullable<typeof nextResult>) => {
    assert.equal(nextResult, undefined); nextResult = after;
  } };
}
async function witness(client: PoolClient): Promise<Witness> {
  const row = (await client.query(`SELECT pg_backend_pid() AS pid,a.backend_start::text AS started,
    pg_current_xact_id()::text AS xid,current_schema() AS schema,current_setting('search_path') AS search_path
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`)).rows[0];
  return { pid: row.pid, backendStart: row.started, xid: row.xid, schema: row.schema, searchPath: row.search_path };
}
async function transaction<T>(h: Fixture, run: (b: ReturnType<typeof borrowed>, client: PoolClient, before: Witness) => Promise<T>,
  commit = true): Promise<T> {
  const client = await h.pool.connect();
  let ended = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
    const before = await witness(client); assert.equal(before.schema, h.schema);
    const b = borrowed(client), checkouts = h.checkouts();
    const result = await run(b, client, before);
    assert.deepEqual(await witness(client), before, 'The core leaves the actual caller backend and transaction unchanged.');
    assert.equal(h.checkouts(), checkouts, 'Borrowed cores cannot use the explicitly supplied standalone checkout factory.');
    await client.query(commit ? 'COMMIT' : 'ROLLBACK'); ended = true;
    return result;
  } finally {
    if (!ended) await client.query('ROLLBACK');
    client.release();
  }
}
async function snapshot(h: Fixture): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of TABLES) result[table] = (await h.pool.query(`SELECT row_to_json(t)::text AS row
    FROM ${table} t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows.map(row => row.row);
  return result;
}
function request(h: Fixture, representations: readonly Representation[] = ['tiptap_xml']): NativeCopyRequest {
  const nonce = randomUUID();
  return { operationId: `borrowed-${nonce}`, actorUserId: 'borrowed-copy-user', actorSessionId: 'original-session',
    kind: 'native_clone', sourceWorkspace: h.source, targetWorkspace: h.target,
    targetScopes: representations.map(representation => `copy-${nonce}/${representation}.md`),
    copies: representations.map(representation => ({ source: h.records[representation], targetPath: `copy-${nonce}/${representation}.md` })),
    expectedTargets: [], publicationFingerprint: createHash('sha256').update(`Exact plan ${nonce}`).digest('hex') };
}
function publication(input: NativeCopyRequest, receipt: NativeCopyReceipt): Publication {
  return { workspace: input.targetWorkspace, operationId: input.operationId, actorUserId: input.actorUserId,
    actorSessionId: input.actorSessionId, requestFingerprint: receipt.requestFingerprint,
    publicationFingerprint: input.publicationFingerprint! };
}
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'id').map(([key, child]) => [key, withoutIds(child)]));
  return value;
}
async function verifyClone(database: SqlConnection, input: NativeCopyRequest, receipt: NativeCopyReceipt, xid: string): Promise<void> {
  assert.equal(receipt.documents.length, input.copies.length);
  for (const document of receipt.documents) {
    const source = input.copies.find(copy => copy.targetPath === document.clone.path)!.source;
    assert.notEqual(document.clone.documentId, source.state.documentId);
    assert.notEqual(document.clone.lineageId, source.lineageId);
    const state = await loadCollaborationStateOnConnection(database, document.clone.documentId);
    assert(state); assert.equal(state.documentSequence, 0); assert.equal(state.lifecycleGeneration, 1);
    assert.equal(state.hasBom, source.state.hasBom); assert.equal(state.newlineStyle, source.state.newlineStyle);
    const actual = authoritativeNativeCollaborationSnapshot(state), original = authoritativeNativeCollaborationSnapshot(source.state);
    assert.deepEqual(withoutIds(actual.content), withoutIds(original.content), 'Rich attributes and literal text survive native cloning.');
    assert.equal(actual.version.stateProof, document.clone.stateProof);
    assert.equal(document.source.stateProof, original.version.stateProof);
    const originalIds: string[] = [];
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const value = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
      if (value.type !== 'doc' && value.type !== 'text' && value.attrs?.id) originalIds.push(value.attrs.id);
      value.content?.forEach(collect);
    };
    if (original.content.kind === 'rich_text') collect(original.content.document);
    assert.deepEqual(Object.keys(document.blockIdMapping).sort(), originalIds.sort());
    assert.equal(new Set(Object.values(document.blockIdMapping)).size, originalIds.length);
    assert(Object.values(document.blockIdMapping).every(id => !originalIds.includes(id)));
    const xmins = await database.all(`SELECT xmin::text AS xmin FROM collaboration_documents WHERE id=$1
      UNION ALL SELECT xmin::text FROM collaboration_yjs_states WHERE document_id=$1
      UNION ALL SELECT xmin::text FROM file_collaboration_lineages WHERE id=$2`,
    [document.clone.documentId, document.clone.lineageId]) as Array<{ xmin: string }>;
    assert.equal(xmins.length, 3);
    assert(xmins.every(row => row.xmin === (BigInt(xid) % BigInt('4294967296')).toString()), 'Every native write belongs to the caller XID.');
  }
  const ledger = await database.get(`SELECT xmin::text AS xmin,private_result,actor_user_id,actor_session_id
    FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
  [input.targetWorkspace.workspaceId, input.operationId]) as Record<string, unknown>;
  assert.equal(ledger.xmin, (BigInt(xid) % BigInt('4294967296')).toString());
  assert.equal(ledger.actor_user_id, input.actorUserId); assert.equal(ledger.actor_session_id, input.actorSessionId ?? null);
  const { publicationStatus: _status, ...body } = receipt;
  assert.deepEqual(ledger.private_result, body);
}

async function seed(pool: Pool, source: WorkspaceContext, representation: Representation): Promise<NativeRecoveryRecord> {
  const doc = representation === 'plain_text' ? new Y.Doc() : nativeTableWidthFixture(representation, 'A\tB\r\n😀');
  const documentId = `borrowed-source-${randomUUID()}`, lineageId = `lineage-${randomUUID()}`, sourcePath = `${representation}.md`;
  try {
    if (representation === 'plain_text') doc.getText('content').insert(0, 'Literal\tplain\r\n😀\r\n');
    else {
      doc.getText('frontmatter').insert(0, '---\r\ntitle: Borrowed private native fixture\r\n---\r\n');
      doc.getText('bodyFinalLineEnding').insert(0, '\r\n\r\n');
    }
    await pool.query(`INSERT INTO file_collaboration_lineages (id,workspace_id,workspace_type,path,status,created_at)
      VALUES ($1,$2,'personal',$3,'active',1)`, [lineageId, source.workspaceId, sourcePath]);
    await pool.query(`INSERT INTO collaboration_documents
      (id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
      VALUES ($1,$2,$3,'personal',$4,'yjs','active',0,1,1,'initialized')`, [documentId, lineageId, source.workspaceId, sourcePath]);
    await pool.query(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,path,representation,lifecycle_generation,
      schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
      VALUES ($1,$2,$3,$4,1,1,$5,$6,3,1,0,'crlf',1,0,'active')`,
    [documentId, source.workspaceId, sourcePath, representation, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
    const client = await pool.connect();
    try {
      const records = await readNativeWorkspaceRecoveryRecords(borrowed(client).database, source, sourcePath);
      assert.equal(records.length, 1); return records[0];
    } finally { client.release(); }
  } finally { doc.destroy(); }
}

async function withFixture(run: (h: Fixture) => Promise<number>): Promise<void> {
  const url = managedDatabase();
  if (!url) { console.log('SKIP borrowed native-copy PostgreSQL: managed PG18 connection not supplied.'); return; }
  const schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`, applicationName = `copy-borrowed-${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3_000,
    allowExitOnIdle: true, application_name: `${applicationName}-admin` });
  let pool: Pool | undefined, created = false, schemaOid: string | undefined, primary: unknown, failed = false;
  let opened = 0, closed = 0, groups = 0;
  try {
    const server = (await admin.query(`SELECT current_setting('server_version_num')::int AS version,current_database() AS database`)).rows[0];
    assert.equal(Math.floor(server.version / 10_000), 18); assert.equal(server.database, 'canvas_notebook');
    for (const table of TABLES.filter(table => table !== 'collaboration_native_copy_receipts')) {
      assert.equal((await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`])).rows[0].present, true);
    }
    await admin.query(`CREATE SCHEMA ${identifier(schema)}`); created = true;
    const identity = (await admin.query(`SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned
      FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
    assert.equal(identity.owned, true); schemaOid = identity.oid;
    console.log(JSON.stringify({ fixture: 'native-copy-borrowed', schema, schemaOid, applicationName }));
    pool = new Pool({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 3_000, allowExitOnIdle: true,
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8
        ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=4000`, application_name: applicationName });
    assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    for (const table of TABLES.filter(table => table !== 'collaboration_native_copy_receipts')) {
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    for (let pass = 0; pass < 2; pass++) for (const statement of COLLABORATION_NATIVE_COPY_STATEMENTS) await pool.query(statement);
    const fixturePool = pool, source = workspace('borrowed-source'), target = workspace('borrowed-target');
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await fixturePool.connect(); opened += 1; let released = false;
      const query = async (statement: string, values: unknown[] = []) => (await client.query(statement, values)).rows;
      return { run: query, all: query, get: async (statement, values) => (await query(statement, values))[0], close: async error => {
        assert.equal(released, false); released = true; closed += 1; client.release(error);
      } };
    };
    const records: Fixture['records'] = { plain_text: await seed(pool, source, 'plain_text'),
      tiptap_xml: await seed(pool, source, 'tiptap_xml'), tiptap_blocks: await seed(pool, source, 'tiptap_blocks') };
    groups = await run({ pool, source, target, records, schema, openConnection, checkouts: () => opened });
    assert.equal(opened, closed); assert.equal(pool.waitingCount, 0);
  } catch (error) { primary = error; failed = true; }
  finally {
    const cleanup: unknown[] = [];
    try { await pool?.end(); } catch (error) { cleanup.push(error); }
    try { assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
      [applicationName])).rows[0].count, 0); } catch (error) { cleanup.push(error); }
    if (created) try {
      const identity = (await admin.query(`SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned
        FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
      assert.equal(identity?.oid, schemaOid); assert.equal(identity?.owned, true);
      await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1 OR oid::text=$2',
        [schema, schemaOid])).rows[0].count, 0);
    } catch (error) { cleanup.push(error); }
    try { await admin.end(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Owned borrowed-copy fixture cleanup failed.');
    if (failed) throw primary;
  }
  console.log(JSON.stringify({ test: 'native-copy-borrowed-connection-postgres-test', groups,
    schema, schemaOid, applicationName, schemaRemoved: true, poolClosed: true, opened, closed }));
}

function nativeConflict(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown; status?: unknown }).code === 'NATIVE_DOCUMENT_RECOVERY_UNAVAILABLE'
    && (error as Error & { status?: unknown }).status === 409;
}

async function main(): Promise<void> {
  await withFixture(async h => {
    let groups = 0;
    const group = async (label: string, run: () => Promise<void>) => {
      await run(); groups += 1; console.log(`PASS borrowed-copy ${groups}: ${label}`);
    };
    let referenceInput!: NativeCopyRequest, referenceReceipt!: NativeCopyReceipt;
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      await group(`${representation}: genuine clone on caller B/XID, invisible before commit, old wrapper retry and publication`, async () => {
        const input = request(h, [representation]);
        const receipt = await transaction(h, async (b, _client, before) => {
          const result = await persistNativeWorkspaceCopiesOnConnection(b.database, input);
          await verifyClone(b.database, input, result, before.xid);
          assert.equal((await h.pool.query(`SELECT count(*)::int AS count FROM collaboration_native_copy_receipts
            WHERE operation_id=$1`, [input.operationId])).rows[0].count, 0);
          assert.equal((await h.pool.query(`SELECT count(*)::int AS count FROM collaboration_documents
            WHERE workspace_id=$1 AND path=$2`, [h.target.workspaceId, input.copies[0].targetPath])).rows[0].count, 0);
          assert(b.sql.length > 10, 'The actual DAL traversed and wrote this borrowed connection.');
          return result;
        });
        assert.deepEqual(await persistNativeWorkspaceCopies(input, h.openConnection), receipt,
          'The original standalone wrapper recognizes the borrowed core\'s exact persisted receipt.');
        await completeNativeCopyPublication(publication(input, receipt), h.openConnection);
        const published = { ...receipt, publicationStatus: 'published' as const };
        await transaction(h, async b => {
          assert.deepEqual(await persistNativeWorkspaceCopiesOnConnection(b.database, input), published);
          await completeNativeCopyPublicationOnConnection(b.database, publication(input, receipt));
        });
        referenceInput = input; referenceReceipt = published;
      });
    }

    await group('a three-representation clone and publication roll back together with the outer transaction', async () => {
      const input = request(h, ['plain_text', 'tiptap_xml', 'tiptap_blocks']), before = await snapshot(h);
      await transaction(h, async (b, _client, identity) => {
        const receipt = await persistNativeWorkspaceCopiesOnConnection(b.database, input);
        await verifyClone(b.database, input, receipt, identity.xid);
        await completeNativeCopyPublicationOnConnection(b.database, publication(input, receipt));
        assert.equal((await b.database.get(`SELECT publication_status FROM collaboration_native_copy_receipts
          WHERE workspace_id=$1 AND operation_id=$2`, [h.target.workspaceId, input.operationId]) as { publication_status: string }).publication_status, 'published');
        assert.deepEqual(await snapshot(h), before, 'Independent observer cannot see any uncommitted native or receipt mutation.');
      }, false);
      assert.deepEqual(await snapshot(h), before, 'Caller rollback removes all clone and publication effects.');
    });

    await group('a real SQL error after successful clone/publication leaves no partial outer effects', async () => {
      const input = request(h, ['plain_text', 'tiptap_blocks']), before = await snapshot(h);
      await assert.rejects(transaction(h, async (b, client) => {
        const receipt = await persistNativeWorkspaceCopiesOnConnection(b.database, input);
        await completeNativeCopyPublicationOnConnection(b.database, publication(input, receipt));
        await client.query('SELECT 1/0');
      }), (error: unknown) => error instanceof Error && (error as Error & { code?: unknown }).code === '22012');
      assert.deepEqual(await snapshot(h), before);
    });

    await group('separate B2 publication rollback preserves the original committed body and native_committed status', async () => {
      const input = request(h), receipt = await transaction(h, b => persistNativeWorkspaceCopiesOnConnection(b.database, input));
      const before = await snapshot(h);
      await transaction(h, async b => {
        await completeNativeCopyPublicationOnConnection(b.database, publication(input, receipt));
        assert.deepEqual(await snapshot(h), before);
      }, false);
      assert.deepEqual(await snapshot(h), before);
      await transaction(h, b => completeNativeCopyPublicationOnConnection(b.database, publication(input, receipt)));
      const row = (await h.pool.query(`SELECT private_result,publication_status FROM collaboration_native_copy_receipts
        WHERE workspace_id=$1 AND operation_id=$2`, [h.target.workspaceId, input.operationId])).rows[0];
      const { publicationStatus: _status, ...body } = receipt;
      assert.deepEqual(row.private_result, body); assert.equal(row.publication_status, 'published');
    });

    await group('native restore replacement and archived original identities are restored by caller rollback', async () => {
      const source = h.records.tiptap_xml, native = authoritativeNativeCollaborationSnapshot(source.state), before = await snapshot(h);
      const input: NativeCopyRequest = { ...request(h), kind: 'native_restore', sourceWorkspace: h.source, targetWorkspace: h.source,
        targetScopes: [source.state.path], copies: [{ source, targetPath: source.state.path }],
        expectedTargets: [{ documentId: source.state.documentId, path: source.state.path, authority: 'initialized',
          lifecycleGeneration: source.state.lifecycleGeneration, stateProof: native.version.stateProof }] };
      await transaction(h, async (b, _client, identity) => {
        const receipt = await persistNativeWorkspaceCopiesOnConnection(b.database, input);
        await verifyClone(b.database, input, receipt, identity.xid);
        assert.notEqual(receipt.documents[0].clone.documentId, source.state.documentId);
        assert.deepEqual(await snapshot(h), before);
      }, false);
      assert.deepEqual(await snapshot(h), before);
    });

    await group('canonical scope sorting/deduplication preserves exact multi-document retry and the old wrapper', async () => {
      const input = request(h, ['tiptap_xml', 'plain_text']);
      const receipt = await transaction(h, b => persistNativeWorkspaceCopiesOnConnection(b.database, input));
      const reordered = { ...input, targetScopes: [...input.targetScopes].reverse().concat(input.targetScopes[0]) };
      await transaction(h, async b => {
        assert.deepEqual(await persistNativeWorkspaceCopiesOnConnection(b.database, reordered), receipt);
      });
      assert.deepEqual(await persistNativeWorkspaceCopies(reordered, h.openConnection), receipt);
    });

    await group('original actor/session, source bytes/profile, target scope and physical-plan conflicts never mutate the receipt', async () => {
      const before = await snapshot(h);
      const mutations: Array<{ label: string; mutate: (input: NativeCopyRequest) => void }> = [
        { label: 'actor user', mutate: input => { input.actorUserId = 'other-user'; } },
        { label: 'actor session', mutate: input => { input.actorSessionId = 'new-session'; } },
        { label: 'missing original session', mutate: input => { delete input.actorSessionId; } },
        { label: 'target organization', mutate: input => { input.targetWorkspace.organizationId = 'other-org'; } },
        { label: 'target path', mutate: input => {
          input.copies = [{ ...input.copies[0], targetPath: 'other-target.md' }]; input.targetScopes = ['other-target.md'];
        } },
        { label: 'physical fingerprint', mutate: input => { input.publicationFingerprint = 'f'.repeat(64); } },
        { label: 'source profile', mutate: input => { input.copies[0].source.state.hasBom = false; } },
        { label: 'source bytes', mutate: input => {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, input.copies[0].source.state.yjsState);
            doc.getText('frontmatter').insert(0, '# valid different native bytes\n');
            input.copies[0].source.state.yjsState = Y.encodeStateAsUpdate(doc);
            input.copies[0].source.state.stateVector = Y.encodeStateVector(doc);
          } finally { doc.destroy(); }
        } },
      ];
      for (const test of mutations) {
        const input = structuredClone(referenceInput); test.mutate(input);
        await assert.rejects(transaction(h, b => persistNativeWorkspaceCopiesOnConnection(b.database, input)), nativeConflict, test.label);
        assert.deepEqual(await snapshot(h), before, test.label);
      }
      const expected = publication(referenceInput, referenceReceipt);
      for (const change of [{ actorUserId: 'other-user' }, { actorSessionId: 'new-session' },
        { requestFingerprint: 'f'.repeat(64) }, { publicationFingerprint: 'e'.repeat(64) }]) {
        await assert.rejects(transaction(h, b => completeNativeCopyPublicationOnConnection(b.database, { ...expected, ...change })), nativeConflict);
        assert.deepEqual(await snapshot(h), before);
      }
    });

    await group('stored malformed private receipt bodies are rejected through the real immutable ledger reader', async () => {
      // These are declared stored-format counterexamples; they are not claimed
      // as successful original clones or edits of an immutable original row.
      const row = (await h.pool.query(`SELECT * FROM collaboration_native_copy_receipts
        WHERE workspace_id=$1 AND operation_id=$2`, [h.target.workspaceId, referenceInput.operationId])).rows[0];
      const before = await snapshot(h);
      const changes: Array<(body: NativeCopyReceipt) => void> = [
        body => { body.version = 2 as never; },
        body => { body.documents[0].source.stateProof = 'yjs-snapshot-sha256-v1:' + 'f'.repeat(64); },
        body => { body.documents[0].clone.initialSequence = 1 as never; },
        body => { body.documents[0].clone.path = 'different.md'; },
        body => { body.documents = []; },
        body => { body.documents[0].blockIdMapping = {}; },
      ];
      for (const change of changes) {
        const operationId = `malformed-${randomUUID()}`, body = structuredClone(row.private_result) as NativeCopyReceipt;
        body.operationId = operationId; change(body);
        await transaction(h, async (b, client) => {
          await client.query(`INSERT INTO collaboration_native_copy_receipts (workspace_id,operation_id,organization_id,actor_user_id,
            actor_session_id,version,kind,request_fingerprint,scope_paths,private_result,created_at,publication_fingerprint,publication_status)
            VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8::jsonb,$9::jsonb,$10,$11,'native_committed')`,
          [row.workspace_id, operationId, row.organization_id, row.actor_user_id, row.actor_session_id, row.kind,
            row.request_fingerprint, JSON.stringify(row.scope_paths), JSON.stringify(body), row.created_at, row.publication_fingerprint]);
          await assert.rejects(persistNativeWorkspaceCopiesOnConnection(b.database, { ...referenceInput, operationId }), nativeConflict);
        }, false);
        assert.deepEqual(await snapshot(h), before);
      }
    });

    await group('both borrowed APIs reject autocommit, read-only and repeatable-read before domain mutation', async () => {
      const before = await snapshot(h);
      for (const begin of [null, 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE']) {
        for (const method of ['clone', 'publication'] as const) {
          const client = await h.pool.connect();
          try {
            if (begin) await client.query(begin);
            const b = borrowed(client), input = request(h);
            await assert.rejects(method === 'clone' ? persistNativeWorkspaceCopiesOnConnection(b.database, input)
              : completeNativeCopyPublicationOnConnection(b.database, publication(referenceInput, referenceReceipt)), nativeConflict,
            `${method}: ${begin ?? 'autocommit'}`);
            assert(b.sql.every(sql => !/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)), 'Invalid transaction has no domain writes.');
          } finally { if (begin) await client.query('ROLLBACK'); client.release(); }
        }
      }
      assert.deepEqual(await snapshot(h), before);
    });

    await group('actual COMMIT/BEGIN drift during the first SQL acknowledgement is rejected before domain writes', async () => {
      const before = await snapshot(h);
      for (const method of ['clone', 'publication'] as const) {
        const client = await h.pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          const identity = await witness(client), b = borrowed(client), input = request(h);
          b.afterNextResult(async () => {
            await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
            assert.notEqual((await witness(client)).xid, identity.xid);
          });
          await assert.rejects(method === 'clone' ? persistNativeWorkspaceCopiesOnConnection(b.database, input)
            : completeNativeCopyPublicationOnConnection(b.database, publication(referenceInput, referenceReceipt)), nativeConflict);
          assert(b.sql.every(sql => !/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)));
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
      assert.deepEqual(await snapshot(h), before);
    });

    await group('literal search_path drift during the first SQL acknowledgement is rejected without schema adoption', async () => {
      const before = await snapshot(h);
      for (const method of ['clone', 'publication'] as const) {
        const client = await h.pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          const identity = await witness(client), b = borrowed(client), input = request(h);
          b.afterNextResult(async () => {
            await client.query(`SET LOCAL search_path=${identifier(h.schema)},pg_catalog,pg_temp`);
            const after = await witness(client); assert.equal(after.schema, h.schema); assert.notEqual(after.searchPath, identity.searchPath);
          });
          await assert.rejects(method === 'clone' ? persistNativeWorkspaceCopiesOnConnection(b.database, input)
            : completeNativeCopyPublicationOnConnection(b.database, publication(referenceInput, referenceReceipt)), nativeConflict);
          assert(b.sql.every(sql => !/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)));
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
      assert.deepEqual(await snapshot(h), before);
    });

    await group('search_path drift after the actual receipt INSERT is rejected by the post-witness and the caller rolls back every row', async () => {
      const input = request(h, ['plain_text', 'tiptap_blocks']), before = await snapshot(h);
      let observedReceiptInsert = false;
      await assert.rejects(transaction(h, async (b, client) => {
        const afterResult = async (sql: string): Promise<void> => {
          if (/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(sql)) {
            observedReceiptInsert = true;
            await client.query(`SET LOCAL search_path=${identifier(h.schema)},pg_catalog,pg_temp`);
          } else b.afterNextResult(afterResult);
        };
        b.afterNextResult(afterResult);
        await persistNativeWorkspaceCopiesOnConnection(b.database, input);
      }), nativeConflict);
      assert.equal(observedReceiptInsert, true, 'Drift is injected only after the real final ledger write acknowledged.');
      assert.deepEqual(await snapshot(h), before);
    });

    await group('a second borrowed API on the identical B poisons both calls during the first actual identity acknowledgement', async () => {
      const before = await snapshot(h), input = request(h), entered = deferred(), release = deferred();
      await transaction(h, async b => {
        b.afterNextResult(async () => { entered.resolve(); await release.promise; });
        const first = persistNativeWorkspaceCopiesOnConnection(b.database, input);
        await entered.promise;
        try {
          await assert.rejects(completeNativeCopyPublicationOnConnection(b.database,
            publication(referenceInput, referenceReceipt)), nativeConflict);
        } finally { release.resolve(); }
        await assert.rejects(first, nativeConflict);
        assert(b.sql.every(sql => !/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)), 'The poisoned entry never reaches domain writes.');
      }, false);
      assert.deepEqual(await snapshot(h), before);
    });

    await group('clone captures caller source bytes/profile, workspace, scopes, actor and target before the first real SQL await', async () => {
      const input = structuredClone(request(h)), expected = structuredClone(input), entered = deferred(), release = deferred();
      await transaction(h, async (b, _client, identity) => {
        b.afterNextResult(async () => { entered.resolve(); await release.promise; });
        const pending = persistNativeWorkspaceCopiesOnConnection(b.database, input);
        await entered.promise;
        input.operationId = `different-${randomUUID()}`; input.actorUserId = 'later-user'; input.actorSessionId = 'later-session';
        input.sourceWorkspace.rootPath = '/later-source-root'; input.sourceWorkspace.permissions.canRead = false;
        input.targetWorkspace.workspaceId = 'later-workspace'; input.targetWorkspace.permissions.canWrite = false;
        (input.targetScopes as string[])[0] = 'later-target.md'; input.publicationFingerprint = 'f'.repeat(64);
        input.copies[0].source.state.yjsState.fill(0); input.copies[0].source.state.hasBom = false;
        input.copies = [{ ...input.copies[0], targetPath: 'later-target.md' }];
        release.resolve();
        const receipt = await pending;
        assert.equal(receipt.operationId, expected.operationId); assert.equal(receipt.workspaceId, expected.targetWorkspace.workspaceId);
        await verifyClone(b.database, expected, receipt, identity.xid);
        await completeNativeCopyPublicationOnConnection(b.database, publication(expected, receipt));
      });
      assert.equal((await h.pool.query(`SELECT actor_user_id,actor_session_id FROM collaboration_native_copy_receipts
        WHERE workspace_id=$1 AND operation_id=$2`, [h.target.workspaceId, expected.operationId])).rows[0].actor_session_id, 'original-session');
    });

    await group('publication captures the original receipt pins and workspace before the first real SQL await', async () => {
      const input = request(h, ['plain_text']), receipt = await transaction(h, b => persistNativeWorkspaceCopiesOnConnection(b.database, input));
      const captured = structuredClone(publication(input, receipt)), entered = deferred(), release = deferred();
      await transaction(h, async b => {
        b.afterNextResult(async () => { entered.resolve(); await release.promise; });
        const pending = completeNativeCopyPublicationOnConnection(b.database, captured);
        await entered.promise;
        captured.actorUserId = 'later-user'; captured.actorSessionId = 'later-session'; captured.operationId = 'later-operation';
        captured.workspace.workspaceId = 'later-workspace'; captured.workspace.permissions.canWrite = false;
        captured.requestFingerprint = 'f'.repeat(64); captured.publicationFingerprint = 'e'.repeat(64);
        release.resolve(); await pending;
      });
      const row = (await h.pool.query(`SELECT publication_status,actor_user_id,actor_session_id FROM collaboration_native_copy_receipts
        WHERE workspace_id=$1 AND operation_id=$2`, [h.target.workspaceId, input.operationId])).rows[0];
      assert.equal(row.publication_status, 'published'); assert.equal(row.actor_user_id, input.actorUserId);
      assert.equal(row.actor_session_id, 'original-session');
    });
    return groups;
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    : 'Borrowed native-copy fixture failed.');
  process.exitCode = 1;
});
