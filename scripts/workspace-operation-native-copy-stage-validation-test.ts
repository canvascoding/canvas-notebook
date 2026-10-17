import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { serializeNativeRecoveryPayload } from '../app/lib/collaboration/native-document-recovery';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { computeWorkspaceOperationNativeCopyPlanId, decodeWorkspaceOperationNativeCopyPlan, withNativeCopyPlanValidation,
  WorkspaceOperationNativeCopyPlanError } from '../app/lib/files/workspace-operation-native-copy-plan';
import { assertNativeCopyStageManifestDigest, decodeNativeCopyStage, NativeCopyStageDataError, prepareNativeCopyStage,
  type NativeCopyStageManifest, type WorkspaceOperationNativeCopyStageInput } from '../app/lib/files/workspace-operation-native-copy-stage';
import { nativeCopyMetadataCompositeDigest, nativeCopyMetadataWitness,
  type NativeCopyMetadataSnapshot } from '../app/lib/files/workspace-operation-native-copy-metadata';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';

// Actual C1, Yjs and Stage codecs. The helper's declared catalogue/FD facts
// confer no current SQL, principal, filesystem, publication or COMMIT authority.
type Mutable<T> = T extends Uint8Array ? T : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const invalidStage = (error: unknown) => error instanceof NativeCopyStageDataError && error.code === 'STAGE_CONFLICT';
const corruptStage = (error: unknown) => error instanceof NativeCopyStageDataError && error.code === 'CORRUPT_STAGE';
const tooLarge = (error: unknown) => error instanceof NativeCopyStageDataError && error.code === 'STAGE_TOO_LARGE';
const invalidPlan = (error: unknown) => error instanceof WorkspaceOperationNativeCopyPlanError && error.code === 'NATIVE_COPY_PLAN_INVALID';

function fixture(version: 2 | 3 = 3, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks') {
  const stage = nativeCopyMetadataFixture(representation);
  const input: Mutable<WorkspaceOperationNativeCopyStageInput> = clone({ operationId: stage.identity.operationId,
    request: stage.request, plan: stage.plan, physical: stage.physical, nativeRecords: stage.nativeRecords });
  if (version === 3) input.metadata = { version: 1, kind: 'shared-title-copy', planId: input.plan.planId,
    sourceWorkspaceId: input.plan.sourceScope.workspaceId, destinationWorkspaceId: input.plan.destinationScope.workspaceId,
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: input.plan.planId,
      mappings: input.plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })) }),
    vacancyScopes: ['keep.md', 'note.md'], exactVacancyPaths: [],
    sourceRows: [{ path: 'keep.md', title: null, createdAt: 10, updatedAt: 11 },
      { path: 'note.md', title: 'Original shared title', createdAt: 12, updatedAt: 13 }] };
  return input;
}

/** Deliberately recompute all public envelope digests: hash consistency alone
 * must never substitute for original C1/native-record/physical validation. */
function rehash(manifest: Mutable<NativeCopyStageManifest>): void {
  if (manifest.version === 2) {
    const body = { ...manifest } as Record<string, unknown>; delete body.payloadSha256;
    manifest.payloadSha256 = sha(JSON.stringify(body)); return;
  }
  const body = { ...manifest, version: 2 } as Record<string, unknown>;
  delete body.payloadSha256; delete body.coreV2StageDigest; delete body.metadata;
  manifest.coreV2StageDigest = sha(JSON.stringify(body));
  manifest.payloadSha256 = nativeCopyMetadataCompositeDigest(manifest.coreV2StageDigest, nativeCopyMetadataWitness(manifest.metadata));
}
function rebindMetadata(input: Mutable<WorkspaceOperationNativeCopyStageInput>): void {
  if (!input.metadata) return;
  input.metadata.planId = input.plan.planId;
  input.metadata.mappingsProof = proof({ version: 1, kind: 'native-copy-title-mappings', planId: input.plan.planId,
    mappings: input.plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })) });
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: V2 and V3 retain the actual original native bytes and independently detached output`, async () => {
  for (const version of [2, 3] as const) {
    const input = fixture(version, representation), before = clone(input), prepared = prepareNativeCopyStage(input);
    assert.equal(prepared.manifest.version, version); assert.deepEqual(input, before);
    assertNativeCopyStageManifestDigest(prepared.manifest);
    const first = decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
    await Promise.resolve();
    const second = decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
    assert.notEqual(first, second); assert.deepEqual(first, second); assert(Object.isFrozen(first.plan));
    assert.deepEqual(first.nativeRecords, before.nativeRecords);
    assert.notEqual(first.nativeRecords[0].state.yjsState, second.nativeRecords[0].state.yjsState);
    input.nativeRecords[0].state.yjsState.fill(0);
    input.plan.selections[0].destinationPath = 'later.md';
    if (input.metadata) input.metadata.sourceRows[1].title = 'Later title';
    assert.deepEqual(first.nativeRecords, before.nativeRecords);
    assert.equal(first.plan.selections[0].destinationPath, before.plan.selections[0].destinationPath);
    if (first.version === 3) assert.equal(first.metadata.sourceRows[1].title, 'Original shared title');
    assert.deepEqual(decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity), second);
  }
});

for (const version of [2, 3] as const) {
  test(`V${version}: a previously accepted raw plan cannot retain validation after later mutation`, () => {
    for (const field of ['compilerPlanProof', 'finalGraphProof'] as const) {
      const input = fixture(version); prepareNativeCopyStage(input);
      input.plan[field] = 'f'.repeat(64);
      input.plan.planId = computeWorkspaceOperationNativeCopyPlanId(input.plan); rebindMetadata(input);
      // The historical decoder accepts these opaque claims. The actual bytes
      // replay in the Stage still has to refute the newly rehashed compiler.
      assert.equal(decodeWorkspaceOperationNativeCopyPlan(input.plan).planId, input.plan.planId);
      assert.throws(() => prepareNativeCopyStage(input), invalidStage, field);
    }
  });

  test(`V${version}: rehashed compiler/final-graph manifest claims still require replay of original native bytes`, () => {
    const input = fixture(version), prepared = prepareNativeCopyStage(input);
    for (const field of ['compilerPlanProof', 'finalGraphProof'] as const) {
      const changed = clone(prepared.manifest); changed.plan[field] = 'f'.repeat(64);
      changed.plan.planId = computeWorkspaceOperationNativeCopyPlanId(changed.plan);
      changed.identity.planId = changed.plan.planId;
      if (changed.version === 3) {
        changed.metadata.planId = changed.plan.planId;
        changed.metadata.mappingsProof = proof({ version: 1, kind: 'native-copy-title-mappings', planId: changed.plan.planId,
          mappings: changed.plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })) });
      }
      rehash(changed); assertNativeCopyStageManifestDigest(changed);
      assert.throws(() => decodeNativeCopyStage(changed, prepared.recordsBytes, changed.identity), corruptStage, field);
    }
  });

  test(`V${version}: equal planId never admits foreign physical paths, scopes or native omission membership`, () => {
    const input = fixture(version), prepared = prepareNativeCopyStage(input);
    const changes: Array<(value: Mutable<WorkspaceOperationNativeCopyStageInput>) => void> = [
      value => { value.physical[0].original.destinationPath = 'foreign.md'; },
      value => { value.physical[0].original.sourceWorkspace.ownerUserId = 'foreign-owner'; },
      value => { value.physical[0].original.destinationWorkspace.rootPath = '/foreign/root'; },
      value => { value.physical[0].original.projectionPaths = []; },
      value => { value.physical[0].selectionIndex = 1; },
    ];
    for (const change of changes) {
      const modified = clone(input); change(modified); assert.equal(modified.plan.planId, prepared.manifest.plan.planId);
      assert.throws(() => prepareNativeCopyStage(modified), invalidStage);
      const manifest = clone(prepared.manifest); manifest.physical = clone(modified.physical); rehash(manifest);
      assert.throws(() => decodeNativeCopyStage(manifest, prepared.recordsBytes, manifest.identity), corruptStage);
    }
  });

  test(`V${version}: all source and independent destination records remain required after an earlier successful validation`, () => {
    const input = fixture(version); prepareNativeCopyStage(input);
    const changes: Array<(value: Mutable<WorkspaceOperationNativeCopyStageInput>) => void> = [
      value => { value.nativeRecords.shift(); }, value => { value.nativeRecords.pop(); },
      value => { value.nativeRecords.push(clone(value.nativeRecords[0])); },
      value => { value.nativeRecords[0].lineageId = 'foreign-lineage'; },
      value => { value.nativeRecords[2].state.workspaceId = value.plan.sourceScope.workspaceId; },
    ];
    for (const change of changes) { const modified = clone(input); change(modified); assert.throws(() => prepareNativeCopyStage(modified), invalidStage); }
  });

  test(`V${version}: every record binary/vector mutation is rejected and a restored input can be freshly validated`, () => {
    const input = fixture(version), original = prepareNativeCopyStage(input);
    for (const record of input.nativeRecords) for (const field of ['yjsState', 'stateVector'] as const) {
      const bytes = record.state[field], saved = bytes[0]; bytes[0] ^= 1;
      assert.throws(() => prepareNativeCopyStage(input), invalidStage);
      bytes[0] = saved;
      assert.equal(prepareNativeCopyStage(input).manifest.payloadSha256, original.manifest.payloadSha256);
    }
  });

  test(`V${version}: self-consistent recovery-container metadata does not make changed original clocks valid`, () => {
    const input = fixture(version), prepared = prepareNativeCopyStage(input), records = clone(input.nativeRecords);
    records[0].state.documentSequence += 1;
    const bytes = serializeNativeRecoveryPayload(records), manifest = clone(prepared.manifest);
    manifest.records.sizeBytes = bytes.length; manifest.records.sha256 = sha(bytes); rehash(manifest);
    assertNativeCopyStageManifestDigest(manifest);
    assert.throws(() => decodeNativeCopyStage(manifest, bytes, manifest.identity), corruptStage);
  });
}

test('metadata and physical bindings are freshly checked even when an identical frozen plan was already decoded', () => {
  const input = fixture(), plan = decodeWorkspaceOperationNativeCopyPlan(input.plan);
  const first = prepareNativeCopyStage({ ...input, plan }); assert.equal(first.manifest.version, 3);
  for (const field of ['planId', 'mappingsProof', 'sourceWorkspaceId', 'destinationWorkspaceId'] as const) {
    const changed = clone(input); assert(changed.metadata); changed.metadata[field] = 'f'.repeat(64);
    assert.throws(() => prepareNativeCopyStage({ ...changed, plan }), invalidStage, field);
  }
  const foreign = fixture(3, 'plain_text');
  assert.throws(() => prepareNativeCopyStage({ ...input, plan: foreign.plan }), invalidStage);
  assert.equal(prepareNativeCopyStage({ ...input, plan }).manifest.payloadSha256, first.manifest.payloadSha256);
});

test('own data-descriptor requirements apply at every Stage boundary without invoking getters', () => {
  const input = fixture(), prepared = prepareNativeCopyStage(input); let reads = 0;
  const changes: Array<(value: Mutable<WorkspaceOperationNativeCopyStageInput>) => void> = [
    value => Object.defineProperty(value, 'plan', { enumerable: true, get() { reads++; return input.plan; } }),
    value => Object.defineProperty(value.plan.sourceEvidence.stage, 'namespace', { enumerable: true, get() { reads++; return input.plan.sourceEvidence.stage.namespace; } }),
    value => Object.defineProperty(value.physical[0], 'original', { enumerable: true, get() { reads++; return input.physical[0].original; } }),
    value => Object.defineProperty(value.nativeRecords[0].state, 'yjsState', { enumerable: true, get() { reads++; return input.nativeRecords[0].state.yjsState; } }),
    value => Object.defineProperty(value.metadata!.sourceRows[1], 'title', { enumerable: true, get() { reads++; return 'hidden'; } }),
  ];
  for (const change of changes) { const modified = clone(input); change(modified); assert.throws(() => prepareNativeCopyStage(modified), invalidStage); }
  for (const key of ['plan', 'metadata', 'records'] as const) {
    const manifest = clone(prepared.manifest);
    Object.defineProperty(manifest, key, { enumerable: true, get() { reads++; return prepared.manifest[key as keyof NativeCopyStageManifest]; } });
    assert.throws(() => assertNativeCopyStageManifestDigest(manifest), corruptStage);
    assert.throws(() => decodeNativeCopyStage(manifest, prepared.recordsBytes, prepared.manifest.identity), corruptStage);
  }
  assert.equal(reads, 0);
});

test('inherited, symbolic, nonenumerable and sparse Stage data never becomes validated through earlier exact-plan use', () => {
  const input = fixture(); prepareNativeCopyStage(input);
  const changes: Array<(value: Mutable<WorkspaceOperationNativeCopyStageInput>) => void> = [
    value => { Object.setPrototypeOf(value.plan, { inherited: true }); },
    value => { Object.defineProperty(value.plan, Symbol('authority'), { value: true, enumerable: true }); },
    value => { Object.defineProperty(value.metadata!, 'sourceRows', { value: value.metadata!.sourceRows, enumerable: false }); },
    value => { Reflect.deleteProperty(value.physical, '0'); },
    value => { Object.defineProperty(value.nativeRecords, 'extra', { value: true, enumerable: true }); },
  ];
  for (const change of changes) { const modified = clone(input); change(modified); assert.throws(() => prepareNativeCopyStage(modified), invalidStage); }
});

test('the metadata row and manifest byte budgets remain active before native payload decoding', () => {
  const input = fixture(); assert(input.metadata); prepareNativeCopyStage(input);
  const crowded = clone(input); assert(crowded.metadata);
  crowded.metadata.sourceRows = Array.from({ length: 2049 }, () => clone(input.metadata!.sourceRows[0]));
  assert.throws(() => prepareNativeCopyStage(crowded), tooLarge);
  const prepared = prepareNativeCopyStage(input), manifest = clone(prepared.manifest);
  assert.equal(manifest.version, 3); if (manifest.version !== 3) assert.fail('V3 required');
  manifest.metadata.sourceRows = crowded.metadata.sourceRows;
  assert.throws(() => assertNativeCopyStageManifestDigest(manifest), tooLarge);
  // This deliberately invalid binary would be CORRUPT_STAGE if payload decode
  // ran first; the manifest budget must remain the earlier boundary.
  assert.throws(() => decodeNativeCopyStage(manifest, Buffer.alloc(0), prepared.manifest.identity), tooLarge);
  const oversized = clone(prepared.manifest) as unknown as Record<string, unknown>;
  oversized.extra = 'x'.repeat(16 * 1024 * 1024);
  assert.throws(() => assertNativeCopyStageManifestDigest(oversized), tooLarge);
  assert.throws(() => decodeNativeCopyStage(oversized, Buffer.alloc(0), prepared.manifest.identity), tooLarge);
});

test('a changed title is valid data only with its complete new metadata witness; a stale V3 composite fails', () => {
  const input = fixture(), prepared = prepareNativeCopyStage(input), changed = clone(prepared.manifest);
  assert.equal(changed.version, 3); if (changed.version !== 3) assert.fail('V3 required');
  changed.metadata.sourceRows[1].title = 'Another original snapshot';
  assert.throws(() => assertNativeCopyStageManifestDigest(changed), corruptStage);
  assert.throws(() => decodeNativeCopyStage(changed, prepared.recordsBytes, prepared.manifest.identity), corruptStage);
  rehash(changed); assertNativeCopyStageManifestDigest(changed);
  const decoded = decodeNativeCopyStage(changed, prepared.recordsBytes, changed.identity);
  assert.equal(decoded.version, 3); if (decoded.version !== 3) assert.fail('V3 required');
  assert.equal(decoded.metadata.sourceRows[1].title, 'Another original snapshot');
  assert.notEqual(decoded.payloadSha256, prepared.manifest.payloadSha256);
  const witness = nativeCopyMetadataWitness(decoded.metadata as NativeCopyMetadataSnapshot);
  assert.equal(witness.snapshotProof, proof(decoded.metadata)); assert.equal(witness.copiedTitleCount, 1);
});

test('only the exact deeply frozen decoder result is reusable within one synchronous validation callback', () => {
  const input = fixture(), raw = input.plan, original = clone(raw);
  const first = withNativeCopyPlanValidation(() => {
    const captured = decodeWorkspaceOperationNativeCopyPlan(raw);
    assert.notEqual(captured, raw); assert(Object.isFrozen(captured)); assert(Object.isFrozen(captured.sourceEvidence.stage.namespace));
    assert.equal(decodeWorkspaceOperationNativeCopyPlan(captured), captured);
    // A matching planId, object identity from another call, or caller-frozen
    // input never establishes membership in this private validation frame.
    assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(clone(captured)), captured);
    assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(raw), captured);
    raw.finalGraphProof = 'f'.repeat(64); // Independent mutable caller data.
    assert.equal(decodeWorkspaceOperationNativeCopyPlan(captured), captured);
    assert.equal(captured.finalGraphProof, original.finalGraphProof);
    assert.throws(() => decodeWorkspaceOperationNativeCopyPlan(raw), invalidPlan);
    return captured;
  });
  assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(first), first);
  withNativeCopyPlanValidation(() => assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(first), first));
});

test('fresh nested frames fully validate again and restore only the original outer exact references', () => {
  const raw = fixture().plan;
  withNativeCopyPlanValidation(() => {
    const outer = decodeWorkspaceOperationNativeCopyPlan(raw);
    const nested = withNativeCopyPlanValidation(() => {
      const inner = decodeWorkspaceOperationNativeCopyPlan(outer); assert.notEqual(inner, outer);
      assert.equal(decodeWorkspaceOperationNativeCopyPlan(inner), inner); return inner;
    });
    assert.equal(decodeWorkspaceOperationNativeCopyPlan(outer), outer);
    assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(nested), nested);
    const primary = new Error('Nested validation error');
    assert.throws(() => withNativeCopyPlanValidation(() => {
      assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(outer), outer); throw primary;
    }), error => error === primary);
    assert.equal(decodeWorkspaceOperationNativeCopyPlan(outer), outer);
  });
});

test('the eight-result memory bound falls back to full validation without refusing a legitimate ninth plan', () => {
  const raw = fixture().plan;
  withNativeCopyPlanValidation(() => {
    const results = Array.from({ length: 9 }, () => decodeWorkspaceOperationNativeCopyPlan(raw));
    assert.equal(new Set(results).size, 9);
    for (const result of results.slice(0, 8)) assert.equal(decodeWorkspaceOperationNativeCopyPlan(result), result);
    const last = decodeWorkspaceOperationNativeCopyPlan(results[8]);
    assert.notEqual(last, results[8]); assert.deepEqual(last, results[8]);
    assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(last), last);
  });
});

test('callback errors keep their identity and clear every reusable reference before delayed children run', async () => {
  const raw = fixture().plan, primary = new Error('Original validation callback error');
  let captured: ReturnType<typeof decodeWorkspaceOperationNativeCopyPlan> | undefined;
  let child: Promise<ReturnType<typeof decodeWorkspaceOperationNativeCopyPlan>> | undefined;
  assert.throws(() => withNativeCopyPlanValidation(() => {
    captured = decodeWorkspaceOperationNativeCopyPlan(raw);
    child = Promise.resolve().then(() => decodeWorkspaceOperationNativeCopyPlan(captured!));
    throw primary;
  }), error => error === primary);
  assert(captured && child); const delayed = await child;
  assert.notEqual(delayed, captured); assert.deepEqual(delayed, captured);
  withNativeCopyPlanValidation(() => assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(captured!), captured));
});

test('successful deferred Promise and timer children perform full validation after the synchronous frame ends', async () => {
  const raw = fixture().plan;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let child!: Promise<ReturnType<typeof decodeWorkspaceOperationNativeCopyPlan>>;
  let timer!: Promise<ReturnType<typeof decodeWorkspaceOperationNativeCopyPlan>>;
  const captured = withNativeCopyPlanValidation(() => {
    const result = decodeWorkspaceOperationNativeCopyPlan(raw);
    child = barrier.then(() => decodeWorkspaceOperationNativeCopyPlan(result));
    timer = new Promise(resolve => { setTimeout(() => resolve(decodeWorkspaceOperationNativeCopyPlan(result)), 0); });
    return result;
  });
  release();
  for (const result of await Promise.all([child, timer])) { assert.notEqual(result, captured); assert.deepEqual(result, captured); }
  assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(captured), captured);
});

test('a returned real Promise is rejected and its genuinely delayed child receives no reusable validation frame', async () => {
  const raw = fixture().plan;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let captured!: ReturnType<typeof decodeWorkspaceOperationNativeCopyPlan>;
  let child!: Promise<ReturnType<typeof decodeWorkspaceOperationNativeCopyPlan>>;
  assert.throws(() => withNativeCopyPlanValidation(() => {
    captured = decodeWorkspaceOperationNativeCopyPlan(raw);
    child = (async () => { await barrier; return decodeWorkspaceOperationNativeCopyPlan(captured); })();
    return child;
  }), invalidPlan);
  release(); const result = await child; assert.notEqual(result, captured); assert.deepEqual(result, captured);
});

test('a returned thenable is rejected without calling it, and ordinary synchronous results preserve identity', () => {
  const raw = fixture().plan; let called = 0;
  const thenable = { then() { called++; } };
  let captured!: ReturnType<typeof decodeWorkspaceOperationNativeCopyPlan>;
  const accessor = Object.defineProperty({}, 'then', { get() { called++; return thenable.then; } });
  for (const returned of [thenable, Object.create(thenable), accessor, Object.create(accessor)]) {
    assert.throws(() => withNativeCopyPlanValidation(() => {
      captured = decodeWorkspaceOperationNativeCopyPlan(raw); return returned;
    }), invalidPlan);
  }
  assert.equal(called, 0); assert.notEqual(decodeWorkspaceOperationNativeCopyPlan(captured), captured);
  const result = { original: true }; assert.equal(withNativeCopyPlanValidation(() => result), result);
});
