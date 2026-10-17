import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { createWorkspaceOperationNativeCopyPlan } from '../app/lib/files/workspace-operation-native-copy-plan';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { prepareNativeCopyStage, decodeNativeCopyStage, type WorkspaceOperationNativeCopyStage } from '../app/lib/files/workspace-operation-native-copy-stage';
import { captureNativeCopyPhaseStage, NativeCopyPhaseError, nativeCopyPhaseCompiler,
  nativeCopyPhaseSha, withNativeCopyPhaseCompilation, withCapturedNativeCopyPhaseStage } from '../app/lib/files/workspace-operation-native-copy-phase-contract';
import type { NativeMixedBatchPlan } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';

// Actual Yjs/C1/Stage codecs and compiler. Catalogue/physical root facts are
// declared pure data, never evidence of current SQL/ACL/FD authority or COMMIT.
function workspace(workspaceId: string): WorkspaceContext {
  return { workspaceId, rootPath: `/fixture/${workspaceId}`, rootRelativePath: `users/fixture/${workspaceId}`,
    workspaceType: 'personal', organizationId: null, ownerUserId: 'fixture-user', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
}
function state(scope: WorkspaceContext, filePath: string, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  const markdown = filePath === 'note.md' ? '[Keep](keep.md)\n\nOriginal' : '# Keep\n\nUnchanged';
  const doc = representation === 'plain_text' ? createPlainTextYDoc(markdown) : createRichMarkdownYDoc(markdown, representation);
  try { return { documentId: `${scope.workspaceId}:${filePath}`, workspaceId: scope.workspaceId, organizationId: null, path: filePath,
    representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 7, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }; }
  finally { doc.destroy(); }
}
function observation(scope: WorkspaceContext, states: PersistedCollaborationState[]): WorkspaceLinkSourceAuthorityObservation {
  const inventories = states.map(value => inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((value, index) => {
    const lineageId = `lineage:${value.documentId}`;
    return { expected: { documentId: value.documentId, lineageId, workspaceId: scope.workspaceId, organizationId: null,
      path: value.path, representation: value.representation, schemaVersion: 1, lifecycleGeneration: 1, registryStateVersion: 7,
      documentSequence: 7, persistedAt: 100, binaryHash: nativeCopyPhaseSha(value.yjsState), vectorHash: nativeCopyPhaseSha(value.stateVector),
      stateProof: inventories[index].version.stateProof },
    registry: { documentId: value.documentId, lineageId, workspaceId: scope.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 7, status: 'active' },
    lineage: { lineageId, workspaceId: scope.workspaceId, workspaceType: 'personal', organizationId: null, customerId: null, projectId: null,
      path: value.path, status: 'active', archivedAt: null, trashEntryId: null }, byteProfile: { newlineStyle: 'lf', hasBom: false },
    inventoryProof: nativeLinkJsonProof(inventories[index]) };
  });
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: scope.workspaceId, organizationId: null,
    catalogueProof: nativeLinkJsonProof(nativeBindings.map(binding => binding.registry)), namespace: states.map(value => ({ workspaceId: scope.workspaceId,
      path: value.path, kind: 'file', identity: `registry:${value.documentId}:1`, filesystemIdentity: null, documentId: value.documentId, lifecycleGeneration: 1 })),
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states };
}
function nativeCopyPhaseFixture(representation: PersistedCollaborationState['representation'] = 'tiptap_blocks'): WorkspaceOperationNativeCopyStage {
  const source = workspace('source'), destination = workspace('destination');
  const sourceStates = [state(source, 'note.md', representation), state(source, 'keep.md', representation)];
  const destinationStates = [state(destination, 'existing.md', representation)];
  // Copy both internal link endpoints to preserve the existing cross-WS contract.
  const selections = ['note.md', 'keep.md'].map(sourcePath => ({ sourcePath, destinationPath: sourcePath }));
  const plan = createWorkspaceOperationNativeCopyPlan({ sourceScope: { workspace: source, fileOptions: {} },
    destinationScope: { workspace: destination, fileOptions: {} }, selections,
    sourceObservation: observation(source, sourceStates), destinationObservation: observation(destination, destinationStates) });
  const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'fixture-user', actorId: 'fixture-user', sessionId: 'original-session' },
    sourceWorkspace: source, destinationWorkspace: destination });
  const identity = { device: '1', inode: '2', mode: 0o40700, uid: 501, gid: 20, linkCount: '2', size: '0', birthtimeNs: '1', mtimeNs: '1', ctimeNs: '1' };
  const prepared = prepareNativeCopyStage({ operationId: 'copy-compilation-fixture', request: { kind: 'copy', origin, selections }, plan,
    nativeRecords: [...sourceStates, ...destinationStates].map(state => ({ lineageId: `lineage:${state.documentId}`, state })),
    physical: selections.map(({ sourcePath, destinationPath }, selectionIndex) => ({ selectionIndex, original: { version: 1,
      sourceWorkspace: plan.sourceScope, destinationWorkspace: plan.destinationScope, sourcePath, destinationPath,
      projectionPaths: [sourcePath], budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 },
      filesystem: { sourceRoot: { resolvedPath: source.rootPath, identity }, destinationRoot: { resolvedPath: destination.rootPath, identity },
        sourceParents: { directories: [], missingPrefix: null }, destinationParents: { directories: [], missingPrefix: null } },
      source: { kind: 'projection_absent' }, staging: null } })) });
  return decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
}
function deepFrozen(value: unknown): void {
  if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const child of Object.values(value)) deepFrozen(child); }
}
const changed = (error: unknown) => error instanceof NativeCopyPhaseError && error.code === 'NATIVE_COPY_PHASE_CHANGED';

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: exact Stage reuses one frozen actual derivation only inside its awaited frame`, async () => {
  const stage = nativeCopyPhaseFixture(representation), original = nativeCopyPhaseCompiler(stage);
  const result = await withNativeCopyPhaseCompilation(stage, async () => {
    const first = nativeCopyPhaseCompiler(stage); assert.notEqual(first, original); await Promise.resolve();
    assert.equal(nativeCopyPhaseCompiler(stage), first); deepFrozen(first);
    assert.equal(Reflect.set(first, 'planId', 'forged'), false); assert.equal(first.planId, stage.plan.compilerPlanProof);
    return first;
  });
  assert.notEqual(nativeCopyPhaseCompiler(stage), result); assert.deepEqual(result, original); assert.equal(result.executionReady, false);
});

test('another detached Stage never receives the active Stage result, and every fresh frame derives again', async () => {
  const stage = nativeCopyPhaseFixture(), another = captureNativeCopyPhaseStage(stage);
  const first = await withNativeCopyPhaseCompilation(stage, async () => {
    const compiled = nativeCopyPhaseCompiler(stage), other = nativeCopyPhaseCompiler(another);
    assert.notEqual(other, compiled); assert.notEqual(nativeCopyPhaseCompiler(another), other);
    await withNativeCopyPhaseCompilation(stage, () => assert.notEqual(nativeCopyPhaseCompiler(stage), compiled));
    assert.equal(nativeCopyPhaseCompiler(stage), compiled); return compiled;
  });
  const second = await withNativeCopyPhaseCompilation(stage, () => nativeCopyPhaseCompiler(stage));
  assert.notEqual(first, second); assert.deepEqual(first, second);
});

for (const recordIndex of [0, 1, 2]) for (const field of ['yjsState', 'stateVector'] as const) test(`record ${recordIndex} ${field}: mutable original binary drift is sticky even after restoration`, async () => {
  const stage = nativeCopyPhaseFixture(), bytes = stage.nativeRecords[recordIndex].state[field], original = bytes[0];
  assert(Object.isFrozen(stage)); assert(Object.isFrozen(stage.nativeRecords[recordIndex].state));
  let failure: unknown;
  try {
    await assert.rejects(withNativeCopyPhaseCompilation(stage, async () => {
      nativeCopyPhaseCompiler(stage); bytes[0] ^= 1;
      try { nativeCopyPhaseCompiler(stage); assert.fail('Changed native bytes reused an old derivation.'); }
      catch (error) { assert(changed(error)); failure = error; }
      bytes[0] = original;
      assert.throws(() => nativeCopyPhaseCompiler(stage), error => error === failure); await Promise.resolve();
    }), error => error === failure);
  } finally { bytes[0] = original; }
  assert.equal(nativeCopyPhaseCompiler(stage).planId, stage.plan.compilerPlanProof);
});

test('end-of-callback pin detects drift without another compiler call before success', async () => {
  const stage = nativeCopyPhaseFixture(), bytes = stage.nativeRecords[2].state.yjsState, original = bytes[0];
  try { await assert.rejects(withNativeCopyPhaseCompilation(stage, async () => {
    nativeCopyPhaseCompiler(stage); await Promise.resolve(); bytes[0] ^= 1; return 'must not succeed';
  }), changed); } finally { bytes[0] = original; }
  await withNativeCopyPhaseCompilation(stage, () => nativeCopyPhaseCompiler(stage));
});

test('detached async context after success is explicitly rejected, outside calls still derive freshly', async () => {
  const stage = nativeCopyPhaseFixture(); let release!: () => void, detached!: Promise<NativeMixedBatchPlan>, held!: NativeMixedBatchPlan;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await withNativeCopyPhaseCompilation(stage, () => {
    held = nativeCopyPhaseCompiler(stage); detached = (async () => { await gate; return nativeCopyPhaseCompiler(stage); })();
  });
  release(); await assert.rejects(detached, changed);
  const outside = nativeCopyPhaseCompiler(stage); assert.notEqual(outside, held); assert.deepEqual(outside, held);
});

test('callback failure deactivates detached context and preserves the original exception', async () => {
  const stage = nativeCopyPhaseFixture(), primary = new Error('original callback failure');
  let release!: () => void, detached!: Promise<NativeMixedBatchPlan>, held!: NativeMixedBatchPlan;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(withNativeCopyPhaseCompilation(stage, () => {
    held = nativeCopyPhaseCompiler(stage); detached = (async () => { await gate; return nativeCopyPhaseCompiler(stage); })(); throw primary;
  }), error => error === primary);
  release(); await assert.rejects(detached, changed); assert.notEqual(nativeCopyPhaseCompiler(stage), held);
});

test('unfrozen original metadata and accessors never enter the operation', async () => {
  const stage = nativeCopyPhaseFixture(); let entered = false, getterCalls = 0;
  const unfrozen = { ...stage };
  await assert.rejects(withNativeCopyPhaseCompilation(unfrozen, () => { entered = true; }), changed);
  const accessor = Object.freeze(Object.defineProperty({ ...stage }, 'request', { enumerable: true, get() { getterCalls++; return stage.request; } }));
  await assert.rejects(withNativeCopyPhaseCompilation(accessor, () => { entered = true; }), changed);
  assert.equal(entered, false); assert.equal(getterCalls, 0);
});

// A captured-data frame only avoids repeating the same pure Stage detachment.
// These are genuine Yjs/Stage inputs, without principal, SQL or FD authority.
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: captured Stage retains its exact detached reference across await only inside its data frame`, async () => {
  const original = nativeCopyPhaseFixture(representation), firstOutside = captureNativeCopyPhaseStage(original);
  const secondOutside = captureNativeCopyPhaseStage(original);
  assert.notEqual(firstOutside, secondOutside); assert.deepEqual(firstOutside, secondOutside);
  const held = await withCapturedNativeCopyPhaseStage(original, async detached => {
    assert.notEqual(detached, original); assert.notEqual(detached, firstOutside); assert.deepEqual(detached, original);
    assert(Object.isFrozen(detached)); assert(Object.isFrozen(detached.nativeRecords));
    for (const [index, record] of detached.nativeRecords.entries()) {
      assert.notEqual(record.state.yjsState, original.nativeRecords[index].state.yjsState);
      assert.notEqual(record.state.stateVector, original.nativeRecords[index].state.stateVector);
    }
    assert.equal(captureNativeCopyPhaseStage(detached), detached);
    await Promise.resolve(); assert.equal(captureNativeCopyPhaseStage(detached), detached); return detached;
  });
  const after = captureNativeCopyPhaseStage(held);
  assert.notEqual(after, held); assert.deepEqual(after, held); assert.notEqual(captureNativeCopyPhaseStage(held), after);
});

test('every new or nested captured-data wrapper performs a fresh full detachment and restores the outer frame', async () => {
  const original = nativeCopyPhaseFixture();
  const first = await withCapturedNativeCopyPhaseStage(original, async outer => {
    assert.equal(captureNativeCopyPhaseStage(outer), outer);
    const nested = await withCapturedNativeCopyPhaseStage(outer, async inner => {
      assert.notEqual(inner, outer); assert.deepEqual(inner, outer);
      for (const [index, record] of inner.nativeRecords.entries()) {
        assert.notEqual(record.state.yjsState, outer.nativeRecords[index].state.yjsState);
        assert.notEqual(record.state.stateVector, outer.nativeRecords[index].state.stateVector);
      }
      await Promise.resolve(); assert.equal(captureNativeCopyPhaseStage(inner), inner); return inner;
    });
    assert.notEqual(nested, outer); assert.equal(captureNativeCopyPhaseStage(outer), outer); return outer;
  });
  const second = await withCapturedNativeCopyPhaseStage(original, detached => {
    assert.notEqual(detached, first); assert.deepEqual(detached, first); return detached;
  });
  assert.notEqual(first, second);
});

test('a foreign Stage always takes the full detached path and never acquires another Stage reference', async () => {
  const original = nativeCopyPhaseFixture(), foreign = captureNativeCopyPhaseStage(original);
  await withCapturedNativeCopyPhaseStage(original, async detached => {
    const first = captureNativeCopyPhaseStage(foreign), second = captureNativeCopyPhaseStage(foreign);
    assert.notEqual(first, foreign); assert.notEqual(second, foreign); assert.notEqual(first, second);
    assert.notEqual(first, detached); assert.deepEqual(first, foreign);
    await Promise.resolve(); assert.equal(captureNativeCopyPhaseStage(detached), detached);
    assert.notEqual(captureNativeCopyPhaseStage(foreign), first);
  });
});

for (const recordIndex of [0, 1, 2]) for (const field of ['yjsState', 'stateVector'] as const) test(`captured record ${recordIndex} ${field}: detected byte drift remains sticky after restoration`, async () => {
  const original = nativeCopyPhaseFixture(); let bytes: Uint8Array | undefined, saved = 0, failure: unknown;
  try {
    await assert.rejects(withCapturedNativeCopyPhaseStage(original, async detached => {
      bytes = detached.nativeRecords[recordIndex].state[field]; saved = bytes[0]; bytes[0] ^= 1;
      try { captureNativeCopyPhaseStage(detached); assert.fail('Changed captured bytes reused an original Stage.'); }
      catch (error) { assert(changed(error)); failure = error; }
      bytes[0] = saved;
      assert.throws(() => captureNativeCopyPhaseStage(detached), error => error === failure); await Promise.resolve();
    }), error => error === failure);
  } finally { if (bytes) bytes[0] = saved; }
  const outside = captureNativeCopyPhaseStage(original); assert.deepEqual(outside, original);
});

test('mutating the caller input after capture cannot change detached native bytes or poison that detached frame', async () => {
  const original = nativeCopyPhaseFixture(), inputBytes = original.nativeRecords[0].state.yjsState, saved = inputBytes[0];
  try {
    await withCapturedNativeCopyPhaseStage(original, async detached => {
      const expected = Uint8Array.from(detached.nativeRecords[0].state.yjsState);
      inputBytes[0] ^= 1; await Promise.resolve();
      assert.deepEqual(detached.nativeRecords[0].state.yjsState, expected);
      assert.equal(captureNativeCopyPhaseStage(detached), detached);
    });
  } finally { inputBytes[0] = saved; }
  assert.deepEqual(captureNativeCopyPhaseStage(original), original);
});

test('captured-data callback completion detects binary drift even without another capture call', async () => {
  const original = nativeCopyPhaseFixture(); let bytes: Uint8Array | undefined, saved = 0;
  try {
    await assert.rejects(withCapturedNativeCopyPhaseStage(original, async detached => {
      bytes = detached.nativeRecords[2].state.stateVector; saved = bytes[0];
      await Promise.resolve(); bytes[0] ^= 1; return 'must not succeed';
    }), changed);
  } finally { if (bytes) bytes[0] = saved; }
  assert.deepEqual(captureNativeCopyPhaseStage(original), original);
});

test('a genuinely deferred captured-data child is inactive after callback success', async () => {
  const original = nativeCopyPhaseFixture(); let release!: () => void, child!: Promise<WorkspaceOperationNativeCopyStage>;
  let held!: WorkspaceOperationNativeCopyStage;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await withCapturedNativeCopyPhaseStage(original, detached => {
    held = detached; child = (async () => { await gate; return captureNativeCopyPhaseStage(detached); })();
    assert.equal(captureNativeCopyPhaseStage(detached), detached);
  });
  release(); await assert.rejects(child, changed);
  const outside = captureNativeCopyPhaseStage(held); assert.notEqual(outside, held); assert.deepEqual(outside, held);
});

test('callback failure preserves its primary error and deactivates genuinely deferred captured-data children', async () => {
  const original = nativeCopyPhaseFixture(), primary = new Error('captured-data callback primary failure');
  let release!: () => void, child!: Promise<WorkspaceOperationNativeCopyStage>, held!: WorkspaceOperationNativeCopyStage;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(withCapturedNativeCopyPhaseStage(original, detached => {
    held = detached; child = (async () => { await gate; return captureNativeCopyPhaseStage(detached); })(); throw primary;
  }), error => error === primary);
  release(); await assert.rejects(child, changed);
  const outside = captureNativeCopyPhaseStage(held); assert.notEqual(outside, held); assert.deepEqual(outside, held);
});
