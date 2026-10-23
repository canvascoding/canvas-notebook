import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';
import { decodeNativeCopyMetadataSnapshot, nativeCopyMetadataWitness, nativeCopyMetadataCompositeDigest,
  nativeCopyMetadataCompletionWitness, decodeNativeCopyMetadataCompletionWitness, NativeCopyMetadataError,
  type NativeCopyMetadataSnapshot } from '../app/lib/files/workspace-operation-native-copy-metadata';
import { prepareNativeCopyStage, decodeNativeCopyStage, NativeCopyStageDataError } from '../app/lib/files/workspace-operation-native-copy-stage';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';

const invalid = (error: unknown) => error instanceof NativeCopyMetadataError && error.code === 'NATIVE_COPY_METADATA_INVALID';
const tooLarge = (error: unknown) => error instanceof NativeCopyMetadataError && error.code === 'NATIVE_COPY_METADATA_TOO_LARGE';
function originalMetadata(stage = nativeCopyMetadataFixture()): NativeCopyMetadataSnapshot {
  return { version: 1, kind: 'shared-title-copy', planId: stage.plan.planId,
    sourceWorkspaceId: stage.plan.sourceScope.workspaceId, destinationWorkspaceId: stage.plan.destinationScope.workspaceId,
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: stage.plan.planId,
      mappings: stage.plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })) }),
    vacancyScopes: ['keep.md', 'note.md'], exactVacancyPaths: [],
    sourceRows: [{ path: 'keep.md', title: null, createdAt: 100, updatedAt: 102 },
      { path: 'note.md', title: 'DB title, not YAML', createdAt: 101, updatedAt: 103 }] };
}
function ownedSnapshot() {
  const stage = nativeCopyMetadataFixture(); return { stage, snapshot: originalMetadata(stage), context: { plan: stage.plan, physical: stage.physical } };
}
test('full metadata snapshot is detached, deeply frozen, and binds NULL rows and original timestamps', () => {
  const { snapshot, context } = ownedSnapshot(), result = decodeNativeCopyMetadataSnapshot(snapshot, context);
  assert.deepEqual(result, snapshot); assert.notEqual(result, snapshot); assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.sourceRows)); assert(Object.isFrozen(result.sourceRows[0]));
  (snapshot.sourceRows[1] as { title: string }).title = 'later source';
  assert.equal(result.sourceRows[1].title, 'DB title, not YAML');
  assert.deepEqual(result.sourceRows[0], { path: 'keep.md', title: null, createdAt: 100, updatedAt: 102 });
  const witness = nativeCopyMetadataWitness(result);
  assert.equal(witness.sourceRowCount, 2); assert.equal(witness.copiedTitleCount, 1); assert.equal(witness.snapshotProof, proof(result));
});
for (const field of ['planId', 'sourceWorkspaceId', 'destinationWorkspaceId', 'mappingsProof', 'vacancyScopes', 'exactVacancyPaths'] as const) {
  test(`snapshot rejects a different original ${field}`, () => {
    const { snapshot, context } = ownedSnapshot(), changed = structuredClone(snapshot) as unknown as Record<string, unknown>;
    changed[field] = Array.isArray(changed[field]) ? ['unrelated'] : 'a'.repeat(64);
    assert.throws(() => decodeNativeCopyMetadataSnapshot(changed, context), invalid);
  });
}
test('rows must be original mapped paths, unique and UTF8 sorted; empty title is not NULL', () => {
  const { snapshot, context } = ownedSnapshot();
  for (const sourceRows of [[...snapshot.sourceRows].reverse(), [snapshot.sourceRows[0], snapshot.sourceRows[0]],
    [{ ...snapshot.sourceRows[0], path: 'foreign.md' }], [{ ...snapshot.sourceRows[0], title: '' }]]) {
    assert.throws(() => decodeNativeCopyMetadataSnapshot({ ...snapshot, sourceRows }, context), invalid);
  }
});
test('snapshot rejects accessor/extra/inherited data without executing an accessor', () => {
  const { snapshot, context } = ownedSnapshot(); let reads = 0;
  const accessor = { ...snapshot }; Object.defineProperty(accessor, 'planId', { enumerable: true, get() { reads++; return snapshot.planId; } });
  for (const input of [accessor, { ...snapshot, authority: true }, Object.assign(Object.create({ inherited: true }), snapshot)]) {
    assert.throws(() => decodeNativeCopyMetadataSnapshot(input, context), invalid);
  }
  assert.equal(reads, 0);
});
test('title limits preserve the existing 160 UTF16-unit semantics, normalized strings and valid UTF8', () => {
  const { snapshot, context } = ownedSnapshot();
  for (const title of ['x'.repeat(160), '界'.repeat(160), '🦊'.repeat(80)]) {
    const decoded = decodeNativeCopyMetadataSnapshot({ ...snapshot, sourceRows: [{ ...snapshot.sourceRows[1], title }] }, context);
    assert.equal(decoded.sourceRows[0].title, title);
  }
  for (const title of ['x'.repeat(161), '🦊'.repeat(80) + 'x', ' not normalized', 'two  spaces', 'line\nbreak', '\ud800']) {
    assert.throws(() => decodeNativeCopyMetadataSnapshot({ ...snapshot, sourceRows: [{ ...snapshot.sourceRows[1], title }] }, context), invalid);
  }
});
test('timestamps are exact safe nonnegative integers, including original zero, never publication estimates', () => {
  const { snapshot, context } = ownedSnapshot();
  assert.equal(decodeNativeCopyMetadataSnapshot({ ...snapshot, sourceRows: [{ ...snapshot.sourceRows[0], createdAt: 0 }] }, context).sourceRows[0].createdAt, 0);
  for (const value of [-1, -0, 0.1, Number.MAX_SAFE_INTEGER, Infinity, '100']) {
    assert.throws(() => decodeNativeCopyMetadataSnapshot({ ...snapshot, sourceRows: [{ ...snapshot.sourceRows[0], updatedAt: value }] }, context), invalid);
  }
});
test('stored-format witness accepts exactly 2048 rows and refuses 2049; this is no 2048-document clone claim', () => {
  const snapshot = originalMetadata(), sourceRows = Array.from({ length: 2048 }, (_, index) => ({ path: `rows/${String(index).padStart(4, '0')}.md`, title: null, createdAt: 0, updatedAt: 1 }));
  assert.equal(nativeCopyMetadataWitness({ ...snapshot, sourceRows }).sourceRowCount, 2048);
  assert.throws(() => nativeCopyMetadataWitness({ ...snapshot, sourceRows: [...sourceRows, { ...sourceRows[0], path: 'rows/9999.md' }] }), tooLarge);
});
test('stored-format byte budget accepts exactly 1MiB and refuses the next UTF8 byte before any IO', () => {
  const base = originalMetadata(), rows = Array.from({ length: 2048 }, (_, index) => ({ path: `rows/${String(index).padStart(4, '0')}/${'x'.repeat(350)}`, title: null, createdAt: 0, updatedAt: 1 }));
  const value = { ...base, sourceRows: rows }; const missing = 1024 ** 2 - Buffer.byteLength(JSON.stringify(value));
  assert(missing > 0); let remaining = missing;
  for (const row of rows) { const added = Math.min(4096 - Buffer.byteLength(row.path), remaining); row.path += 'x'.repeat(added); remaining -= added; if (!remaining) break; }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(value)), 1024 ** 2);
  assert.equal(nativeCopyMetadataWitness(value).sourceRowCount, 2048);
  rows[rows.length - 1].path += 'x'; assert.throws(() => nativeCopyMetadataWitness(value), tooLarge);
});
test('composite digest binds full original metadata and immutable V2 core separately', () => {
  const snapshot = originalMetadata(), core = '1'.repeat(64), witness = nativeCopyMetadataWitness(snapshot);
  const digest = nativeCopyMetadataCompositeDigest(core, witness);
  assert.equal(digest, proof({ version: 3, kind: 'native-copy-stage', coreV2StageDigest: core, metadataWitness: witness }));
  const changed = { ...snapshot, sourceRows: snapshot.sourceRows.map(row => ({ ...row, updatedAt: row.updatedAt + 1 })) };
  assert.notEqual(nativeCopyMetadataCompositeDigest(core, nativeCopyMetadataWitness(changed)), digest);
  assert.notEqual(nativeCopyMetadataCompositeDigest('2'.repeat(64), witness), digest);
  assert.throws(() => nativeCopyMetadataCompositeDigest(core, { ...witness, copiedTitleCount: 3 }), invalid);
});
test('completion witness binds exact C3 birth time, not later publication time; corrupt proofs and shapes fail', () => {
  const snapshot = originalMetadata(), witness = nativeCopyMetadataCompletionWitness(snapshot, 1234567);
  assert.equal(witness.copyCreatedAt, 1234567); assert.deepEqual(decodeNativeCopyMetadataCompletionWitness(witness), witness);
  assert.notDeepEqual(nativeCopyMetadataCompletionWitness(snapshot, 1234568), witness);
  for (const input of [{ ...witness, copyCreatedAt: 1234568 }, { ...witness, snapshotProof: 'f'.repeat(64) },
    { ...witness, afterIntentProof: 'f'.repeat(64) }, { ...witness, copiedTitleCount: 9 }, { ...witness, extra: true }]) {
    assert.throws(() => decodeNativeCopyMetadataCompletionWitness(input), invalid);
  }
  for (const clock of [0, -1, -0, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => nativeCopyMetadataCompletionWitness(snapshot, clock), invalid);
});
test('explicit title-neutral V2 roundtrips without metadata while V3 binds a distinct composite Stage', () => {
  const { stage, snapshot } = ownedSnapshot();
  const input = { operationId: stage.identity.operationId, request: stage.request, plan: stage.plan, physical: stage.physical, nativeRecords: stage.nativeRecords };
  const v2 = prepareNativeCopyStage(input); assert.equal(v2.manifest.version, 2); assert.deepEqual(decodeNativeCopyStage(v2.manifest, v2.recordsBytes, v2.manifest.identity), stage);
  assert.equal(Object.hasOwn(v2.manifest, 'metadata'), false); assert.equal(Object.hasOwn(v2.manifest, 'coreV2StageDigest'), false);
  const v3 = prepareNativeCopyStage({ ...input, metadata: snapshot }); assert.equal(v3.manifest.version, 3);
  const restored = decodeNativeCopyStage(v3.manifest, v3.recordsBytes, v3.manifest.identity); assert.equal(restored.version, 3);
  if (restored.version !== 3) assert.fail('V3 required');
  assert.equal(restored.coreV2StageDigest, v2.manifest.payloadSha256); assert.deepEqual(restored.metadata, snapshot);
  assert.equal(restored.payloadSha256, nativeCopyMetadataCompositeDigest(restored.coreV2StageDigest, nativeCopyMetadataWitness(snapshot)));
  for (const field of ['metadata', 'coreV2StageDigest']) {
    const changed = structuredClone(v3.manifest) as unknown as Record<string, unknown>;
    changed[field] = field === 'metadata' ? { ...snapshot, sourceRows: [] } : 'f'.repeat(64);
    assert.throws(() => decodeNativeCopyStage(changed, v3.recordsBytes, v3.manifest.identity));
  }
});

test('null stage input and explicit metadata:null stay normalized strict Stage errors, never silently V2', () => {
  const stage = nativeCopyMetadataFixture();
  const input = { operationId: stage.identity.operationId, request: stage.request, plan: stage.plan, physical: stage.physical, nativeRecords: stage.nativeRecords };
  const original = prepareNativeCopyStage(input);
  for (const value of [null, { ...input, metadata: null }]) assert.throws(() => prepareNativeCopyStage(value as never),
    error => error instanceof NativeCopyStageDataError && error.code === 'STAGE_CONFLICT');
  for (const value of [null, { ...original.manifest, version: 3, coreV2StageDigest: original.manifest.payloadSha256, metadata: null }]) {
    assert.throws(() => decodeNativeCopyStage(value, original.recordsBytes, original.manifest.identity),
      error => error instanceof NativeCopyStageDataError && error.code === 'CORRUPT_STAGE');
  }
});
