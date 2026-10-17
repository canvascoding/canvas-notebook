import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { nativeCopyMetadataCompositeDigest, nativeCopyMetadataWitness } from '../app/lib/files/workspace-operation-native-copy-metadata';
import { assertNativeCopyStageManifestDigest, decodeNativeCopyStage, NativeCopyStageDataError, prepareNativeCopyStage,
  type NativeCopyStageManifest } from '../app/lib/files/workspace-operation-native-copy-stage';

// Genuine C1/Yjs fixture and public codecs, with deliberately declared pure
// catalogue/FD facts. Header acceptance confers no SQL/FS/actor authority.
type Mutable<T> = T extends Uint8Array ? T : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const corrupt = (error: unknown) => error instanceof NativeCopyStageDataError && error.code === 'CORRUPT_STAGE';
const tooLarge = (error: unknown) => error instanceof NativeCopyStageDataError && error.code === 'STAGE_TOO_LARGE';
function fixture() {
  const stage = nativeCopyMetadataFixture();
  const input = { operationId: stage.identity.operationId, request: stage.request, plan: stage.plan,
    physical: stage.physical, nativeRecords: stage.nativeRecords };
  const metadata = { version: 1 as const, kind: 'shared-title-copy' as const, planId: stage.plan.planId,
    sourceWorkspaceId: stage.plan.sourceScope.workspaceId, destinationWorkspaceId: stage.plan.destinationScope.workspaceId,
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: stage.plan.planId,
      mappings: stage.plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })) }),
    vacancyScopes: ['keep.md', 'note.md'], exactVacancyPaths: [], sourceRows: [
      { path: 'keep.md', title: null, createdAt: 10, updatedAt: 11 },
      { path: 'note.md', title: 'Shared title', createdAt: 12, updatedAt: 13 }] };
  return { input, prepared: prepareNativeCopyStage({ ...input, metadata }) };
}
function rehash(manifest: Mutable<NativeCopyStageManifest>): void {
  assert.equal(manifest.version, 3); if (manifest.version !== 3) assert.fail('V3 required');
  const body = { ...manifest, version: 2 } as Record<string, unknown>;
  delete body.payloadSha256; delete body.coreV2StageDigest; delete body.metadata;
  manifest.coreV2StageDigest = sha(JSON.stringify(body));
  manifest.payloadSha256 = nativeCopyMetadataCompositeDigest(manifest.coreV2StageDigest, nativeCopyMetadataWitness(manifest.metadata));
}

test('self-consistent foreign mapping/physical headers pass data dispatch but the full V3 decoder rejects them', () => {
  const { prepared } = fixture(), original = clone(prepared.manifest);
  const changes: Array<(value: Mutable<NativeCopyStageManifest>) => void> = [
    value => { assert.equal(value.version, 3); if (value.version === 3) value.metadata.mappingsProof = 'f'.repeat(64); },
    value => { assert.equal(value.version, 3); if (value.version === 3) value.metadata.vacancyScopes = ['foreign.md']; },
    value => { value.physical[0].original.destinationPath = 'foreign.md'; },
    value => { value.physical[0].original.destinationWorkspace.ownerUserId = 'foreign-owner'; },
  ];
  for (const change of changes) {
    const manifest = clone(prepared.manifest); change(manifest); rehash(manifest);
    assertNativeCopyStageManifestDigest(manifest);
    assert.throws(() => decodeNativeCopyStage(manifest, prepared.recordsBytes, manifest.identity), corrupt);
  }
  assert.deepEqual(prepared.manifest, original);
  assert.equal(decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity).version, 3);
});

test('header own-data/title/clock formats reject before an invalid native binary and execute no getters', () => {
  const { prepared } = fixture(); let reads = 0;
  const changes: Array<(value: Mutable<NativeCopyStageManifest>) => void> = [
    value => { assert.equal(value.version, 3); if (value.version === 3) value.metadata.sourceRows[1].title = 'x'.repeat(161); },
    value => { assert.equal(value.version, 3); if (value.version === 3) value.metadata.sourceRows[1].updatedAt = -1; },
    value => { assert.equal(value.version, 3); if (value.version === 3) value.metadata.sourceRows[1].title = 'two  spaces'; },
    value => { assert.equal(value.version, 3); if (value.version === 3) Object.defineProperty(value.metadata.sourceRows[1], 'title',
      { enumerable: true, get() { reads++; return 'Shared title'; } }); },
    value => { assert.equal(value.version, 3); if (value.version === 3) Object.setPrototypeOf(value.metadata, { authority: true }); },
  ];
  for (const [index, change] of changes.entries()) {
    const manifest = clone(prepared.manifest); change(manifest);
    if (index < 3) {
      assert.equal(manifest.version, 3); if (manifest.version !== 3) assert.fail('V3 required');
      // Intentionally forge a hash-consistent invalid scalar envelope without
      // the strict witness constructor, so a stale digest cannot explain it.
      const metadataWitness = { version: 1, kind: 'shared-title-copy', snapshotProof: proof(manifest.metadata),
        sourceRowCount: manifest.metadata.sourceRows.length,
        copiedTitleCount: manifest.metadata.sourceRows.filter(row => row.title !== null).length };
      manifest.payloadSha256 = proof({ version: 3, kind: 'native-copy-stage',
        coreV2StageDigest: manifest.coreV2StageDigest, metadataWitness });
    }
    assert.throws(() => assertNativeCopyStageManifestDigest(manifest), corrupt);
    assert.throws(() => decodeNativeCopyStage(manifest, Buffer.alloc(0), prepared.manifest.identity), corrupt);
  }
  assert.equal(reads, 0);
});

test('header enforces 2048 rows and exact 1MiB compact metadata before native binary decoding', () => {
  const { prepared } = fixture(), manifest = clone(prepared.manifest);
  assert.equal(manifest.version, 3); if (manifest.version !== 3) assert.fail('V3 required');
  // Stored-format/budget fixture, explicitly not an actual 2048-document clone.
  manifest.metadata.sourceRows = Array.from({ length: 2048 }, (_, index) => ({
    path: `rows/${String(index).padStart(4, '0')}/${'x'.repeat(350)}`, title: null, createdAt: 0, updatedAt: 1 }));
  let remaining = 1024 ** 2 - Buffer.byteLength(JSON.stringify(manifest.metadata)); assert(remaining > 0);
  for (const row of manifest.metadata.sourceRows) {
    const count = Math.min(4096 - Buffer.byteLength(row.path), remaining); row.path += 'x'.repeat(count); remaining -= count;
    if (!remaining) break;
  }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(manifest.metadata)), 1024 ** 2);
  rehash(manifest); assertNativeCopyStageManifestDigest(manifest);
  assert.throws(() => decodeNativeCopyStage(manifest, Buffer.alloc(0), prepared.manifest.identity), corrupt);
  const extraByte = clone(manifest); assert.equal(extraByte.version, 3);
  if (extraByte.version !== 3) assert.fail('V3 required');
  extraByte.metadata.sourceRows[2047].path += 'x';
  assert.throws(() => assertNativeCopyStageManifestDigest(extraByte), tooLarge);
  assert.throws(() => decodeNativeCopyStage(extraByte, Buffer.alloc(0), prepared.manifest.identity), tooLarge);
  const extraRow = clone(manifest); assert.equal(extraRow.version, 3);
  if (extraRow.version !== 3) assert.fail('V3 required');
  extraRow.metadata.sourceRows.push({ path: 'rows/9999.md', title: null, createdAt: 0, updatedAt: 1 });
  assert.throws(() => assertNativeCopyStageManifestDigest(extraRow), tooLarge);
  assert.throws(() => decodeNativeCopyStage(extraRow, Buffer.alloc(0), prepared.manifest.identity), tooLarge);
});

test('the title-neutral V2 header/full roundtrip preserves its exact manifest and native payload bytes', () => {
  const { input } = fixture(), prepared = prepareNativeCopyStage(input);
  assert.equal(prepared.manifest.version, 2);
  const manifestBefore = Buffer.from(prepared.manifestBytes), binaryBefore = Buffer.from(prepared.recordsBytes);
  assertNativeCopyStageManifestDigest(prepared.manifest);
  const decoded = decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
  assert.equal(decoded.version, 2); assert.equal(Object.hasOwn(decoded, 'metadata'), false);
  const repeated = prepareNativeCopyStage({ operationId: decoded.identity.operationId, request: decoded.request,
    plan: decoded.plan, physical: decoded.physical, nativeRecords: decoded.nativeRecords });
  assert.deepEqual(repeated.manifestBytes, manifestBefore); assert.deepEqual(repeated.recordsBytes, binaryBefore);
  assert.deepEqual(prepared.manifestBytes, manifestBefore); assert.deepEqual(prepared.recordsBytes, binaryBefore);
});
