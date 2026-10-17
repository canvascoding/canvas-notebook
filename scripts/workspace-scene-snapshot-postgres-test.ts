import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, link, lstat, readFile, readdir, rename, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { ExcalidrawElementRecord } from '../app/lib/excalidraw-collaboration/protocol';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real private PG18/FS fixture. SQL faults are stored-data counterexamples,
// never substitute SQL results, principals, source authority or authorized I/O.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const digest = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const code = (error: unknown): unknown => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
async function snapshotTestFilesystem(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative), info = await lstat(absolute);
    result.push({ path: relative, dev: info.dev, ino: info.ino, mode: info.mode, size: info.size, nlink: info.nlink,
      mtime: info.mtimeMs, ctime: info.ctimeMs, ...(info.isFile() ? { sha256: digest(await readFile(absolute)) } : {}) });
    if (info.isDirectory()) for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
  };
  await visit(''); return result;
}

async function workspaceSceneSnapshotPostgresTest(): Promise<void> {
  const files = ['scripts/workspace-scene-snapshot-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/collaboration/workspace-scene-catalogue.ts', 'app/lib/excalidraw-collaboration/workspace-scene-snapshot.ts',
    'app/lib/excalidraw-collaboration/readonly-assets.ts', 'app/lib/db/postgres.ts', 'app/lib/db/schema.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { readWorkspaceSceneCatalogue: catalogue } = await import('../app/lib/collaboration/workspace-scene-catalogue');
    const { readWorkspaceSceneSnapshotsOnConnection: snapshots, captureWorkspaceSceneSnapshot: capture, WorkspaceSceneSnapshotError } =
      await import('../app/lib/excalidraw-collaboration/workspace-scene-snapshot');
    const { readExcalidrawAssetsOnConnection: assets, captureExcalidrawReadonlyAssetMetadata: captureMetadata, ExcalidrawReadonlyAssetError } =
      await import('../app/lib/excalidraw-collaboration/readonly-assets');
    const { storeExcalidrawAsset } = await import('../app/lib/excalidraw-collaboration/assets');
    const { ensureExcalidrawScene, applyExcalidrawScenePatch } = await import('../app/lib/excalidraw-collaboration/repository');
    const { canonicalSceneHash } = await import('../app/lib/excalidraw-collaboration/scene');
    type SceneOptions = NonNullable<Parameters<typeof snapshots>[3]>;
    type AssetOptions = NonNullable<Parameters<typeof assets>[3]>;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const rectangle = (id: string): ExcalidrawElementRecord => ({ id, type: 'rectangle', version: 1, versionNonce: 7,
      isDeleted: false, x: 0, y: 0, width: 10, height: 10, angle: 0, opacity: 100 });
    const seed = async (name: string, image = false) => {
      const id = `snapshot-${crypto.randomUUID()}`, lineage = `snapshot-lineage-${crypto.randomUUID()}`, relative = `snapshots/${name}.excalidraw`;
      const metadata = image ? [await storeExcalidrawAsset({ workspaceId: h.source.workspaceId,
        fileId: `image-${crypto.randomUUID()}`, mimeType: 'image/png', data: png, version: 2, createdAt: 123 })] : [];
      await h.admin.query(`INSERT INTO file_collaboration_lineages(id,organization_id,workspace_id,workspace_type,path,status,created_at)
        VALUES($1,$2,$3,$4,$5,'active',100)`, [lineage, h.source.organizationId ?? null, h.source.workspaceId, h.source.workspaceType, relative]);
      await h.admin.query(`INSERT INTO collaboration_documents(id,lineage_id,organization_id,workspace_id,workspace_type,path,provider,state_version,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'excalidraw',0,'active',100,100)`,
      [id, lineage, h.source.organizationId ?? null, h.source.workspaceId, h.source.workspaceType, relative]);
      const elements = image ? [{ ...rectangle('image'), type: 'image', fileId: metadata[0].fileId }] : [];
      const scene = await ensureExcalidrawScene({ documentId: id, workspaceId: h.source.workspaceId,
        organizationId: h.source.organizationId ?? null, path: relative,
        initialContent: JSON.stringify({ type: 'excalidraw', elements, appState: { viewBackgroundColor: '#ffffff' } }), initialAssets: metadata });
      const blob = image ? path.join(h.dataRoot, 'collaboration-assets', 'excalidraw',
        digest(h.source.workspaceId).slice(0, 32), metadata[0].contentHash) : null;
      return { id, lineage, path: relative, scene, metadata, blob };
    };
    type Seed = Awaited<ReturnType<typeof seed>>;
    const read = async <T>(operation: (connection: SqlConnection) => Promise<T>, hook?: (sql: string) => Promise<void>): Promise<T> => {
      await h.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const state = (await h.admin.query(`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('transaction_isolation') AS isolation,txid_current_if_assigned()::text AS xid`)).rows[0];
        assert.deepEqual(state, { readonly: 'on', isolation: 'repeatable read', xid: null });
        const query = async (sql: string, values?: unknown[]) => {
          assert.match(sql, /^\s*SELECT\b/iu); assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET|CREATE|ALTER|DROP|pg_advisory\w*|pg_current_xact_id)\b/iu);
          const result = await h.admin.query(sql, values); await hook?.(sql); return result.rows;
        };
        const connection: SqlConnection = { get: async (sql, values) => (await query(sql, values))[0], all: query,
          run: () => assert.fail('Readonly reader attempted run().'), close: () => assert.fail('Readonly reader closed the caller connection.') };
        const result = await operation(connection);
        assert.equal((await h.admin.query('SELECT txid_current_if_assigned()::text AS xid')).rows[0].xid, null); return result;
      } finally { await h.admin.query('ROLLBACK'); }
    };
    const headers = (value: Seed) => read(connection => catalogue(connection, h.source, { paths: [value.path] }));
    const load = (value: Seed, options?: SceneOptions) => read(async connection => snapshots(connection, h.source,
      await catalogue(connection, h.source, { paths: [value.path] }), options));
    const sceneFailure = (error: unknown) => error instanceof WorkspaceSceneSnapshotError
      && ['SCENE_SNAPSHOT_INVALID', 'SCENE_SNAPSHOT_CHANGED'].includes(error.code) && error.status === 409;
    const assetFailure = (error: unknown) => error instanceof ExcalidrawReadonlyAssetError
      && ['EXCALIDRAW_ASSET_SOURCE_INVALID', 'EXCALIDRAW_ASSET_SOURCE_CHANGED'].includes(error.code) && error.status === 409;
    const group = async (name: string, operation: () => Promise<void>) => { currentCase = name; await operation(); groups++;
      console.log(`PASS workspace-scene-snapshot ${groups}: ${name}`); };
    const tableHashes = async () => {
      const result: Record<string, string> = {};
      for (const { tablename } of (await h.admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [h.schema])).rows) {
        assert.match(tablename, /^[a-z][a-z0-9_]*$/u);
        result[tablename] = (await h.admin.query(`SELECT md5(COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)
          ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${h.schema}"."${tablename}" t`)).rows[0].hash;
      }
      return result;
    };
    await group('canonical empty/image scenes have detached proofs and verified bytes without projections', async () => {
      for (const image of [false, true]) {
        const value = await seed(`valid-${image}`, image), [record] = await load(value);
        assert.equal(record.version, 1); assert.equal(record.header.id, value.id); assert.equal(record.scene.documentId, value.id);
        assert.equal(record.scene.canonicalHash, canonicalSceneHash(record.scene)); assert.match(record.contentProof, /^[a-f0-9]{64}$/u);
        const detached = capture(record); assert.notEqual(detached, record); assert.deepEqual(detached, record);
        assert(Object.isFrozen(detached)); assert(Object.isFrozen(detached.scene)); assert(Object.isFrozen(detached.scene.elements));
        const binaries = await read(connection => assets(connection, h.source.workspaceId, record.scene.assets));
        assert.equal(binaries.length, Number(image));
        if (image) { assert.deepEqual(Buffer.from(binaries[0].bytes), png); assert.deepEqual(binaries[0].metadata, value.metadata[0]);
          assert.match(binaries[0].contentProof, /^[a-f0-9]{64}$/u); assert.equal(binaries[0].storageIdentity.sizeBytes, png.length); }
        await assert.rejects(lstat(path.join(h.source.rootPath, value.path)), { code: 'ENOENT' });
        assert.throws(() => capture({ ...record, contentProof: '0'.repeat(64) }), sceneFailure);
      }
    });
    await group('header budgets and malformed options reject before body or blob fetch', async () => {
      const value = await seed('budget', true), captured = await headers(value);
      const denySql: SqlConnection = { get: () => assert.fail('Budget/option failure fetched SQL.'), all: () => assert.fail('Budget/option failure fetched SQL.'),
        run: () => assert.fail('Unexpected write.'), close: () => assert.fail('Unexpected close.') };
      let traps = 0, mapCalls = 0, indexGetterCalls = 0, optionGetterCalls = 0;
      const trapped = (): never => { traps++; throw new Error('A rejected decoder invoked a Proxy trap.'); };
      const handler = { get: trapped, getPrototypeOf: trapped, ownKeys: trapped,
        getOwnPropertyDescriptor: trapped, has: trapped };
      const metadataProxy = new Proxy(value.metadata[0], handler);
      const revokedMetadata = Proxy.revocable(value.metadata[0], handler); revokedMetadata.revoke();
      for (const candidate of [metadataProxy, revokedMetadata.proxy]) {
        assert.throws(() => captureMetadata(candidate), assetFailure);
        await assert.rejects(assets(denySql, h.source.workspaceId, [candidate]), assetFailure);
      }
      const ownMap = [...value.metadata];
      Object.defineProperty(ownMap, 'map', { value: () => { mapCalls++; return []; } });
      await assert.rejects(assets(denySql, h.source.workspaceId, ownMap), assetFailure);
      const indexed = Array(1);
      Object.defineProperty(indexed, '0', { enumerable: true, get: () => { indexGetterCalls++; return value.metadata[0]; } });
      const arrayProxy = new Proxy([...value.metadata], handler);
      const revokedArray = Proxy.revocable([...value.metadata], handler); revokedArray.revoke();
      for (const candidate of [indexed, Array(1), arrayProxy, revokedArray.proxy]) {
        await assert.rejects(assets(denySql, h.source.workspaceId, candidate), assetFailure);
      }
      const getterOptions = Object.defineProperty({}, 'maxTotalBytes', {
        enumerable: true, get: () => { optionGetterCalls++; return png.length; } });
      const optionProxy = new Proxy({ maxTotalBytes: png.length }, handler);
      const revokedOptions = Proxy.revocable({ maxTotalBytes: png.length }, handler); revokedOptions.revoke();
      for (const options of [getterOptions, optionProxy, revokedOptions.proxy]) {
        await assert.rejects(assets(denySql, h.source.workspaceId, value.metadata, options), assetFailure);
      }
      assert.deepEqual({ traps, mapCalls, indexGetterCalls, optionGetterCalls },
        { traps: 0, mapCalls: 0, indexGetterCalls: 0, optionGetterCalls: 0 });
      for (const options of [{ maxSceneBytes: 1 }, { maxTotalBytes: 1 }]) await assert.rejects(
        snapshots(denySql, h.source, captured, options), (error: unknown) => code(error) === 'SCENE_SNAPSHOT_TOO_LARGE');
      const second = await seed('budget-second'), total = captured.reduce((sum, header) => sum
        + Number(header.elements_bytes) + Number(header.shared_app_state_bytes) + Number(header.assets_bytes), 0);
      await assert.rejects(snapshots(denySql, h.source, [...captured, ...await headers(second)], { maxTotalBytes: total }),
        (error: unknown) => code(error) === 'SCENE_SNAPSHOT_TOO_LARGE');
      for (const options of [null, [], { maxSceneBytes: 0 }, { maxSceneBytes: -1 }, { maxSceneBytes: 50 * 1024 * 1024 + 1 },
        { maxTotalBytes: 128 * 1024 * 1024 + 1 }, { maxTotalBytes: Number.NaN }]) {
        await assert.rejects(snapshots(denySql, h.source, captured, options as SceneOptions), sceneFailure);
      }
      await assert.rejects(assets(denySql, h.source.workspaceId, value.metadata, { maxTotalBytes: 0 }),
        (error: unknown) => code(error) === 'EXCALIDRAW_ASSET_BUDGET_EXCEEDED');
      await assert.rejects(assets(denySql, h.source.workspaceId, [{ ...value.metadata[0], sizeBytes: 20 * 1024 * 1024 + 1 }]),
        (error: unknown) => code(error) === 'EXCALIDRAW_ASSET_BUDGET_EXCEEDED');
      for (const options of [{ maxTotalBytes: -1 }, { maxTotalBytes: 50 * 1024 * 1024 + 1 }, { maxTotalBytes: Number.NaN }]) {
        await assert.rejects(assets(denySql, h.source.workspaceId, value.metadata, options as AssetOptions), assetFailure);
      }
      const missing = await seed('missing'); await h.admin.query('DELETE FROM collaboration_excalidraw_states WHERE document_id=$1', [missing.id]);
      await assert.rejects(snapshots(denySql, h.source, await headers(missing)), sceneFailure);
    });
    await group('a legitimate newer scene refuses old captured headers and old proof remains detached', async () => {
      const value = await seed('stale'), captured = await headers(value), [original] = await load(value);
      await applyExcalidrawScenePatch({ documentId: value.id, lifecycleGeneration: value.scene.lifecycleGeneration,
        baseSequence: value.scene.sceneSequence, messageId: crypto.randomUUID(),
        elements: [{ ...rectangle('later'), type: 'text', text: 'äö — 日本 🦊' }], actorType: 'user', actorId: 'owner' });
      await assert.rejects(read(connection => snapshots(connection, h.source, captured)),
        (error: unknown) => code(error) === 'SCENE_SNAPSHOT_CHANGED');
      const [current] = await load(value); assert.equal(current.scene.elements[0].id, 'later');
      assert.equal(current.scene.elements[0].text, 'äö — 日本 🦊');
      assert.equal(original.scene.elements.length, 0); assert.notEqual(current.contentProof, original.contentProof);
    });
    await group('raw JSON, hashes, schema integers and references never use forgiving fallback', async () => {
      const value = await seed('faults', true);
      const original = (await h.admin.query('SELECT elements_json,shared_app_state_json,assets_json,canonical_hash,scene_schema_version FROM collaboration_excalidraw_states WHERE document_id=$1', [value.id])).rows[0];
      const faults: Array<[string, unknown]> = [['elements_json', null], ['elements_json', {}], ['shared_app_state_json', []],
        ['assets_json', {}], ['shared_app_state_json', { viewBackgroundColor: '#ffffff', selectedElementIds: {} }],
        ['elements_json', [{ ...rectangle('bad'), version: 0 }]],
        ['elements_json', [rectangle('same'), rectangle('same')]],
        ['elements_json', [{ ...rectangle('bad-reference'), containerId: 'absent' }]],
        ['elements_json', [{ ...rectangle('bad-image'), type: 'image', fileId: 'absent-asset' }]],
        ['assets_json', [value.metadata[0], value.metadata[0]]], ['assets_json', [{ ...value.metadata[0], sizeBytes: '1' }]],
        ['canonical_hash', '0'.repeat(64)], ['scene_schema_version', 2]];
      for (const [field, invalid] of faults) {
        const json = field.endsWith('_json');
        await h.admin.query(`UPDATE collaboration_excalidraw_states SET ${field}=$2${json ? '::jsonb' : ''} WHERE document_id=$1`,
          [value.id, json ? JSON.stringify(invalid) : invalid]);
        try { await assert.rejects(load(value), sceneFailure); }
        finally { await h.admin.query(`UPDATE collaboration_excalidraw_states SET ${field}=$2${json ? '::jsonb' : ''} WHERE document_id=$1`,
          [value.id, json ? JSON.stringify(original[field]) : original[field]]); }
      }
      const captured = await headers(value);
      await h.admin.query('UPDATE collaboration_excalidraw_states SET scene_schema_version=9007199254740992 WHERE document_id=$1', [value.id]);
      try { await assert.rejects(read(connection => snapshots(connection, h.source, captured)), sceneFailure); }
      finally { await h.admin.query('UPDATE collaboration_excalidraw_states SET scene_schema_version=$2 WHERE document_id=$1', [value.id, original.scene_schema_version]); }
    });
    await group('asset metadata/status and cross-workspace bindings are exact facts', async () => {
      const value = await seed('metadata', true), id = value.metadata[0].fileId;
      const original = (await h.admin.query('SELECT * FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=$2', [h.source.workspaceId, id])).rows[0];
      for (const [field, invalid] of [['version', 99], ['created_at', 124], ['mime_type', 'image/jpeg'], ['size_bytes', png.length + 1],
        ['content_sha256', '0'.repeat(64)], ['status', 'quarantined'], ['workspace_id', h.destination.workspaceId]] as const) {
        await h.admin.query(`UPDATE collaboration_excalidraw_assets SET ${field}=$3 WHERE workspace_id=$1 AND file_id=$2`, [h.source.workspaceId, id, invalid]);
        try { await assert.rejects(read(connection => assets(connection, h.source.workspaceId, value.metadata)), assetFailure); }
        finally { await h.admin.query(`UPDATE collaboration_excalidraw_assets SET ${field}=$2 WHERE file_id=$1`, [id, original[field]]); }
      }
      const foreign = await storeExcalidrawAsset({ workspaceId: h.destination.workspaceId, fileId: `foreign-${crypto.randomUUID()}`, mimeType: 'image/png', data: png });
      await h.admin.query('UPDATE collaboration_excalidraw_assets SET storage_key=$3 WHERE workspace_id=$1 AND file_id=$2',
        [h.source.workspaceId, id, `${digest(h.destination.workspaceId).slice(0, 32)}/${foreign.contentHash}`]);
      try { await assert.rejects(read(connection => assets(connection, h.source.workspaceId, value.metadata)), assetFailure); }
      finally { await h.admin.query('UPDATE collaboration_excalidraw_assets SET storage_key=$3 WHERE workspace_id=$1 AND file_id=$2', [h.source.workspaceId, id, original.storage_key]); }
    });
    await group('missing, symlinked, hardlinked or unsafe-mode blobs cannot become read receipts', async () => {
      const value = await seed('paths', true), blob = value.blob!, saved = `${blob}.fixture-owned-backup`;
      const attempt = () => read(connection => assets(connection, h.source.workspaceId, value.metadata));
      await rename(blob, saved);
      try { await assert.rejects(attempt(), assetFailure); await symlink(saved, blob); await assert.rejects(attempt(), assetFailure); await unlink(blob); }
      finally { await rename(saved, blob); }
      await link(blob, saved);
      try { await assert.rejects(attempt(), assetFailure); } finally { await unlink(saved); }
      await chmod(blob, 0o644);
      try { await assert.rejects(attempt(), assetFailure); } finally { await chmod(blob, 0o600); }
      const directory = path.dirname(blob), savedDirectory = `${directory}.fixture-owned-backup`;
      await rename(directory, savedDirectory);
      let createdLink = false;
      try { await symlink(savedDirectory, directory); createdLink = true; await assert.rejects(attempt(), assetFailure); }
      finally { if (createdLink) await unlink(directory); await rename(savedDirectory, directory); }
    });
    await group('real byte corruption, oversized files and truncation after metadata SELECT fail closed', async () => {
      const value = await seed('bytes', true), blob = value.blob!, original = await readFile(blob);
      const attempt = () => read(connection => assets(connection, h.source.workspaceId, value.metadata));
      for (const bytes of [Buffer.alloc(original.length, 9), original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from([0])])]) {
        await writeFile(blob, bytes);
        try { await assert.rejects(attempt(), assetFailure); } finally { await writeFile(blob, original); }
      }
      await truncate(blob, 20 * 1024 * 1024 + 1);
      try { await assert.rejects(attempt(), assetFailure); } finally { await writeFile(blob, original); }
      let intervened = false;
      try {
        await assert.rejects(read(connection => assets(connection, h.source.workspaceId, value.metadata), async sql => {
          if (!intervened && /\bFROM\s+collaboration_excalidraw_assets\b/iu.test(sql)) { intervened = true; await truncate(blob, 0); }
        }), assetFailure);
        assert.equal(intervened, true, 'The fault follows actual metadata SELECT, before genuine FD I/O.');
      } finally { await writeFile(blob, original); }
    });
    await group('repeated RR READ ONLY scene/blob reads preserve every row, last-reference and physical file', async () => {
      const value = await seed('unchanged', true), beforeRows = await tableHashes(), beforeFiles = await snapshotTestFilesystem(h.dataRoot);
      const both = () => read(async connection => {
        const records = await snapshots(connection, h.source, await catalogue(connection, h.source, { paths: [value.path] }));
        const binaries = await assets(connection, h.source.workspaceId, records[0].scene.assets); return { records, binaries };
      });
      assert.deepEqual(await both(), await both());
      assert.deepEqual(await tableHashes(), beforeRows, 'No DML, operation/revision creation, bootstrap or asset last-reference update.');
      assert.deepEqual(await snapshotTestFilesystem(h.dataRoot), beforeFiles, 'No projection, blob write or temporary file publication.');
    });
  });
  assert.equal(groups, 8);
  assert.deepEqual(Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(file))]))), pins);
  completed = true;
  console.log(JSON.stringify({ suite: 'workspace-scene-snapshot-postgres', passed: true, groups, sourcesUnchanged: true,
    scope: 'read-only PG/FS reader foundation; no mixed Copy or current-principal authorization acceptance claimed' }));
}

void workspaceSceneSnapshotPostgresTest().catch(error => {
  const safeCode = code(error);
  console.error(JSON.stringify({ suite: 'workspace-scene-snapshot-postgres', case: currentCase,
    name: error instanceof Error ? error.name : 'unknown',
    code: typeof safeCode === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(safeCode) ? safeCode : null,
    frames: error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const found = /\/(app\/lib\/[a-z0-9_./-]+|scripts\/[a-z0-9_./-]+):(\d+):(\d+)\)?$/iu.exec(line);
      return found ? [`${found[1]}:${found[2]}:${found[3]}`] : [];
    }).slice(0, 5) : [] })); process.exitCode = 1;
});
