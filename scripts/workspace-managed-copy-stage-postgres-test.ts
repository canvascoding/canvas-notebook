import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual PG18, Scene/Yjs writers, source READ, destination WRITE and prepared
// filesystem capabilities. This tests private recovery data, not Copy publication.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const code = (error: unknown): unknown => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;

async function managedCopyStagePostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const sources = ['scripts/workspace-managed-copy-stage-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/files/workspace-operation-managed-copy-plan.ts', 'app/lib/files/workspace-operation-native-copy-metadata.ts',
    'app/lib/filesystem/prepared-workspace-path-copy-contract.ts', 'app/lib/filesystem/prepared-workspace-path-copy.ts',
    'app/lib/excalidraw-collaboration/portable-serialization.ts'];
  const pins = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { withNativeInspectionSchema } = await import('../app/lib/collaboration/native-inspection-schema');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { readWorkspaceCopySourceObservationOnConnection: observe } = await import('../app/lib/files/workspace-operation-copy-source-observation');
    const { createWorkspaceOperationManagedCopyPlan: createPlan } = await import('../app/lib/files/workspace-operation-managed-copy-plan');
    const { prepareManagedCopyStage: prepare, decodeManagedCopyStage: decode, assertManagedCopyStageManifestDigest: assertManifest } =
      await import('../app/lib/files/workspace-operation-managed-copy-stage');
    const { captureNativeCopyMetadataSnapshotOnConnection: captureMetadata } = await import('../app/lib/files/workspace-operation-native-copy-metadata');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { withPreparedWorkspacePathCopy, readPreparedWorkspacePathCopy } = await import('../app/lib/filesystem/prepared-workspace-path-copy');
    const { importExcalidrawDocumentFile } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { applyExcalidrawScenePatch } = await import('../app/lib/excalidraw-collaboration/repository');
    const { readExcalidrawAssetsOnConnection } = await import('../app/lib/excalidraw-collaboration/readonly-assets');
    const { serializePortableExcalidrawSceneFromReadonlyAssets: portable } = await import('../app/lib/excalidraw-collaboration/portable-serialization');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    type Input = Parameters<typeof prepare>[0];
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId); assert(sourceOwner);
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
    const actor = { userId: 'owner', actorId: 'owner', actorType: 'user' as const, sessionId: 'session-owner' };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const assetId = `stage-${crypto.randomUUID()}`;
    await h.upload('mixed/note.md', Buffer.from('# Note\n[Scene](/mixed/diagram.excalidraw) [Target](target.md) [PDF](manual.pdf)\n'));
    await h.upload('mixed/target.md', Buffer.from('# Target\n'));
    await h.upload('incoming.md', Buffer.from('[Original](mixed/diagram.excalidraw)\n'));
    await h.metadata(h.source, 'mixed/note.md', { title: 'Original stage title' });
    await fs.mkdir(path.join(h.source.rootPath, 'mixed/empty'), { recursive: true });
    const pdf = Buffer.from('%PDF-1.7\n\0\xff\n%%EOF', 'binary'); await fs.writeFile(path.join(h.source.rootPath, 'mixed/manual.pdf'), pdf);
    const initialScene = await importExcalidrawDocumentFile({ workspace: sourceOwner, actor, path: 'mixed/diagram.excalidraw', content: JSON.stringify({
      type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }],
      appState: { viewBackgroundColor: '#ffffff' }, files: { [assetId]: { id: assetId, mimeType: 'image/png',
        dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } }) });
    const latest = await applyExcalidrawScenePatch({ documentId: initialScene.documentId, lifecycleGeneration: initialScene.lifecycleGeneration,
      baseSequence: initialScene.sceneSequence, messageId: crypto.randomUUID(), actorType: 'user', actorId: 'owner',
      elements: [{ id: 'latest', type: 'rectangle', version: 1, versionNonce: 8, isDeleted: false, x: 42 }] });
    for (const name of ['mixed/note.md', 'mixed/target.md', initialScene.path]) await fs.unlink(path.join(h.source.rootPath, name));
    await h.admin.query('UPDATE collaboration_excalidraw_assets SET last_referenced_at=456 WHERE workspace_id=$1', [h.source.workspaceId]);
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: h.source, destinationWorkspace: h.destination });
    const store = new WorkspaceOperationStaging({ dataRoot: h.dataRoot }), journal = new WorkspaceOperationJournal();
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++;
      console.log(`PASS managed-copy-stage ${groups}: ${name}`); };
    const build = async (): Promise<Input> => {
      const ids = [h.source.workspaceId, h.destination.workspaceId].sort();
      const enter = (index: number): Promise<Input> => index < ids.length ? withWorkspaceMutationLock(ids[index], () => enter(index + 1)) : (async () => {
        await h.admin.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        try {
          for (const id of ids) await h.admin.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(id)]);
          const before = (await h.admin.query("SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS readonly")).rows[0];
          assert.equal(before.readonly, 'on');
          const connection: SqlConnection = { get: h.connection.get, all: h.connection.all,
            run: () => assert.fail('Stage capture attempted DML.'), close: () => assert.fail('Stage capture closed the caller B.') };
          const source = await observe(connection, h.source), destination = await observe(connection, h.destination);
          const selections = [{ sourcePath: 'mixed', destinationPath: `copied-${crypto.randomUUID()}` }];
          const plan = createPlan({ sourceScope: { workspace: h.source, fileOptions: {} }, destinationScope: { workspace: h.destination, fileOptions: {} },
            selections, sourceObservation: source, destinationObservation: destination });
          const sceneRecords = source.privateSceneSnapshots.filter(snapshot => plan.sceneCopyRequirements.some(requirement => requirement.sourceDocumentId === snapshot.header.id));
          const metadataById = new Map(sceneRecords.flatMap(snapshot => snapshot.scene.assets).map(metadata => [metadata.fileId, metadata]));
          const binary = await readExcalidrawAssetsOnConnection(connection, h.source.workspaceId, [...metadataById.values()]);
          const sceneAssets = binary.map(asset => ({ workspaceId: h.source.workspaceId, asset }));
          const derivedFiles = sceneRecords.map(snapshot => ({ path: snapshot.header.path, provider: 'excalidraw' as const,
            documentId: snapshot.header.id, lineageId: snapshot.header.lineage_id, lifecycleGeneration: snapshot.header.lifecycle_generation!,
            sourceContentProof: snapshot.contentProof, bytes: Buffer.from(portable({ elements: snapshot.scene.elements, appState: snapshot.scene.appState,
              assets: snapshot.scene.assets, canonicalHash: snapshot.scene.canonicalHash }, binary.map(asset => ({ metadata: asset.metadata, bytes: asset.bytes })))) }));
          const physical: Input['physical'][number][] = [];
          await withPreparedWorkspacePathCopy({ sourceWorkspace: h.source, destinationWorkspace: h.destination, ...selections[0],
            sourceKind: 'directory', projectionPaths: plan.sourceEvidence.nativeBindings.map(binding => binding.expected.path)
              .filter(name => name.startsWith('mixed/')), sourceProjectionPolicy: 'provider-derived-files-v3', derivedFiles }, async cap => {
            const original = readPreparedWorkspacePathCopy(cap); assert(original.version === 3);
            physical.push({ selectionIndex: 0, original });
          });
          const nativeRecords = [source, destination].flatMap(observation => observation.nativeBindings.map(binding => {
            const state = observation.privateNativeStates.find(state => state.documentId === binding.expected.documentId); assert(state);
            return { lineageId: binding.expected.lineageId, state };
          }));
          const metadata = await captureMetadata(connection, { plan, physical });
          assert.deepEqual((await h.admin.query("SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS readonly")).rows[0], before);
          return { operationId: `managed-stage-${crypto.randomUUID()}`, request: { kind: 'copy', origin, selections }, plan,
            physical, nativeRecords, sceneRecords, sceneAssets, metadata };
        } finally { await h.admin.query('ROLLBACK'); }
      })();
      return enter(0);
    };
    const payloads = (value: ReturnType<typeof prepare>) => ({ recordsBytes: value.recordsBytes,
      sceneRecordsBytes: value.sceneRecordsBytes, sceneAssetsBytes: value.sceneAssetsBytes });
    const directory = (input: Input) => path.join(h.dataRoot, 'workspace-operation-staging', input.operationId);
    const rejectStage = (error: unknown) => ['STAGE_CONFLICT', 'CORRUPT_STAGE', 'STAGE_TOO_LARGE', 'UNSAFE_STORAGE'].includes(String(code(error)));
    const rejectFilesystem = (error: unknown) => rejectStage(error) || code(error) === 'ELOOP';
    const sqlHashes = async () => {
      const result: Record<string, string> = {};
      for (const { tablename } of (await h.admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [h.schema])).rows) {
        assert.match(tablename, /^[a-z][a-z0-9_]*$/u);
        result[tablename] = (await h.admin.query(`SELECT md5(COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)
          ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${h.schema}"."${tablename}" t`)).rows[0].hash;
      }
      return result;
    };
    await withNativeInspectionSchema(async () => {
      let baseline!: Input;
      await group('real mixed V4 stage roundtrips source/destination native bytes, selected Scene, PNG and prepared PDF/emptydir', async () => {
        baseline = await build(); const prepared = prepare(baseline), decoded = decode(prepared.manifest, payloads(prepared), prepared.manifest.identity);
        assert.equal(decoded.version, 4); assert.equal(decoded.plan.version, 3); assert.equal(decoded.plan.executionReady, false);
        assert.deepEqual(decoded.nativeRecords, baseline.nativeRecords); assert.deepEqual(decoded.sceneRecords, baseline.sceneRecords);
        assert.equal(decoded.sceneRecords[0].scene.sceneSequence, latest.state.sceneSequence);
        assert(decoded.sceneRecords[0].scene.elements.some(element => element.id === 'latest'));
        assert.equal(decoded.sceneAssets.length, 1); assert.deepEqual(Buffer.from(decoded.sceneAssets[0].asset.bytes), png);
        const saved = await store.stageManagedCopy(baseline); assert.deepEqual(saved, decoded);
        assert.deepEqual(await store.loadManagedCopy(saved.identity), saved); assert.deepEqual(await store.loadManagedCopyByOperationId(baseline.operationId), saved);
        assert.equal(await store.readKind(baseline.operationId), 'native-copy');
        assert.deepEqual((await fs.readdir(directory(baseline))).sort(), ['manifest.json', 'native-records.bin', 'scene-assets.bin', 'scene-records.json']);
        assert.equal((await fs.stat(directory(baseline))).mode & 0o777, 0o700);
        for (const name of await fs.readdir(directory(baseline))) assert.equal((await fs.stat(path.join(directory(baseline), name))).mode & 0o777, 0o600);
        assert.equal(JSON.stringify(prepared.manifest).includes('dataURL'), false); assert.equal(JSON.stringify(prepared.manifest).includes('yjsState'), false);
        const physical = baseline.physical[0].original; assert.equal(physical.version, 3); assert(physical.staging);
        const payloadRoot = path.join(h.destination.rootPath, physical.staging.relativePath, 'payload');
        assert.deepEqual(await fs.readFile(path.join(payloadRoot, 'manual.pdf')), pdf);
        assert.deepEqual(await fs.readdir(path.join(payloadRoot, 'empty')), []);
        const portableScene = JSON.parse(await fs.readFile(path.join(payloadRoot, 'diagram.excalidraw'), 'utf8'));
        assert(portableScene.elements.some((element: { id: string }) => element.id === 'latest'));
        assert.equal(portableScene.files[assetId].dataURL, `data:image/png;base64,${png.toString('base64')}`);
        await assert.rejects(fs.stat(path.join(h.destination.rootPath, baseline.request.selections[0].destinationPath)), { code: 'ENOENT' });
      });
      await group('caller READ ONLY capture and store reads leave every SQL row and source asset last-reference unchanged', async () => {
        const before = await sqlHashes(), pdfInfo = await fs.lstat(path.join(h.source.rootPath, 'mixed/manual.pdf'));
        const input = await build(), saved = await store.stageManagedCopy(input); await store.loadManagedCopy(saved.identity);
        assert.deepEqual(await sqlHashes(), before);
        assert.equal((await fs.lstat(path.join(h.source.rootPath, 'mixed/manual.pdf'))).ino, pdfInfo.ino);
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, 'mixed/manual.pdf')), pdf);
        assert((await h.admin.query('SELECT last_referenced_at::text AS value FROM collaboration_excalidraw_assets WHERE workspace_id=$1', [h.source.workspaceId])).rows.every(row => row.value === '456'));
      });
      await group('pending stage recovers immutable original before B0 without adopting a later target occupant', async () => {
        const input = await build(), original = await store.stageManagedCopy(input); assert.equal(await journal.get(input.operationId), null);
        const target = path.join(h.destination.rootPath, input.request.selections[0].destinationPath);
        await fs.mkdir(target); const foreign = path.join(target, 'foreign.bin'); await fs.writeFile(foreign, 'Later D2', { mode: 0o600, flag: 'wx' });
        const identity = await fs.lstat(foreign);
        assert.deepEqual(await new WorkspaceOperationStaging({ dataRoot: h.dataRoot }).loadManagedCopyByOperationId(input.operationId), original);
        assert.equal((await fs.lstat(foreign)).ino, identity.ino); assert.equal(await fs.readFile(foreign, 'utf8'), 'Later D2');
        assert.equal(await journal.get(input.operationId), null);
        await assert.rejects(store.removeCompletedManagedCopy(original.identity), (error: unknown) => code(error) === 'NOT_COMPLETED');
        assert.deepEqual(await store.loadManagedCopy(original.identity), original);
      });
      await group('binding omissions, duplicate assets, hard bounds and all payload bit flips are rejected', async () => {
        const input = await build(), prepared = prepare(input);
        for (const change of [
          (value: Input) => Reflect.set(value, 'sceneRecords', []),
          (value: Input) => Reflect.set(value, 'sceneAssets', []),
          (value: Input) => Reflect.set(value, 'sceneAssets', [value.sceneAssets[0], value.sceneAssets[0]]),
          (value: Input) => Reflect.set(value, 'sceneAssets', [{ ...value.sceneAssets[0], workspaceId: h.destination.workspaceId }]),
          (value: Input) => Reflect.deleteProperty(value, 'metadata'),
          (value: Input) => { const original = value.physical[0].original; assert(original.version === 3);
            Reflect.set(original.derivedFiles[0], 'sourceContentProof', '0'.repeat(64)); },
          (value: Input) => { value.sceneAssets[0].asset.bytes[0] ^= 1; },
        ]) { const value = structuredClone(input); change(value); assert.throws(() => prepare(value), rejectStage); }
        const oversized = structuredClone(input); Reflect.set(oversized, 'sceneAssets', Array(2001).fill(oversized.sceneAssets[0]));
        assert.throws(() => prepare(oversized), (error: unknown) => code(error) === 'STAGE_TOO_LARGE');
        await assert.rejects(store.stageManagedCopy(oversized), (error: unknown) => code(error) === 'STAGE_TOO_LARGE');
        await assert.rejects(fs.stat(directory(oversized)), { code: 'ENOENT' });
        assert.throws(() => assertManifest({ ...prepared.manifest,
          sceneAssets: { ...prepared.manifest.sceneAssets, sizeBytes: 50 * 1024 * 1024 + 1 } }),
        (error: unknown) => code(error) === 'STAGE_TOO_LARGE');
        for (const name of ['recordsBytes', 'sceneRecordsBytes', 'sceneAssetsBytes'] as const) {
          const changed = payloads(prepared); changed[name] = Buffer.from(changed[name]); changed[name][changed[name].length - 1] ^= 1;
          assert.throws(() => decode(prepared.manifest, changed, prepared.manifest.identity), rejectStage);
        }
        assert.throws(() => decode({ ...prepared.manifest, unexpected: true }, payloads(prepared), prepared.manifest.identity), rejectStage);
        assert.throws(() => decode(prepared.manifest, payloads(prepared), { ...prepared.manifest.identity, canonicalRequestHash: '0'.repeat(64) }), rejectStage);
      });
      await group('new Scene sidecars retain real FD name/inode/profile checks and unknown files are preserved', async () => {
        const input = await build(), saved = await store.stageManagedCopy(input), root = directory(input);
        for (const name of ['scene-records.json', 'scene-assets.bin']) {
          const file = path.join(root, name), backup = path.join(h.dataRoot, `sidecar-backup-${crypto.randomUUID()}`);
          await fs.rename(file, backup);
          try { await fs.symlink(backup, file); await assert.rejects(store.loadManagedCopy(saved.identity), rejectFilesystem); await fs.unlink(file); }
          finally { await fs.rename(backup, file); }
          await fs.link(file, backup);
          try { await assert.rejects(store.loadManagedCopy(saved.identity), rejectStage); } finally { await fs.unlink(backup); }
          await fs.chmod(file, 0o644);
          try { await assert.rejects(store.loadManagedCopy(saved.identity), rejectStage); } finally { await fs.chmod(file, 0o600); }
        }
        const foreign = path.join(root, 'foreign.bin'); await fs.writeFile(foreign, 'D2', { flag: 'wx', mode: 0o600 });
        await assert.rejects(store.loadManagedCopyByOperationId(input.operationId), rejectStage);
        assert.equal(await fs.readFile(foreign, 'utf8'), 'D2'); await fs.unlink(foreign);
        assert.deepEqual(await store.loadManagedCopy(saved.identity), saved);
      });
      await group('Stage captures native/Scene/asset input before its first storage await', async () => {
        const input = structuredClone(await build()), expected = prepare(input).manifest.payloadSha256;
        const pending = store.stageManagedCopy(input);
        input.sceneAssets[0].asset.bytes.fill(0); input.nativeRecords[0].state.yjsState.fill(0);
        Reflect.set(input.sceneRecords[0].scene, 'canonicalHash', '0'.repeat(64));
        const saved = await pending; assert.equal(saved.payloadSha256, expected);
        assert.deepEqual(Buffer.from(saved.sceneAssets[0].asset.bytes), png);
        assert.equal((await store.loadManagedCopy(saved.identity)).payloadSha256, expected);
      });
      await group('V4 dispatch never routes through legacy native loaders or claims completed publication', async () => {
        const saved = await store.loadManagedCopyByOperationId(baseline.operationId); assert(saved);
        await assert.rejects(store.loadNativeCopy(saved.identity)); await assert.rejects(store.loadNativeCopyByOperationId(baseline.operationId));
        assert.equal(await store.readKind(baseline.operationId), 'native-copy'); assert.equal(await journal.get(baseline.operationId), null);
        await assert.rejects(store.removeCompletedManagedCopy(saved.identity), (error: unknown) => code(error) === 'NOT_COMPLETED');
        assert.equal((await store.loadManagedCopy(saved.identity)).payloadSha256, saved.payloadSha256);
      });
    });
  });
  assert.equal(groups, 7);
  assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-managed-copy-stage-postgres', groups, passed: true, sourcesUnchanged: true,
    scope: 'actual private V4 data/PG/FS foundation; no B1/B2 Copy publication acceptance claimed' }));
}

void managedCopyStagePostgresTest().catch(error => {
  const safeCode = code(error);
  console.error(JSON.stringify({ suite: 'workspace-managed-copy-stage-postgres', case: currentCase, name: error instanceof Error ? error.name : 'unknown',
    code: typeof safeCode === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(safeCode) ? safeCode : null,
    frames: error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const found = /\/(app\/lib\/[a-z0-9_./-]+|scripts\/[a-z0-9_./-]+):(\d+):(\d+)\)?$/iu.exec(line);
      return found ? [`${found[1]}:${found[2]}:${found[3]}`] : [];
    }).slice(0, 5) : [] })); process.exitCode = 1;
});
