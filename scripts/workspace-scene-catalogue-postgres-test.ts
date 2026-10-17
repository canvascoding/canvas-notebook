import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { types as postgresTypes } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real PG18 + complete migrations in an owned schema/DATA. Direct SQL below
// creates explicit durable catalogue facts and adversarial stored-data faults;
// it does not establish authentication, lifecycle ownership or file-action proof.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const hash = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const errorCode = (error: unknown): unknown => error && typeof error === 'object'
  ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;

async function sceneCatalogueFilesystemSnapshot(root: string): Promise<unknown[]> {
  const records: unknown[] = [];
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative), info = await lstat(absolute);
    records.push({ path: relative, dev: info.dev, ino: info.ino, mode: info.mode, size: info.size,
      mtime: info.mtimeMs, ctime: info.ctimeMs, ...(info.isFile() ? { sha256: hash(await readFile(absolute)) } : {}) });
    if (info.isDirectory()) for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
  };
  await visit('');
  return records;
}

async function workspaceSceneCataloguePostgresTest(): Promise<void> {
  const sources = ['scripts/workspace-scene-catalogue-postgres-test.ts',
    'scripts/helpers/native-copy-metadata-owner-fixture.ts', 'app/lib/collaboration/workspace-scene-catalogue.ts',
    'app/lib/db/postgres.ts', 'app/lib/db/schema.ts'];
  const pins = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(file))])));
  console.log(JSON.stringify({ suite: 'workspace-scene-catalogue-postgres', sourcePins: pins }));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { readWorkspaceSceneCatalogue: catalogue, WorkspaceSceneCatalogueError } =
      await import('../app/lib/collaboration/workspace-scene-catalogue');
    type Options = NonNullable<Parameters<typeof catalogue>[2]>;
    type Entry = Awaited<ReturnType<typeof catalogue>>[number];
    type Seed = { id: string; lineage: string; path: string; workspace: WorkspaceContext };
    const seeds: Seed[] = [];
    const group = async (name: string, operation: () => Promise<void>) => {
      currentCase = name; await operation(); groups++;
      console.log(`PASS workspace-scene-catalogue ${groups}: ${name}`);
    };
    const seed = async (relative: string, options: { workspace?: WorkspaceContext; registry?: boolean;
      state?: boolean; lineage?: boolean } = {}): Promise<Seed> => {
      const workspace = options.workspace ?? h.source;
      const value = { id: `scene-${crypto.randomUUID()}`, lineage: `lineage-${crypto.randomUUID()}`, path: relative, workspace };
      seeds.push(value);
      if (options.lineage !== false) await h.admin.query(`INSERT INTO file_collaboration_lineages
        (id,organization_id,workspace_id,workspace_type,path,status,created_at,archived_at,trash_entry_id)
        VALUES($1,$2,$3,$4,$5,'active',100,NULL,NULL)`,
      [value.lineage, workspace.organizationId ?? null, workspace.workspaceId, workspace.workspaceType, relative]);
      if (options.registry !== false) await h.admin.query(`INSERT INTO collaboration_documents
        (id,lineage_id,organization_id,workspace_id,workspace_type,path,provider,state_version,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'excalidraw',2,'active',100,100)`,
      [value.id, options.lineage === false ? null : value.lineage, workspace.organizationId ?? null,
        workspace.workspaceId, workspace.workspaceType, relative]);
      if (options.state !== false) await h.admin.query(`INSERT INTO collaboration_excalidraw_states
        (document_id,workspace_id,organization_id,path,lifecycle_generation,excalidraw_version,scene_schema_version,
          elements_json,shared_app_state_json,assets_json,scene_sequence,checkpoint_sequence,canonical_hash,persisted_at,status)
        VALUES($1,$2,$3,$4,3,'0.18.1',1,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb,7,4,$5,100,'active')`,
      [value.id, workspace.workspaceId, workspace.organizationId ?? null, relative, 'a'.repeat(64)]);
      return value;
    };
    // The caller starts/ends the real transaction. Every catalogue statement
    // reaches PostgreSQL unchanged; only protocol int8 decoding is selected.
    const read = async (workspace = h.source, options: Options = {}, decimalInt8 = false): Promise<Entry[]> => {
      await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const settings = (await h.admin.query(`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('transaction_isolation') AS isolation, txid_current_if_assigned()::text AS xid`)).rows[0];
        assert.deepEqual(settings, { readonly: 'on', isolation: 'repeatable read', xid: null });
        let statements = 0;
        const query = async (sql: string, values?: unknown[]) => {
          statements++;
          assert.match(sql, /^\s*SELECT\b/iu, 'The catalogue only reads from its caller-owned connection.');
          assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET|CREATE|DROP|ALTER|TRUNCATE|pg_advisory\w*|pg_current_xact_id)\b/iu);
          assert.match(sql, /\bcollaboration_(?:documents|excalidraw_states)\b/iu, 'Unexpected catalogue query.');
          assert.doesNotMatch(sql, /\bSELECT\s+(?:\w+\.)?\*/iu, 'Whole-row scene reads are forbidden.');
          const result = decimalInt8 ? await h.admin.query({ text: sql, values,
            types: { getTypeParser: (oid: number) => oid === 20 ? (value: string) => value : postgresTypes.getTypeParser(oid) } })
            : await h.admin.query(sql, values);
          for (const row of result.rows) for (const [key, value] of Object.entries(row)) {
            assert.doesNotMatch(key, /(?:elements|assets|shared_app_state)_json/u, 'JSON bodies must not cross the catalogue query boundary.');
            if (typeof value === 'string') assert(!value.includes('SCENE_CATALOGUE_BODY_SENTINEL'));
          }
          return result.rows;
        };
        const connection: SqlConnection = { get: async (sql, values) => (await query(sql, values))[0], all: query,
          run: () => assert.fail('Catalogue attempted run().'), close: () => assert.fail('Catalogue closed its caller-owned connection.') };
        const result = await catalogue(connection, workspace, options);
        assert.equal(statements, options.paths?.length === 0 ? 0 : 1, 'All headers must share one bounded SQL snapshot.');
        assert.equal((await h.admin.query('SELECT txid_current_if_assigned()::text AS xid')).rows[0].xid, null);
        return result;
      } finally { await h.admin.query('ROLLBACK'); }
    };
    const unsafe = (code: 'identity-conflict' | 'orphan-state', documentId: string) => (error: unknown) => {
      assert(error instanceof WorkspaceSceneCatalogueError); assert.equal(error.status, 409);
      assert.equal(error.code, code); assert.equal(error.documentId, documentId); return true;
    };
    const unchangedDatabase = async (): Promise<Record<string, string>> => {
      const tables = (await h.admin.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename`, [h.schema])).rows;
      const hashes: Record<string, string> = {};
      for (const { tablename } of tables) {
        assert.match(tablename, /^[a-z][a-z0-9_]*$/u);
        const result = await h.admin.query(`SELECT md5(COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)
          ORDER BY to_jsonb(t)::text)::text,'[]')) AS digest FROM "${h.schema}"."${tablename}" t`);
        hashes[tablename] = result.rows[0].digest;
      }
      return hashes;
    };
    try {
      await group('initialized and missing-state registry entries are facts without projection or bootstrap', async () => {
        const ready = await seed('headers/ready.excalidraw'), missing = await seed('headers/missing.excalidraw', { state: false });
        await h.admin.query('UPDATE collaboration_documents SET state_version=0 WHERE id=$1', [missing.id]);
        const entries = await read(h.source, { paths: ['headers'] });
        assert.deepEqual(entries.map(entry => entry.id), [missing.id, ready.id]);
        for (const options of [{}, { paths: ['.'] }, { paths: [''] }]) assert.deepEqual(await read(h.source, options), entries);
        const initialized = entries.find(entry => entry.id === ready.id)!;
        assert.equal(initialized.authority, 'initialized'); assert.equal(initialized.has_persisted_state, true);
        assert.equal(initialized.lineage_row_id, ready.lineage); assert.equal(initialized.lifecycle_generation, 3);
        assert.equal(initialized.scene_sequence, 7); assert.equal(initialized.checkpoint_sequence, 4);
        assert.equal(initialized.state_version, 2); assert.equal(initialized.scene_schema_version, 1);
        assert.equal(initialized.elements_bytes, 2); assert.equal(initialized.shared_app_state_bytes, 2); assert.equal(initialized.assets_bytes, 2);
        const absent = entries.find(entry => entry.id === missing.id)!;
        assert.equal(absent.authority, 'missing-state'); assert.equal(absent.has_persisted_state, false);
        for (const key of ['state_document_id', 'state_path', 'state_workspace_id', 'state_organization_id', 'state_status',
          'lifecycle_generation', 'scene_schema_version', 'excalidraw_version', 'scene_sequence', 'checkpoint_sequence',
          'canonical_hash', 'elements_bytes', 'shared_app_state_bytes', 'assets_bytes'] as const) assert.equal(absent[key], null, key);
        await assert.rejects(lstat(path.join(h.source.rootPath, ready.path)), { code: 'ENOENT' });
        await assert.rejects(lstat(path.join(h.source.rootPath, missing.path)), { code: 'ENOENT' });
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_states WHERE document_id=$1', [missing.id])).rows[0].n, 0);
      });
      await group('active orphan, archived/wrong-provider registry and state identity conflicts are rejected', async () => {
        const orphan = await seed('orphan/none.excalidraw', { registry: false, lineage: false });
        await assert.rejects(read(h.source, { paths: [orphan.path] }), unsafe('orphan-state', orphan.id));
        const faults = [
          ['registry-archived', "UPDATE collaboration_documents SET status='archived' WHERE id=$1"],
          ['registry-provider', "UPDATE collaboration_documents SET provider='yjs' WHERE id=$1"],
          ['registry-workspace', 'UPDATE collaboration_documents SET workspace_id=$2 WHERE id=$1'],
          ['registry-type', "UPDATE collaboration_documents SET workspace_type='personal' WHERE id=$1"],
          ['registry-organization', "UPDATE collaboration_documents SET organization_id='foreign-org' WHERE id=$1"],
          ['state-path', "UPDATE collaboration_excalidraw_states SET path='different/path.excalidraw' WHERE document_id=$1"],
          ['state-workspace', 'UPDATE collaboration_excalidraw_states SET workspace_id=$2 WHERE document_id=$1'],
          ['state-organization', "UPDATE collaboration_excalidraw_states SET organization_id='foreign-org' WHERE document_id=$1"],
        ] as const;
        for (const [name, sql] of faults) {
          const value = await seed(`identity/${name}.excalidraw`);
          await h.admin.query(sql, name === 'state-workspace' || name === 'registry-workspace' ? [value.id, h.destination.workspaceId] : [value.id]);
          await assert.rejects(read(h.source, { paths: [value.path] }), unsafe('orphan-state', value.id));
        }
        const archived = await seed('identity/state-archived.excalidraw');
        await h.admin.query("UPDATE collaboration_excalidraw_states SET status='archived' WHERE document_id=$1", [archived.id]);
        await assert.rejects(read(h.source, { paths: [archived.path] }), unsafe('identity-conflict', archived.id));
        const inactive = await seed('identity/fully-archived.excalidraw');
        await h.admin.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [inactive.id]);
        await h.admin.query("UPDATE collaboration_excalidraw_states SET status='archived' WHERE document_id=$1", [inactive.id]);
        assert.deepEqual(await read(h.source, { paths: [inactive.path] }), []);
      });
      await group('lineage is mandatory, active and bound to exact registry workspace/path/org/type', async () => {
        const missing = await seed('lineage/missing.excalidraw', { lineage: false });
        await assert.rejects(read(h.source, { paths: [missing.path] }), unsafe('identity-conflict', missing.id));
        const faults = [
          ['dangling', "UPDATE collaboration_documents SET lineage_id='absent-lineage' WHERE id=$1", 'document'],
          ['path', "UPDATE file_collaboration_lineages SET path='foreign-lineage.excalidraw' WHERE id=$1", 'lineage'],
          ['workspace', 'UPDATE file_collaboration_lineages SET workspace_id=$2 WHERE id=$1', 'lineage'],
          ['organization', "UPDATE file_collaboration_lineages SET organization_id='foreign-org' WHERE id=$1", 'lineage'],
          ['type', "UPDATE file_collaboration_lineages SET workspace_type='personal' WHERE id=$1", 'lineage'],
          ['archived', "UPDATE file_collaboration_lineages SET status='archived',archived_at=101 WHERE id=$1", 'lineage'],
        ] as const;
        for (const [name, sql, target] of faults) {
          const value = await seed(`lineage/${name}.excalidraw`), id = target === 'document' ? value.id : value.lineage;
          await h.admin.query(sql, name === 'workspace' ? [id, h.destination.workspaceId] : [id]);
          await assert.rejects(read(h.source, { paths: [value.path] }), unsafe('identity-conflict', value.id));
        }
        // Nullable legacy scopes and valid historical trash IDs are separate
        // from the exact lineage identity checks above.
        const value = await seed('scopes/declared.excalidraw');
        const declared = { ...h.source, customerId: 'catalogue-customer', projectId: 'catalogue-project' };
        // The catalogue consumes context facts; this controlled context is not
        // a claim that the stored workspace or current principal has this scope.
        let [entry] = await read(declared, { paths: [value.path] });
        assert.equal(entry.customer_id, null); assert.equal(entry.lineage_customer_id, null);
        assert.equal(entry.project_id, null); assert.equal(entry.lineage_project_id, null);
        await h.admin.query('UPDATE collaboration_documents SET customer_id=$2,project_id=$3 WHERE id=$1',
          [value.id, declared.customerId, declared.projectId]);
        await h.admin.query('UPDATE file_collaboration_lineages SET customer_id=$2,project_id=$3,trash_entry_id=$4 WHERE id=$1',
          [value.lineage, declared.customerId, declared.projectId, 'legacy-valid-trash']);
        [entry] = await read(declared, { paths: [value.path] });
        assert.equal(entry.customer_id, declared.customerId); assert.equal(entry.lineage_customer_id, declared.customerId);
        assert.equal(entry.project_id, declared.projectId); assert.equal(entry.lineage_project_id, declared.projectId);
        assert.equal(entry.lineage_trash_entry_id, 'legacy-valid-trash');
        for (const [table, id, field, original] of [
          ['collaboration_documents', value.id, 'customer_id', declared.customerId],
          ['collaboration_documents', value.id, 'project_id', declared.projectId],
          ['file_collaboration_lineages', value.lineage, 'customer_id', declared.customerId],
          ['file_collaboration_lineages', value.lineage, 'project_id', declared.projectId],
          ['file_collaboration_lineages', value.lineage, 'trash_entry_id', 'legacy-valid-trash'],
        ] as const) {
          for (const invalid of field === 'trash_entry_id' ? ['', 'bad\ntrash'] : ['foreign-scope', '']) {
            await h.admin.query(`UPDATE ${table} SET ${field}=$2 WHERE id=$1`, [id, invalid]);
            await assert.rejects(read(declared, { paths: [value.path] }), unsafe('identity-conflict', value.id));
            await h.admin.query(`UPDATE ${table} SET ${field}=$2 WHERE id=$1`, [id, original]);
          }
        }
        await assert.rejects(read(h.source, { paths: [value.path] }), unsafe('identity-conflict', value.id));
      });
      await group('literal scopes, descendants, foreign suffixes and cross-workspace isolation', async () => {
        const exact = await seed('scope/a_b%/drawing.bin'), descendant = await seed('scope/a_b%/nested/note.md');
        await seed('scope/axbZ/bleed.excalidraw'); await seed('scope/a_b%sibling/bleed.excalidraw');
        const sameForeign = await seed(exact.path, { workspace: h.destination });
        await seed('scope/a_b%/foreign-orphan.excalidraw', { workspace: h.destination, registry: false, lineage: false });
        assert.deepEqual((await read(h.source, { paths: ['scope/a_b%'] })).map(entry => entry.id), [exact.id, descendant.id]);
        assert.deepEqual((await read(h.source, { paths: [exact.path] })).map(entry => entry.id), [exact.id]);
        assert.deepEqual((await read(h.destination, { paths: [sameForeign.path] })).map(entry => entry.id), [sameForeign.id]);
        assert.deepEqual(await read(h.source, { paths: [] }), []);
        assert.deepEqual(await read(h.source, { paths: ['scope/missing'] }), []);
        const conflicting = await seed('scope/provider-conflict.excalidraw');
        const otherId = `other-provider-${crypto.randomUUID()}`;
        await h.admin.query(`INSERT INTO collaboration_documents
          (id,organization_id,workspace_id,workspace_type,path,provider,state_version,status,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,'yjs',0,'active',100,100)`,
        [otherId, h.source.organizationId ?? null, h.source.workspaceId, h.source.workspaceType, conflicting.path]);
        try { await assert.rejects(read(h.source, { paths: [conflicting.path] }), unsafe('identity-conflict', conflicting.id)); }
        finally { await h.admin.query('DELETE FROM collaboration_documents WHERE id=$1', [otherId]); }
      });
      await group('scope follows either state or registry even across changed path/workspace', async () => {
        const moved = await seed('outside-registry/original.excalidraw');
        await h.admin.query("UPDATE collaboration_excalidraw_states SET path='state-scope/changed.excalidraw' WHERE document_id=$1", [moved.id]);
        await assert.rejects(read(h.source, { paths: ['state-scope'] }), unsafe('orphan-state', moved.id));
        const foreignRegistry = await seed('foreign-registry/outside.excalidraw', { workspace: h.destination });
        await h.admin.query("UPDATE collaboration_excalidraw_states SET workspace_id=$2,path='state-scope/foreign-registry.excalidraw' WHERE document_id=$1",
          [foreignRegistry.id, h.source.workspaceId]);
        await assert.rejects(read(h.source, { paths: ['state-scope/foreign-registry.excalidraw'] }), unsafe('orphan-state', foreignRegistry.id));
        await assert.rejects(read(h.destination, { paths: [foreignRegistry.path] }), unsafe('orphan-state', foreignRegistry.id));
      });
      await group('truthful maximum and malformed options or inaccessible workspaces before SQL', async () => {
        await seed('limit/one.excalidraw'); await seed('limit/two.excalidraw');
        assert.equal((await read(h.source, { paths: ['limit'], maxEntries: 2 })).length, 2);
        await assert.rejects(read(h.source, { paths: ['limit'], maxEntries: 1 }), (error: unknown) =>
          errorCode(error) === 'SCENE_CATALOGUE_TOO_LARGE' && Reflect.get(error as object, 'status') === 413);
        let statements = 0;
        const noSql: SqlConnection = { get: () => { statements++; assert.fail('Invalid request reached SQL.'); },
          all: () => { statements++; assert.fail('Invalid request reached SQL.'); },
          run: () => assert.fail('Invalid request attempted run().'), close: () => assert.fail('Invalid request closed the caller connection.') };
        for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001, '2', null]) {
          await assert.rejects(catalogue(noSql, h.source, { maxEntries: value } as Options));
        }
        for (const value of ['/absolute', '../escape', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'a\0b', 'trailing/']) {
          await assert.rejects(catalogue(noSql, h.source, { paths: [value] }));
        }
        for (const options of [null, [], 'paths', new Date(0), Object.create(null), { paths: 'limit' }, { paths: [null] }, { paths: [5] },
          { paths: Array(2) }, { paths: Array(10_001).fill('limit') }]) {
          await assert.rejects(catalogue(noSql, h.source, options as Options));
        }
        for (const workspace of [{ ...h.source, permissions: { ...h.source.permissions, canRead: false } },
          { ...h.source, status: 'archived' } as WorkspaceContext]) {
          await assert.rejects(catalogue(noSql, workspace), (error: unknown) => Reflect.get(error as object, 'status') === 403);
        }
        assert.equal(statements, 0);
      });
      await group('actual PostgreSQL int8 decimal protocol and safe integer boundaries', async () => {
        const value = await seed('integers/scene.excalidraw');
        await h.admin.query(`UPDATE collaboration_documents SET state_version=9007199254740991 WHERE id=$1`, [value.id]);
        await h.admin.query(`UPDATE collaboration_excalidraw_states SET lifecycle_generation=9007199254740991,
          scene_sequence=9007199254740991,checkpoint_sequence=9007199254740990 WHERE document_id=$1`, [value.id]);
        const [entry] = await read(h.source, { paths: [value.path] }, true);
        assert.equal(entry.state_version, Number.MAX_SAFE_INTEGER); assert.equal(entry.lifecycle_generation, Number.MAX_SAFE_INTEGER);
        assert.equal(entry.scene_sequence, Number.MAX_SAFE_INTEGER); assert.equal(entry.checkpoint_sequence, Number.MAX_SAFE_INTEGER - 1);
        for (const field of ['lifecycle_generation', 'scene_schema_version', 'scene_sequence', 'checkpoint_sequence'] as const) {
          const original = (await h.admin.query(`SELECT ${field}::text AS value FROM collaboration_excalidraw_states WHERE document_id=$1`, [value.id])).rows[0].value;
          await h.admin.query(`UPDATE collaboration_excalidraw_states SET ${field}=9007199254740992 WHERE document_id=$1`, [value.id]);
          await assert.rejects(read(h.source, { paths: [value.path] }, true), unsafe('identity-conflict', value.id));
          await h.admin.query(`UPDATE collaboration_excalidraw_states SET ${field}=$2 WHERE document_id=$1`, [value.id, original]);
        }
        for (const [field, invalid] of [['lifecycle_generation', 0], ['scene_schema_version', 0],
          ['scene_sequence', -1], ['checkpoint_sequence', -1]] as const) {
          const original = (await h.admin.query(`SELECT ${field}::text AS value FROM collaboration_excalidraw_states WHERE document_id=$1`, [value.id])).rows[0].value;
          await h.admin.query(`UPDATE collaboration_excalidraw_states SET ${field}=$2 WHERE document_id=$1`, [value.id, invalid]);
          await assert.rejects(read(h.source, { paths: [value.path] }, true), unsafe('identity-conflict', value.id));
          await h.admin.query(`UPDATE collaboration_excalidraw_states SET ${field}=$2 WHERE document_id=$1`, [value.id, original]);
        }
        await h.admin.query('UPDATE collaboration_documents SET state_version=9007199254740992 WHERE id=$1', [value.id]);
        await assert.rejects(read(h.source, { paths: [value.path] }, true), unsafe('identity-conflict', value.id));
        await h.admin.query('UPDATE collaboration_documents SET state_version=0 WHERE id=$1', [value.id]);
        await h.admin.query('UPDATE collaboration_excalidraw_states SET scene_sequence=0,checkpoint_sequence=0 WHERE document_id=$1', [value.id]);
        assert.equal((await read(h.source, { paths: [value.path] }, true))[0].scene_sequence, 0);
        await h.admin.query('UPDATE collaboration_excalidraw_states SET scene_sequence=10,checkpoint_sequence=11 WHERE document_id=$1', [value.id]);
        await assert.rejects(read(h.source, { paths: [value.path] }, true), unsafe('identity-conflict', value.id));
      });
      await group('large JSON is measured in SQL; repeated caller-owned RO reads leave every row and file unchanged', async () => {
        const value = await seed('large/scene.excalidraw');
        const sentinel = `SCENE_CATALOGUE_BODY_SENTINEL-${'x'.repeat(1024 * 1024)}`;
        await h.admin.query(`UPDATE collaboration_excalidraw_states SET elements_json=$2::jsonb,
          shared_app_state_json=$3::jsonb,assets_json=$4::jsonb WHERE document_id=$1`,
        [value.id, JSON.stringify([{ text: sentinel }]), JSON.stringify({ text: sentinel }), JSON.stringify([{ text: sentinel }])]);
        const assetId = `header-asset-${crypto.randomUUID()}`;
        await h.admin.query(`INSERT INTO collaboration_excalidraw_assets
          (workspace_id,file_id,content_sha256,mime_type,size_bytes,storage_key,version,status,created_at,last_referenced_at)
          VALUES($1,$2,$3,'image/png',1,'intentionally-not-materialized',1,'available',123,456)`,
        [h.source.workspaceId, assetId, 'b'.repeat(64)]);
        const lengths = (await h.admin.query(`SELECT octet_length(elements_json::text)::integer AS elements_bytes,
          octet_length(shared_app_state_json::text)::integer AS shared_app_state_bytes,
          octet_length(assets_json::text)::integer AS assets_bytes FROM collaboration_excalidraw_states WHERE document_id=$1`, [value.id])).rows[0];
        const beforeRows = await unchangedDatabase(), beforeFiles = await sceneCatalogueFilesystemSnapshot(h.dataRoot);
        const first = await read(h.source, { paths: [value.path] }, true), second = await read(h.source, { paths: [value.path] });
        assert.deepEqual(second, first); assert.equal(first.length, 1);
        for (const field of ['elements_bytes', 'shared_app_state_bytes', 'assets_bytes'] as const) {
          assert.equal(first[0][field], lengths[field]); assert(Number(first[0][field]) > 1024 * 1024);
        }
        assert(Buffer.byteLength(JSON.stringify(first)) < 16_384, 'The result must contain only headers, never multi-MiB bodies.');
        assert.deepEqual(await unchangedDatabase(), beforeRows, 'No bootstrap, operation, revision, asset touch or other DML.');
        assert.deepEqual(await sceneCatalogueFilesystemSnapshot(h.dataRoot), beforeFiles, 'No projection, asset write or temporary file publication.');
        assert.equal((await h.admin.query('SELECT last_referenced_at::text AS value FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=$2',
          [h.source.workspaceId, assetId])).rows[0].value, '456');
      });
    } finally {
      // These are our own explicit fixture rows only. The enclosing helper owns
      // final schema/DATA closure and verifies no private backend survives.
      for (const value of seeds.reverse()) {
        await h.admin.query('DELETE FROM collaboration_excalidraw_states WHERE document_id=$1', [value.id]);
        await h.admin.query('DELETE FROM collaboration_documents WHERE id=$1', [value.id]);
        await h.admin.query('DELETE FROM file_collaboration_lineages WHERE id=$1', [value.lineage]);
      }
    }
  });
  assert.equal(groups, 8);
  const after = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(file))])));
  assert.deepEqual(after, pins); completed = true;
  console.log(JSON.stringify({ suite: 'workspace-scene-catalogue-postgres', groups, passed: true, sourcesUnchanged: true,
    scope: 'read-only durable scene catalogue facts; no mixed file-action or authorization acceptance claimed' }));
}

void workspaceSceneCataloguePostgresTest().catch(error => {
  const safeCode = errorCode(error);
  console.error(JSON.stringify({ suite: 'workspace-scene-catalogue-postgres', case: currentCase,
    name: error instanceof Error ? error.name : 'unknown',
    code: typeof safeCode === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(safeCode) ? safeCode : null,
    frames: error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const found = /\/(app\/lib\/[a-z0-9_./-]+|scripts\/[a-z0-9_./-]+):(\d+):(\d+)\)?$/iu.exec(line);
      return found ? [`${found[1]}:${found[2]}:${found[3]}`] : [];
    }).slice(0, 5) : [] }));
  process.exitCode = 1;
});
