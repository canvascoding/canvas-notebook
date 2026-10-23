import assert from 'node:assert/strict';
import { rawCopyPlanningFixture } from './workspace-operation-raw-copy-planning-test';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { PREPARED_PATH_COPY_LIMITS } from '../app/lib/filesystem/prepared-workspace-path-copy-contract';
import { serializeNativeRecoveryPayload } from '../app/lib/collaboration/native-document-recovery';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { NativeCopyStageDataError } from '../app/lib/files/workspace-operation-native-copy-stage';
import { prepareRawCopyStage, decodeRawCopyStage, assertRawCopyStageManifestDigest, decodeManagedCopyStage,
  MANAGED_COPY_RAW_ORIGINALS_LIMIT, type WorkspaceOperationRawCopyStageInput } from '../app/lib/files/workspace-operation-managed-copy-stage';

/** Shared real parser/compiler fixture plus explicitly modeled FD observations.
 * No filesystem operation, SQL connection, current permission or publication
 * is asserted by these synthetic mechanical identity values. */
export function rawCopyStageFixture(): WorkspaceOperationRawCopyStageInput {
  const fixture = rawCopyPlanningFixture(), plan = fixture.plan;
  const physical = plan.selections.map((selection, index) => {
    const inventory = fixture.files.find(file => file.path === selection.sourcePath); assert(inventory);
    const identity = { device: '1', inode: String(100 + index), mode: 0o100600, uid: 1, gid: 1, linkCount: '1',
      size: String(inventory.physical.byteLength), birthtimeNs: '100000000', mtimeNs: '100000000', ctimeNs: '100000000' };
    const root = { ...identity, inode: '10', mode: 0o40700, size: '4096' };
    return { selectionIndex: index, original: { version: 3 as const, sourceWorkspace: plan.sourceScope,
      destinationWorkspace: plan.destinationScope, ...selection, budget: PREPARED_PATH_COPY_LIMITS, projectionPaths: [],
      sourceProjectionPolicy: 'provider-derived-files-v3' as const, derivedFiles: [], filesystem: {
        sourceRoot: { resolvedPath: plan.sourceScope.rootPath, identity: root },
        destinationRoot: { resolvedPath: plan.destinationScope.rootPath, identity: { ...root, inode: '20' } },
        sourceParents: { directories: [], missingPrefix: null }, destinationParents: { directories: [], missingPrefix: null } },
      source: { kind: 'regular_file' as const, identity, sha256: inventory.physical.byteHash },
      staging: { relativePath: `.canvas-create-00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}.tmp`,
        identity: { ...root, inode: String(300 + index) }, payload: { kind: 'regular_file' as const,
          identity: { ...identity, inode: String(600 + index) }, sha256: inventory.physical.byteHash } } } };
  });
  const mappings = plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath }));
  return { operationId: 'raw-stage-fixture-00000001', plan, request: { kind: 'copy', selections: plan.selections,
    origin: captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'raw-owner', actorId: 'raw-owner', sessionId: 'raw-original-session' },
      sourceWorkspace: fixture.workspaces[0], destinationWorkspace: fixture.workspaces[1] }) },
    physical, nativeRecords: [], sceneRecords: [], sceneAssets: [],
    rawOriginals: plan.rawImportRequirements.map(requirement => fixture.files.find(file => file.path === requirement.sourcePath)!),
    metadata: { version: 1, kind: 'shared-title-copy', planId: plan.planId, sourceWorkspaceId: plan.sourceScope.workspaceId,
      destinationWorkspaceId: plan.destinationScope.workspaceId, mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: plan.planId, mappings }),
      vacancyScopes: plan.selections.map(selection => selection.destinationPath).sort(), exactVacancyPaths: [], sourceRows: [] } };
}

/** Pure codec regressions over a supplied genuine-parser Plan5/FD-data fixture.
 * This deliberately creates no alternate harness and does not claim SQL/FD
 * authority. Root can call it with the actual pre-B1 Stage6 fixture input.
 * Require two different, nonempty raw sources so order/duplicate cases execute. */
export function rawCopyStageTest(input: WorkspaceOperationRawCopyStageInput = rawCopyStageFixture()): void {
  assert(input.rawOriginals.length >= 2);
  assert.notEqual(input.rawOriginals[0].path, input.rawOriginals[1].path);
  assert(input.rawOriginals[0].originalBytes.length > 0);
  const original = structuredClone(input), prepared = prepareRawCopyStage(input);
  const payloads = { recordsBytes: prepared.recordsBytes, sceneRecordsBytes: prepared.sceneRecordsBytes,
    sceneAssetsBytes: prepared.sceneAssetsBytes, rawOriginalsBytes: prepared.rawOriginalsBytes };
  const restored = decodeRawCopyStage(prepared.manifest, payloads, prepared.manifest.identity);
  assert.equal(restored.version, 6);
  assert.deepEqual(restored.rawOriginals, input.rawOriginals);
  assert.deepEqual(serializeNativeRecoveryPayload(restored.nativeRecords), prepared.recordsBytes);
  assert.deepEqual(restored.sceneRecords, input.sceneRecords);
  assert.deepEqual(restored.sceneAssets, input.sceneAssets);
  assert.deepEqual(input, original);
  assert.equal(prepared.manifest.rawOriginals.file, 'raw-originals.bin');
  assert.equal(prepared.manifest.rawOriginals.count, input.plan.rawImportRequirements.length);
  assert(Object.isFrozen(restored)); assert(Object.isFrozen(restored.rawOriginals));
  const repeated = prepareRawCopyStage(structuredClone(input));
  assert.deepEqual(repeated.manifestBytes, prepared.manifestBytes);
  assert.deepEqual(repeated.rawOriginalsBytes, prepared.rawOriginalsBytes);
  assertRawCopyStageManifestDigest(prepared.manifest);
  let passed = 1;

  // Rehashing the whole manifest cannot validate a different filename, source,
  // FD identity, count, order, duplicated requirement or noncontiguous offset.
  for (const changed of [
    { ...prepared.manifest.rawOriginals, file: '../raw-originals.bin' },
    { ...prepared.manifest.rawOriginals, count: prepared.manifest.rawOriginals.count + 1 },
    { ...prepared.manifest.rawOriginals, entries: [...prepared.manifest.rawOriginals.entries].reverse() },
    { ...prepared.manifest.rawOriginals, entries: prepared.manifest.rawOriginals.entries.map((entry, index) => index === 1
      ? { ...entry, requirementKey: prepared.manifest.rawOriginals.entries[0].requirementKey } : entry) },
    { ...prepared.manifest.rawOriginals, entries: prepared.manifest.rawOriginals.entries.map((entry, index) => index === 0
      ? { ...entry, offset: entry.offset + 1 } : entry) },
    { ...prepared.manifest.rawOriginals, entries: prepared.manifest.rawOriginals.entries.map((entry, index) => index === 0
      ? { ...entry, filesystemIdentity: '1:999:1:1:1' } : entry) },
    { ...prepared.manifest.rawOriginals, entries: prepared.manifest.rawOriginals.entries.map((entry, index) => index === 0
      ? { ...entry, sourcePath: 'different-original.md' } : entry) },
  ]) {
    const { payloadSha256: _old, ...body } = { ...prepared.manifest, rawOriginals: changed };
    const forged = { ...body, payloadSha256: proof(body) };
    assert.throws(() => assertRawCopyStageManifestDigest(forged), NativeCopyStageDataError);
  }
  passed++;

  // Sidecar hash and exact size are independent of the JSON proof. Original
  // file bytes are not reconstructed from a later target projection/state.
  const corrupted = Buffer.from(prepared.rawOriginalsBytes); corrupted[0] ^= 1;
  assert.throws(() => decodeRawCopyStage(prepared.manifest, { ...payloads, rawOriginalsBytes: corrupted }, prepared.manifest.identity), NativeCopyStageDataError);
  assert.throws(() => decodeRawCopyStage(prepared.manifest, { ...payloads, rawOriginalsBytes: Buffer.concat([prepared.rawOriginalsBytes, Buffer.from([0])]) }, prepared.manifest.identity), NativeCopyStageDataError);
  assert.throws(() => decodeRawCopyStage(prepared.manifest, { ...payloads, rawOriginalsBytes: prepared.rawOriginalsBytes.subarray(1) }, prepared.manifest.identity), NativeCopyStageDataError);
  passed++;

  const changedBytes = Uint8Array.from(input.rawOriginals[0].originalBytes); changedBytes[0] ^= 1;
  assert.throws(() => prepareRawCopyStage({ ...input, rawOriginals: input.rawOriginals.map((entry, index) => index === 0
    ? { ...entry, originalBytes: changedBytes } : entry) }), NativeCopyStageDataError);
  assert.throws(() => prepareRawCopyStage({ ...input, rawOriginals: [...input.rawOriginals].reverse() }), NativeCopyStageDataError);
  assert.throws(() => prepareRawCopyStage({ ...input, rawOriginals: input.rawOriginals.slice(1) }), NativeCopyStageDataError);
  assert.throws(() => prepareRawCopyStage({ ...input, rawOriginals: input.rawOriginals.map((entry, index) => index === 0
    ? { ...entry, workspaceId: 'different-workspace' } : entry) }), NativeCopyStageDataError);
  passed++;

  // Even a self-consistent mechanical source/payload hash cannot replace the
  // original Raw inventory captured in the full SourceEvidence4.
  const mechanical = structuredClone(input), sourcePath = input.rawOriginals[0].path;
  const selected = mechanical.physical.find(value => sourcePath === value.original.sourcePath || sourcePath.startsWith(value.original.sourcePath + '/'));
  assert(selected); assert(selected.original.staging);
  const relative = sourcePath.slice(selected.original.sourcePath.length).replace(/^\//u, '');
  const sourceNode = selected.original.source.kind === 'directory'
    ? selected.original.source.entries.find(entry => entry.relativePath === relative) : selected.original.source;
  const targetNode = selected.original.staging.payload.kind === 'directory'
    ? selected.original.staging.payload.entries.find(entry => entry.relativePath === relative) : selected.original.staging.payload;
  assert(sourceNode?.kind === 'regular_file'); assert(targetNode?.kind === 'regular_file');
  Object.defineProperty(sourceNode, 'sha256', { enumerable: true, value: '0'.repeat(64) });
  Object.defineProperty(targetNode, 'sha256', { enumerable: true, value: '0'.repeat(64) });
  assert.throws(() => prepareRawCopyStage(mechanical), NativeCopyStageDataError);
  passed++;

  // All input callbacks are hostile data; none may execute during rejection.
  let callbacks = 0;
  const getterInput = structuredClone(input);
  Object.defineProperty(getterInput, 'rawOriginals', { enumerable: true, get() { callbacks++; throw new Error('getter executed'); } });
  assert.throws(() => prepareRawCopyStage(getterInput), NativeCopyStageDataError);
  const proxyInput = new Proxy(structuredClone(input), { get() { callbacks++; throw new Error('proxy executed'); },
    ownKeys() { callbacks++; throw new Error('proxy executed'); }, getPrototypeOf() { callbacks++; throw new Error('proxy executed'); } });
  assert.throws(() => prepareRawCopyStage(proxyInput), NativeCopyStageDataError);
  const nested = structuredClone(input);
  Object.defineProperty(nested.rawOriginals[0].authority, 'toJSON', { enumerable: true, value() { callbacks++; throw new Error('toJSON executed'); } });
  assert.throws(() => prepareRawCopyStage(nested), NativeCopyStageDataError);
  assert.equal(callbacks, 0);
  passed++;

  // Budgets and format discriminators are checked before a binary file read.
  const { payloadSha256: _old, ...oversized } = { ...prepared.manifest,
    rawOriginals: { ...prepared.manifest.rawOriginals, sizeBytes: MANAGED_COPY_RAW_ORIGINALS_LIMIT + 1 } };
  assert.throws(() => assertRawCopyStageManifestDigest({ ...oversized, payloadSha256: proof(oversized) }), NativeCopyStageDataError);
  assert.throws(() => decodeManagedCopyStage(prepared.manifest, { recordsBytes: prepared.recordsBytes,
    sceneRecordsBytes: prepared.sceneRecordsBytes, sceneAssetsBytes: prepared.sceneAssetsBytes }, prepared.manifest.identity), NativeCopyStageDataError);
  assert.throws(() => decodeRawCopyStage({ ...prepared.manifest, version: 5 }, payloads, prepared.manifest.identity), NativeCopyStageDataError);
  assert.deepEqual(input, original);
  passed++;
  console.log(`PASS raw-copy-stage ${passed} pure codec families (supplied parser/FD-data fixture; no SQL or publication claim)`);
}
