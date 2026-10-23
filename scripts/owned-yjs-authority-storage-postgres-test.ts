/** Actual PG18 BIGINT rows through the owned test adapter and native snapshot. No host is started. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, types } from 'pg';
import { privateBytes } from './lib/owned-yjs-authority-qa';
import { ownedYjsStateFromSqlRow, type OwnedYjsStorageRow } from './lib/owned-yjs-authority-storage-row';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';

let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  const connectionString = parse(await privateBytes('/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env')).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert(!url.search && !url.hash);
  const schema = `owned_storage_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^owned_storage_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5_000, options: '-c statement_timeout=15000' });
  let database: Client | undefined, dataRoot: string | undefined, created = false, completed = 0;
  try {
    stage = 'actual target and owner';
    await control.connect();
    const identity = (await control.query(`SELECT current_database() AS name,d.oid::text AS oid,
      pg_get_userbyid(d.datdba) AS owner,current_user AS role,current_setting('server_version_num') AS version
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.equal(identity.name, 'canvas_notebook'); assert.equal(identity.owner, identity.role);
    assert.equal(identity.role, decodeURIComponent(url.username)); assert.match(identity.oid, /^\d+$/u);
    assert.equal(Math.floor(Number(identity.version) / 10000), 18);
    assert.equal((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    assert.equal((await control.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].owner, identity.role);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-owned-storage-'));
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog`,
      CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external', CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true',
      CANVAS_POSTGRES_VECTOR_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, BETTER_AUTH_BASE_URL: 'https://canvas.test' });
    globalThis.fetch = async () => { throw new Error('External access is prohibited in this isolated adapter fixture.'); };
    // Match a fresh direct-pg storage child even if a later application import sets global INT8 parsers.
    database = new Client({ connectionString, connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=1000`,
      types: { getTypeParser: (oid: number, format?: 'text' | 'binary') => oid === types.builtins.INT8
        ? (value: string) => value : types.getTypeParser(oid, format) } });
    await database.connect();
    const pid = (await database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const owned = async () => {
      const current = (await database!.query(`SELECT current_database() AS name,d.oid::text AS oid,current_user AS role,
        current_schema() AS schema,current_setting('search_path') AS path,pg_backend_pid() AS pid
        FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
      assert.equal(current.name, identity.name); assert.equal(current.oid, identity.oid); assert.equal(current.role, identity.role);
      assert.equal(current.schema, schema); assert.equal(current.path, `${schema},pg_catalog`); assert.equal(current.pid, pid);
    };
    const query = async (sql: string, values?: unknown[]) => { await owned(); const result = await database!.query(sql, values); await owned(); return result; };
    stage = 'owned table only';
    await query(`CREATE TABLE collaboration_yjs_states (
      document_id text PRIMARY KEY,workspace_id text NOT NULL,organization_id text,path text NOT NULL,representation text NOT NULL,
      lifecycle_generation bigint NOT NULL,schema_version bigint NOT NULL,yjs_state bytea NOT NULL,state_vector bytea NOT NULL,
      document_sequence bigint NOT NULL,persisted_at bigint NOT NULL,checkpointed_at bigint,checkpoint_sequence bigint NOT NULL,
      canonical_hash text,serialized_hash text,newline_style text NOT NULL,has_bom bigint NOT NULL,degraded bigint NOT NULL,status text NOT NULL,
      projection_error_code text,projection_error_phase text,projection_error_sequence bigint,projection_error_generation bigint,
      projection_error_permanent bigint NOT NULL)`);
    // No global migrations, extension creation or application imports before target/schema/DATA are bound.
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { authoritativeNativeCollaborationSnapshot: snapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { getSchema } = await import('@tiptap/core');
    const workspaceId = `storage-${randomUUID()}`, organizationId = randomUUID();
    const fixture = async (name: string, test: () => Promise<void>) => { stage = name; await test(); console.log(`ok ${++completed} - ${name}`); };
    const seed = async (representation: PersistedCollaborationState['representation'] = 'tiptap_blocks', empty = false, nativeOnly = false) => {
      const text = empty ? '' : nativeOnly ? '| Keep |\n| --- |\n| [Target](target.md) |' : 'First durable paste: äöü 😀\n\nPeer paragraph. Peer persisted.';
      const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
      try {
        if (nativeOnly) {
          const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
          for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
            (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
          }
          assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
        }
        const state: PersistedCollaborationState = { documentId: randomUUID(), workspaceId, organizationId,
          path: `owned-yjs-restart-${randomUUID()}.md`, representation, lifecycleGeneration: 1, schemaVersion: 1,
          yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: empty ? 0 : 2,
          persistedAt: Date.now(), checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
          newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
        await query(`INSERT INTO collaboration_yjs_states VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9,NULL,0,NULL,NULL,'lf',0,0,'active',NULL,NULL,NULL,NULL,0)`,
          [state.documentId, workspaceId, organizationId, state.path, representation, Buffer.from(state.yjsState), Buffer.from(state.stateVector), state.documentSequence, state.persistedAt]);
        const expected = snapshot(state); assert.equal(expected.version.stateProof, collaborationStateProof(doc, Y));
        return { state, expected };
      } finally { doc.destroy(); }
    };
    const read = async (state: PersistedCollaborationState): Promise<OwnedYjsStorageRow> => {
      await query('BEGIN READ ONLY');
      try {
        const result = await query(`SELECT * FROM collaboration_yjs_states WHERE document_id=$1 AND workspace_id=$2
          AND organization_id=$3 AND path=$4 AND lifecycle_generation=$5 AND status='active'`,
        [state.documentId, state.workspaceId, state.organizationId, state.path, state.lifecycleGeneration]);
        assert.equal(result.rowCount, 1); return result.rows[0];
      } finally { await query('ROLLBACK'); }
    };
    const quarantine = (error: unknown) => (error as { code?: string })?.code === 'COLLABORATION_QUARANTINED';
    await fixture('actual BIGINT string zeros expose the old quarantine defect and retain full native proof', async () => {
      const { state, expected } = await seed(), row = await read(state);
      for (const field of ['has_bom', 'degraded', 'projection_error_permanent'] as const) assert.equal(row[field], '0');
      const mapped = ownedYjsStateFromSqlRow(row);
      // Exact removed coercions reproduce the old failure on this genuine SQL row.
      assert.throws(() => snapshot({ ...mapped, hasBom: Boolean(row.has_bom), degraded: Boolean(row.degraded) }), quarantine);
      assert.deepEqual({ ...mapped, yjsState: state.yjsState, stateVector: state.stateVector }, state); assert.deepEqual(snapshot(mapped), expected);
      assert.deepEqual(Buffer.from(mapped.yjsState), Buffer.from(state.yjsState)); assert.deepEqual(Buffer.from(mapped.stateVector), Buffer.from(state.stateVector));
      assert.deepEqual(await read(state), row, 'decoding does not alter any persisted field or native bytes');
    });
    await fixture('Plain XML Blocks and empty sequence-zero snapshots retain exact native content', async () => {
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const empty of [false, true]) {
        const { state, expected } = await seed(representation, empty), row = await read(state);
        assert.deepEqual(snapshot(ownedYjsStateFromSqlRow(row)), expected);
        assert.deepEqual(await read(state), row);
      }
    });
    await fixture('native-only table widths survive without a Markdown export', async () => {
      const { state, expected } = await seed('tiptap_blocks', false, true);
      await query(`UPDATE collaboration_yjs_states SET projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE',
        projection_error_generation=1,projection_error_sequence=2,projection_error_phase='checkpoint' WHERE document_id=$1`, [state.documentId]);
      const mapped = ownedYjsStateFromSqlRow(await read(state)), actual = snapshot(mapped);
      assert.deepEqual(actual.content, expected.content); assert.equal(actual.version.stateProof, expected.version.stateProof);
      assert.match(JSON.stringify(actual.content), /"colwidth":\[120\]/u); assert.equal(mapped.projectionError?.permanent, false);
    });
    await fixture('supported numeric flags and BOM CRLF metadata remain exact', async () => {
      const { state, expected } = await seed();
      for (const bom of [0, 1]) {
        await query(`UPDATE collaboration_yjs_states SET has_bom=$2,newline_style='crlf' WHERE document_id=$1`, [state.documentId, bom]);
        const row = await read(state), mapped = ownedYjsStateFromSqlRow(row);
        assert.equal(mapped.hasBom, bom === 1); assert.equal(mapped.newlineStyle, 'crlf'); assert.deepEqual(snapshot(mapped), expected);
        assert.deepEqual(ownedYjsStateFromSqlRow({ ...row, has_bom: bom, degraded: 0, projection_error_permanent: 0 }), mapped);
      }
    });
    await fixture('actual degradation and bound permanent errors still quarantine', async () => {
      const { state } = await seed();
      await query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [state.documentId]);
      const degraded = ownedYjsStateFromSqlRow(await read(state));
      assert.equal(degraded.degraded, true); assert.throws(() => snapshot(degraded), quarantine);
      await query(`UPDATE collaboration_yjs_states SET degraded=0,projection_error_permanent=1,projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE',
        projection_error_generation=1,projection_error_sequence=2 WHERE document_id=$1`, [state.documentId]);
      const row = await read(state), mapped = ownedYjsStateFromSqlRow(row);
      assert.equal(mapped.projectionError?.permanent, true); assert.throws(() => snapshot(mapped), quarantine);
      assert.deepEqual(await read(state), row);
    });
    await fixture('nonpermanent persistence retry keeps its original native-read semantics', async () => {
      const { state, expected } = await seed();
      await query(`UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_YJS_PERSISTENCE_FAILED',
        projection_error_generation=1,projection_error_sequence=2,projection_error_phase='persistence' WHERE document_id=$1`, [state.documentId]);
      const row = await read(state), mapped = ownedYjsStateFromSqlRow(row);
      assert.equal(mapped.degraded, true); assert.equal(mapped.projectionError?.permanent, false);
      assert.deepEqual(snapshot(mapped).content, expected.content); assert.equal(snapshot(mapped).version.stateProof, expected.version.stateProof);
      assert.throws(() => snapshot({ ...mapped, projectionError: { ...mapped.projectionError!, permanent: Boolean(row.projection_error_permanent) } }), quarantine);
    });
    await fixture('actual malformed BIGINT flags reject even with missing or stale error bindings', async () => {
      const { state } = await seed();
      for (const field of ['has_bom', 'degraded', 'projection_error_permanent'] as const) for (const invalid of [-1, 2]) for (const generation of [null, 2]) {
        await query(`UPDATE collaboration_yjs_states SET has_bom=$2,degraded=$3,projection_error_permanent=$4,
          projection_error_code=$5,projection_error_generation=$6 WHERE document_id=$1`,
        [state.documentId, field === 'has_bom' ? invalid : 0, field === 'degraded' ? invalid : 0,
          field === 'projection_error_permanent' ? invalid : 0, generation === null ? null : 'COLLABORATION_ROUNDTRIP_UNSTABLE', generation]);
        const row = await read(state); assert.throws(() => ownedYjsStateFromSqlRow(row), /SQL flag is unavailable/u);
        assert.deepEqual(await read(state), row);
      }
    });
    await fixture('unsupported raw flag values never gain Boolean truthiness authority', async () => {
      const { state } = await seed(), row = await read(state);
      for (const field of ['has_bom', 'degraded', 'projection_error_permanent'] as const) {
        for (const invalid of [null, undefined, '', '00', '01', 'false', 'true', ' 0', '0 ', true, false, NaN, Infinity, BigInt(0), {}, []]) {
          assert.throws(() => ownedYjsStateFromSqlRow({ ...row, [field]: invalid }), /SQL flag is unavailable/u);
        }
      }
    });
    await fixture('permanent SQL flags cannot disappear through missing or stale code generation', async () => {
      const { state } = await seed();
      for (const [code, generation] of [[null, null], [null, 1], ['', 1], ['COLLABORATION_ROUNDTRIP_UNSTABLE', null], ['COLLABORATION_ROUNDTRIP_UNSTABLE', 2]] as const) {
        await query(`UPDATE collaboration_yjs_states SET projection_error_permanent=1,projection_error_code=$2,
          projection_error_generation=$3 WHERE document_id=$1`, [state.documentId, code, generation]);
        const row = await read(state); assert.throws(() => ownedYjsStateFromSqlRow(row), /permanent error binding is unavailable/u);
        assert.deepEqual(await read(state), row);
      }
    });
    await fixture('native identity schema vector and trailing-byte rejection remain enforced', async () => {
      const { state } = await seed(), row = await read(state);
      for (const change of [{ schema_version: '2' }, { lifecycle_generation: '0' }, { status: 'archived' as const },
        { representation: 'plain_text' as const }, { state_vector: Buffer.from([0]) }, { yjs_state: Buffer.concat([row.yjs_state, Buffer.from([0])]) }]) {
        assert.throws(() => snapshot(ownedYjsStateFromSqlRow({ ...row, ...change })));
      }
      assert.deepEqual(await read(state), row);
    });
    console.log(`Passed ${completed} owned storage adapter groups; no original child-guard or restart outcome is certified.`);
  } finally {
    globalThis.fetch = originalFetch;
    try { await database?.end(); }
    finally {
      try {
        if (created) {
          await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          assert.equal((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        }
      } finally {
        try { await control.end(); }
        finally {
          if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
          for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
          Object.assign(process.env, environment);
        }
      }
    }
  }
}

void main().catch((error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  console.error(`Owned storage adapter fixture failed during ${stage}; code ${typeof code === 'string' && /^(?:ERR_ASSERTION|COLLABORATION_[A-Z_]+)$/u.test(code) ? code : 'unclassified'}.`);
  process.exitCode = 1;
});
