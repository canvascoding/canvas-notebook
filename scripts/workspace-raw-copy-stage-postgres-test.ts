import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceOperationRawCopyStageInput } from '../app/lib/files/workspace-operation-managed-copy-stage';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { rawCopyStageTest } from './workspace-raw-copy-stage-test';

// Actual PG18 + actual prepared FD originals/private Store. No Copy B1/B2,
// publication, native Raw birth, synthetic principal or completion is performed.
let completed = false, groups = 0, currentCase = 'setup';
function beforeExitGuard(): void { if (!completed) process.exitCode = 1; }
process.once('beforeExit', beforeExitGuard);
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const code = (error: unknown): unknown => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;

async function rawCopyStagePostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const sources = ['scripts/workspace-raw-copy-stage-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'scripts/workspace-raw-copy-stage-test.ts', 'scripts/workspace-operation-raw-copy-planning-test.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/files/workspace-operation-managed-copy-plan-v5.ts', 'app/lib/files/workspace-operation-native-copy-metadata.ts',
    'app/lib/files/workspace-operation-copy-source-observation.ts', 'app/lib/markdown/workspace-native-mixed-batch-compiler.ts',
    'app/lib/markdown/workspace-physical-link-inventory.ts', 'app/lib/filesystem/prepared-workspace-path-copy-contract.ts',
    'app/lib/filesystem/prepared-workspace-path-copy.ts'];
  const pins = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { withNativeInspectionSchema } = await import('../app/lib/collaboration/native-inspection-schema');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { readWorkspaceCopySourceObservationOnConnection: observe } = await import('../app/lib/files/workspace-operation-copy-source-observation');
    const { createWorkspaceOperationManagedCopyPlanV5: createPlan } = await import('../app/lib/files/workspace-operation-managed-copy-plan-v5');
    const { prepareRawCopyStage: prepare, decodeRawCopyStage: decode } = await import('../app/lib/files/workspace-operation-managed-copy-stage');
    const { captureNativeCopyMetadataSnapshotOnConnection: captureMetadata } = await import('../app/lib/files/workspace-operation-native-copy-metadata');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { withPreparedWorkspacePathCopy, readPreparedWorkspacePathCopy } = await import('../app/lib/filesystem/prepared-workspace-path-copy');

    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canRead && h.destination.permissions.canWrite);
    const originals = new Map([
      ['raw-a.md', Buffer.from('\uFEFF---\r\naliases: [Raw Alpha]\r\n---\r\n# Alpha\r\n\r\n😀 [Self](raw-a.md) and [[Raw Beta|B]]\r\n')],
      ['raw-b.md', Buffer.from('---\naliases: [Raw Beta]\n---\n# Beta\n\n[Self](raw-b.md) and [[Raw Alpha]]\n')],
      ['unselected-raw.md', Buffer.from('# Unselected\n\n[[Raw Alpha]]\n')],
    ]);
    // Fixture setup alone writes these ordinary files; none goes through import.
    for (const [name, bytes] of originals) await fs.writeFile(path.join(h.source.rootPath, name), bytes, { flag: 'wx', mode: 0o600 });
    const native = await h.upload('native-selected.md', Buffer.from('# Native\n\n[Raw](raw-a.md)\n'));
    await h.metadata(h.source, 'native-selected.md', { title: 'Native source title' }, 'owner');
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: h.source, destinationWorkspace: h.destination });
    const store = new WorkspaceOperationStaging({ dataRoot: h.dataRoot }), journal = new WorkspaceOperationJournal();
    const payloads = (value: ReturnType<typeof prepare>) => ({ recordsBytes: value.recordsBytes, sceneRecordsBytes: value.sceneRecordsBytes,
      sceneAssetsBytes: value.sceneAssetsBytes, rawOriginalsBytes: value.rawOriginalsBytes });
    const directory = (input: WorkspaceOperationRawCopyStageInput) => path.join(h.dataRoot, 'workspace-operation-staging', input.operationId);
    const rejectStage = (error: unknown) => ['STAGE_CONFLICT', 'CORRUPT_STAGE', 'STAGE_TOO_LARGE', 'UNSAFE_STORAGE'].includes(String(code(error)));
    const rejectFilesystem = (error: unknown) => rejectStage(error) || code(error) === 'ELOOP';

    const sqlHashes = async (): Promise<Record<string, string>> => {
      const result: Record<string, string> = {};
      for (const { tablename } of (await h.admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [h.schema])).rows) {
        assert.match(tablename, /^[a-z][a-z0-9_]*$/u);
        result[tablename] = (await h.admin.query(`SELECT md5(COALESCE(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)
          ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM "${h.schema}"."${tablename}" t`)).rows[0].hash;
      }
      return result;
    };
    const sourceFiles = async () => {
      const result: Array<Record<string, unknown>> = [];
      const visit = async (relative: string): Promise<void> => {
        assert(result.length < 10000, 'Source file inventory exceeded the fixture budget.');
        const absolute = path.join(h.source.rootPath, relative), info = await fs.lstat(absolute, { bigint: true });
        assert(!info.isSymbolicLink()); assert(info.isDirectory() || info.isFile());
        result.push({ path: relative, dev: String(info.dev), ino: String(info.ino), mode: String(info.mode), uid: String(info.uid), gid: String(info.gid),
          nlink: String(info.nlink), size: String(info.size), birthtimeNs: String(info.birthtimeNs), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
          ...(info.isFile() ? { sha256: sha(await fs.readFile(absolute)) } : {}) });
        if (info.isDirectory()) for (const name of (await fs.readdir(absolute)).sort()) await visit(relative ? relative + '/' + name : name);
      };
      await visit(''); return result;
    };
    const assertPristineSources = async () => {
      for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) {
        const row = (await h.admin.query(`SELECT count(*)::integer AS n FROM "${h.schema}"."${table}" WHERE workspace_id=$1 AND path=ANY($2::text[])`,
          [h.source.workspaceId, [...originals.keys()]])).rows[0];
        assert.equal(row.n, 0, `${table} must retain all ordinary raw sources without initialization.`);
      }
      for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, name)), bytes);
    };
    let laterTarget: { path: string; dev: string; ino: string; bytes: Buffer } | undefined;
    const d2Current = async () => {
      if (!laterTarget) return;
      const info = await fs.lstat(laterTarget.path, { bigint: true });
      assert.equal(String(info.dev), laterTarget.dev); assert.equal(String(info.ino), laterTarget.ino);
      assert.deepEqual(await fs.readFile(laterTarget.path), laterTarget.bytes);
    };
    const sqlBefore = await sqlHashes(), filesBefore = await sourceFiles(); await assertPristineSources();
    const group = async (name: string, action: () => Promise<void>) => {
      currentCase = name; let primary: unknown;
      try { await action(); } catch (error) { primary = error; }
      // Execute every NoWrite oracle even if the case's main assertion failed.
      const checks = await Promise.allSettled([
        sqlHashes().then(actual => assert.deepEqual(actual, sqlBefore)),
        sourceFiles().then(actual => assert.deepEqual(actual, filesBefore)),
        assertPristineSources(), d2Current(),
      ]);
      console.log(JSON.stringify({ suite: 'workspace-raw-copy-stage-postgres', case: name, actionPassed: primary === undefined,
        noWrite: { domainRowsAndXmins: checks[0].status === 'fulfilled', completeSourceFiles: checks[1].status === 'fulfilled',
          rawUninitializedAndExactBytes: checks[2].status === 'fulfilled', laterTargetPreserved: checks[3].status === 'fulfilled' },
        scope: 'private Stage6 data/store only' }));
      const errors = [...(primary === undefined ? [] : [primary]), ...checks.flatMap(value => value.status === 'rejected' ? [value.reason] : [])];
      if (errors.length) throw new AggregateError(errors, `Raw Copy Stage6 group failed: ${name}`);
      groups++; console.log(`PASS raw-copy-stage-pg ${groups}: ${name}`);
    };
    const build = async (): Promise<WorkspaceOperationRawCopyStageInput> => {
      const ids = [h.source.workspaceId, h.destination.workspaceId].sort();
      const observeStageReadOnly = async (): Promise<WorkspaceOperationRawCopyStageInput> => {
        await h.admin.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        try {
          for (const id of ids) await h.admin.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(id)]);
          const before = (await h.admin.query("SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS readonly,pg_current_xact_id_if_assigned()::text AS xid")).rows[0];
          assert.equal(before.readonly, 'on'); assert.equal(before.xid, null);
          const connection: SqlConnection = { get: h.connection.get, all: h.connection.all,
            run: () => assert.fail('Raw Stage capture attempted DML.'), close: () => assert.fail('Raw Stage capture closed actual B.') };
          const source = await observe(connection, h.source), destination = await observe(connection, h.destination);
          const suffix = crypto.randomUUID(), selections = [
            { sourcePath: 'raw-a.md', destinationPath: `copy-${suffix}-a.md` },
            { sourcePath: 'raw-b.md', destinationPath: `copy-${suffix}-b.md` },
            { sourcePath: 'native-selected.md', destinationPath: `copy-${suffix}-native.md` },
          ];
          const plan = createPlan({ sourceScope: { workspace: h.source, fileOptions: {} }, destinationScope: { workspace: h.destination, fileOptions: {} },
            sourceObservation: source, destinationObservation: destination, selections });
          assert.equal(plan.version, 5); assert.equal(plan.rawImportRequirements.length, 2); assert.equal(plan.cloneRequirements.length, 1);
          assert.equal(plan.sceneCopyRequirements.length, 0); assert(plan.sourceEvidence.nativeComponent.physicalSources.some(value => value.path === 'unselected-raw.md'));
          const physical: WorkspaceOperationRawCopyStageInput['physical'][number][] = [];
          for (const [selectionIndex, selection] of selections.entries()) {
            const entry = source.stage.namespace.find(entry => entry.path === selection.sourcePath); assert(entry);
            await withPreparedWorkspacePathCopy({ sourceWorkspace: h.source, destinationWorkspace: h.destination, ...selection,
              sourceKind: entry.filesystemIdentity === null ? 'projection_absent' : 'regular_file',
              projectionPaths: source.nativeBindings.filter(binding => binding.expected.path === selection.sourcePath).map(binding => binding.expected.path),
              sourceProjectionPolicy: 'provider-derived-files-v3', derivedFiles: [] }, async cap => {
              const original = readPreparedWorkspacePathCopy(cap); assert.equal(original.version, 3);
              physical.push({ selectionIndex, original });
            });
          }
          const nativeRecords = [source, destination].flatMap(observation => observation.nativeBindings.map(binding => {
            const state = observation.privateNativeStates.find(state => state.documentId === binding.expected.documentId); assert(state);
            return { lineageId: binding.expected.lineageId, state };
          }));
          const rawOriginals = plan.rawImportRequirements.map(requirement => {
            const entry = source.stage.sources.find(entry => entry.kind === 'physical' && entry.inventory.path === requirement.sourcePath);
            assert(entry?.kind === 'physical'); assert.equal(entry.inventory.parserVersion, 2); return entry.inventory;
          });
          const metadata = await captureMetadata(connection, { plan, physical });
          assert.deepEqual((await h.admin.query("SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS readonly,pg_current_xact_id_if_assigned()::text AS xid")).rows[0], before);
          return { operationId: `raw-stage-${crypto.randomUUID()}`, request: { kind: 'copy', origin, selections }, plan,
            physical, nativeRecords, rawOriginals, sceneRecords: [], sceneAssets: [], metadata };
        } finally { await h.admin.query('ROLLBACK'); }
      };
      const enter = (index: number): Promise<WorkspaceOperationRawCopyStageInput> => index < ids.length
        ? withWorkspaceMutationLock(ids[index], () => enter(index + 1)) : observeStageReadOnly();
      return enter(0);
    };
    await withNativeInspectionSchema(async () => {
      let baseline!: WorkspaceOperationRawCopyStageInput;
      await group('actual readonly source Raw2 self/mutual/CRLF/BOM plus native roundtrips before B1', async () => {
        baseline = await build(); const prepared = prepare(baseline), restored = decode(prepared.manifest, payloads(prepared), prepared.manifest.identity);
        assert.equal(restored.version, 6); assert.equal(restored.plan.version, 5); assert.equal(restored.plan.executionReady, false);
        assert.equal(restored.rawOriginals.length, 2); assert(restored.nativeRecords.some(row => row.state.documentId === native.documentId));
        for (const inventory of restored.rawOriginals) assert.deepEqual(Buffer.from(inventory.originalBytes), originals.get(inventory.path));
        const first = restored.rawOriginals.find(value => value.path === 'raw-a.md'); assert(first?.hasBom); assert.equal(first.lineEndings.style, 'crlf');
        assert.equal(restored.plan.compilation.steps[0].physicalLinkIntents.length, 4);
        rawCopyStageTest(baseline);
        const saved = await store.stageRawCopy(baseline); assert.deepEqual(saved, restored);
        assert.deepEqual(await store.loadRawCopy(saved.identity), saved); assert.deepEqual(await store.loadRawCopyByOperationId(baseline.operationId), saved);
        assert.equal(await store.readKind(baseline.operationId), 'native-copy');
        assert.deepEqual((await fs.readdir(directory(baseline))).sort(), ['manifest.json', 'native-records.bin', 'raw-originals.bin', 'scene-assets.bin', 'scene-records.json']);
        const info = await fs.lstat(directory(baseline)); assert.equal(info.uid, process.getuid!()); assert.equal(info.mode & 0o777, 0o700);
        for (const name of await fs.readdir(directory(baseline))) {
          const file = await fs.lstat(path.join(directory(baseline), name)); assert(file.isFile()); assert.equal(file.nlink, 1);
          assert.equal(file.uid, process.getuid!()); assert.equal(file.mode & 0o777, 0o600);
        }
        assert.deepEqual(await fs.readFile(path.join(directory(baseline), 'raw-originals.bin')), prepared.rawOriginalsBytes);
        for (const selected of baseline.physical.slice(0, 2)) {
          assert(selected.original.staging); assert.equal(selected.original.staging.payload.kind, 'regular_file');
          assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, selected.original.staging.relativePath, 'payload')),
            originals.get(selected.original.sourcePath));
          await assert.rejects(fs.lstat(path.join(h.destination.rootPath, selected.original.destinationPath)), { code: 'ENOENT' });
        }
        assert.equal(await journal.get(baseline.operationId), null);
      });
      await group('actual readonly observation and repeated Store reads leave all SQL/xmins/source bytes unchanged', async () => {
        const input = await build(), prepared = prepare(input), saved = await store.stageRawCopy(input);
        assert.deepEqual(await new WorkspaceOperationStaging({ dataRoot: h.dataRoot }).loadRawCopy(saved.identity), saved);
        assert.deepEqual(await store.loadRawCopyByOperationId(input.operationId), saved);
        assert.deepEqual(await fs.readFile(path.join(directory(input), 'raw-originals.bin')), prepared.rawOriginalsBytes);
      });
      await group('pre-journal restart preserves original Stage6 and a later real D2 without legacy execution dispatch', async () => {
        const saved = await store.loadRawCopyByOperationId(baseline.operationId); assert(saved); assert.equal(await journal.get(baseline.operationId), null);
        const target = path.join(h.destination.rootPath, baseline.plan.selections[0].destinationPath), bytes = Buffer.from('Later D2 must survive\n');
        await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); const info = await fs.lstat(target, { bigint: true });
        laterTarget = { path: target, dev: String(info.dev), ino: String(info.ino), bytes };
        assert.deepEqual(await new WorkspaceOperationStaging({ dataRoot: h.dataRoot }).loadRawCopyByOperationId(baseline.operationId), saved);
        await assert.rejects(store.loadOwnedCopyByOperationId(baseline.operationId), rejectStage);
        await assert.rejects(store.loadNativeCopy(saved.identity), rejectStage); await assert.rejects(store.loadManagedCopy(saved.identity), rejectStage);
        await assert.rejects(store.removeCompletedRawCopy(saved.identity), (error: unknown) => code(error) === 'NOT_COMPLETED');
        assert.deepEqual(await store.loadRawCopy(saved.identity), saved); assert.equal(await journal.get(baseline.operationId), null);
      });
      await group('actual raw sidecar bit corruption rejects without adopting target D2 or changing sources', async () => {
        const saved = await store.loadRawCopyByOperationId(baseline.operationId); assert(saved);
        const file = path.join(directory(baseline), 'raw-originals.bin'), bytes = await fs.readFile(file), changed = Buffer.from(bytes); changed[0] ^= 1;
        await fs.writeFile(file, changed, { flag: 'r+' });
        try { await assert.rejects(store.loadRawCopy(saved.identity), rejectStage); await assert.rejects(store.loadRawCopyByOperationId(baseline.operationId), rejectStage); }
        finally { await fs.writeFile(file, bytes, { flag: 'r+' }); }
        assert.deepEqual(await store.loadRawCopy(saved.identity), saved);
      });
      await group('real missing/symlink/hardlink/mode/extra raw sidecars reject and preserve original nodes', async () => {
        const saved = await store.loadRawCopyByOperationId(baseline.operationId); assert(saved);
        const file = path.join(directory(baseline), 'raw-originals.bin'), bytes = await fs.readFile(file), original = await fs.lstat(file, { bigint: true });
        const backup = path.join(h.dataRoot, `raw-sidecar-backup-${crypto.randomUUID()}`);
        await fs.rename(file, backup);
        try {
          await assert.rejects(store.loadRawCopy(saved.identity), rejectFilesystem);
          await fs.symlink(backup, file);
          try { await assert.rejects(store.loadRawCopy(saved.identity), rejectFilesystem); }
          finally { await fs.unlink(file); }
          assert.deepEqual(await fs.readFile(backup), bytes); assert.equal((await fs.lstat(backup, { bigint: true })).ino, original.ino);
        } finally { await fs.rename(backup, file); }
        await fs.link(file, backup);
        try { await assert.rejects(store.loadRawCopy(saved.identity), rejectStage); assert.deepEqual(await fs.readFile(backup), bytes); }
        finally { await fs.unlink(backup); }
        await fs.chmod(file, 0o644);
        try { await assert.rejects(store.loadRawCopy(saved.identity), rejectStage); } finally { await fs.chmod(file, 0o600); }
        const foreign = path.join(directory(baseline), 'unexpected.bin'); await fs.writeFile(foreign, 'private extra must survive', { flag: 'wx', mode: 0o600 });
        const foreignBefore = await fs.lstat(foreign, { bigint: true });
        try {
          await assert.rejects(store.loadRawCopyByOperationId(baseline.operationId), rejectStage);
          assert.equal((await fs.lstat(foreign, { bigint: true })).ino, foreignBefore.ino);
          assert.equal(await fs.readFile(foreign, 'utf8'), 'private extra must survive');
        } finally { await fs.unlink(foreign); }
        assert.equal((await fs.lstat(file, { bigint: true })).ino, original.ino); assert.deepEqual(await fs.readFile(file), bytes);
        assert.deepEqual(await store.loadRawCopy(saved.identity), saved);
      });
      await group('Stage6 captures both raw/native input bytes synchronously before its first Store await', async () => {
        const input = await build(), expected = prepare(input), expectedRaw = Buffer.from(input.rawOriginals[0].originalBytes);
        assert(input.nativeRecords.length > 0); const expectedNative = Buffer.from(input.nativeRecords[0].state.yjsState);
        const pending = store.stageRawCopy(input); input.rawOriginals[0].originalBytes.fill(0); input.nativeRecords[0].state.yjsState.fill(0);
        const saved = await pending; assert.equal(saved.payloadSha256, expected.manifest.payloadSha256);
        assert.deepEqual(Buffer.from(saved.rawOriginals[0].originalBytes), expectedRaw);
        assert.deepEqual(Buffer.from(saved.nativeRecords[0].state.yjsState), expectedNative);
        assert.equal((await store.loadRawCopy(saved.identity)).payloadSha256, expected.manifest.payloadSha256);
        assert.equal(await journal.get(input.operationId), null);
      });
    });
  });
  assert.equal(groups, 6);
  assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-raw-copy-stage-postgres', groups, passed: true, sourcesUnchanged: true,
    scope: 'actual PG18 readonly observation + real FD/private Stage6 Store; no B1/B2/native Raw birth/publication acceptance' }));
}

function catchRawCopyFailure(error: unknown): void {
  const safeCode = code(error);
  console.error(JSON.stringify({ suite: 'workspace-raw-copy-stage-postgres', case: currentCase, name: error instanceof Error ? error.name : 'unknown',
    code: typeof safeCode === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(safeCode) ? safeCode : null,
    frames: error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const found = /\/(app\/lib\/[a-z0-9_./-]+|scripts\/[a-z0-9_./-]+):(\d+):(\d+)\)?$/iu.exec(line);
      return found ? [`${found[1]}:${found[2]}:${found[3]}`] : [];
    }).slice(0, 5) : [] })); process.exitCode = 1;
}
void rawCopyStagePostgresTest().catch(catchRawCopyFailure);
