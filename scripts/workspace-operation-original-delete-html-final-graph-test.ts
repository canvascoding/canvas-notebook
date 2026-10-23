import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Y } from '../app/lib/collaboration/server-runtime';
import { captureAgentStateSnapshot } from '../app/lib/collaboration/agent-durability';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { assertOriginalDeleteHtmlFinalGraph } from '../app/lib/files/workspace-operation-original-delete-html-graph';
import type { OriginalDeleteNativeLinkReceiptV4 } from '../app/lib/files/workspace-operation-original-delete-links';
import { createWorkspaceOperationNativeDeleteBatchPlanV4, getWorkspaceOperationNativeDeleteLinkRecipes }
  from '../app/lib/files/workspace-operation-native-delete-plan';
import { captureWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5 }
  from '../app/lib/files/workspace-operation-mixed-source-evidence-v5';
import { nativeLinkPreparedIntentProof } from '../app/lib/markdown/native-link-mutation-persistence';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutationsV4 } from '../app/lib/markdown/workspace-native-link-mutations';
import { inspectOriginalPhysicalLinksV3, workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

// Declared pure source/catalogue/receipt facts with real Yjs and parser4
// mutation bytes. This suite runs no SQL/FS/HTTP/Owner/claim/COMMIT and starts
// no runner. Its receipts are comparison inputs, never authority evidence.
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
type Observation = ReturnType<typeof workspaceOperationMixedSourceEvidenceV5Fixture>['observation'];
function refresh(observation: Observation): void {
  const catalogueProof = proof(observation.privateCatalogue), states = observation.privateNativeStates;
  const inventories = states.map(inspectPersistedDocumentLinks);
  observation.stage.catalogueProof = catalogueProof;
  for (const binding of observation.nativeBindings) {
    const state = states.find(value => value.documentId === binding.expected.documentId); assert(state);
    const inventory = inventories.find(value => value.document.documentId === state.documentId); assert(inventory);
    binding.expected.binaryHash = sha(state.yjsState); binding.expected.vectorHash = sha(state.stateVector);
    binding.expected.stateProof = inventory.version.stateProof; binding.expected.documentSequence = state.documentSequence;
    binding.expected.persistedAt = state.persistedAt; binding.inventoryProof = proof(inventory);
  }
  observation.stage.sources = [...inventories.map(inventory => ({ kind: 'native' as const, inventory })),
    ...observation.stage.sources.flatMap(source => source.kind === 'physical' ? [{ kind: 'physical' as const,
      inventory: inspectOriginalPhysicalLinksV3({ workspaceId: source.inventory.workspaceId,
        organizationId: source.inventory.organizationId, path: source.inventory.path, bytes: source.inventory.originalBytes,
        filesystemIdentity: source.inventory.physical.filesystemIdentity, authority: { ...source.inventory.authority, catalogueProof } }) }] : [])];
  const gaps = observation.stage.sources.flatMap(source => source.kind === 'native'
    ? source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })) : source.inventory.coverage.gaps);
  observation.stage.coverage = { complete: !gaps.length, gaps };
  observation.stage.readiness = gaps.length ? 'blocked' : observation.stage.sources.some(source => source.kind === 'physical')
    ? 'requires-import-and-rebinding' : 'native-coordinator-required';
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
}
function fixture(withUnlink = true) {
  const original = workspaceOperationMixedSourceEvidenceV5Fixture({
    native: [['target.md', '# Target\n'], ['incoming.md', `${withUnlink ? '[Target](target.md)\n\n' : ''}<p><a href="https://example.com">External</a></p>\n\n[Keep](keep.md)\n`],
      ['keep.md', '# Keep\n']], raw: [['raw.md', '[Self](raw.md)\n'], ['page.html', '<p>External <a href="https://example.com">HTML</a></p>']],
    extra: [{ path: 'unindexed.bin', kind: 'file' }],
  });
  const workspace = { ...original.scope, rootRelativePath: original.scope.rootRelativePath ?? undefined,
    legacy: false, status: 'active' as const, permissions: { canRead: true, canWrite: true, canDelete: true,
      canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
  const scope: WorkspaceOperationBatchScope = { workspace, fileOptions: { workspace } };
  const plan = createWorkspaceOperationNativeDeleteBatchPlanV4({ scope, actions: [{ reviewId: 'delete-html-final-pure',
    kind: 'delete', selections: [{ sourcePath: 'target.md' }] }], observation: original.observation });
  const after = structuredClone(original.observation) as Observation, receipts: OriginalDeleteNativeLinkReceiptV4[] = [];
  const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan);
  for (const documentId of [...new Set(recipes.map(recipe => recipe.source.documentId))].sort()) {
    const state = after.privateNativeStates.find(value => value.documentId === documentId); assert(state);
    const operationId = `native-delete-link:${sha(`delete-html-pure-batch\n${documentId}`)}`;
    const prepared = prepareNativeLinkMutationsV4({ state, recipes: recipes.filter(recipe => recipe.source.documentId === documentId), operationId });
    assert.equal(prepared.contractVersion, 4); assert.equal(prepared.parserVersion, 4);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state.yjsState); Y.applyUpdate(doc, prepared.update);
      const snapshot = captureAgentStateSnapshot(doc, Y); assert(snapshot);
      state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc);
      state.documentSequence++; state.persistedAt++;
      assert.equal(authoritativeNativeCollaborationSnapshot(state).version.stateProof, prepared.after.stateProof);
      receipts.push({ contractVersion: 2, operationId, source: prepared.source,
        binding: { actorUserId: 'fixture-owner', actorId: 'fixture-owner', actorType: 'user', actorSessionId: null,
          requestId: operationId, requestHash: '1'.repeat(64), authorizedPreparedProof: nativeLinkPreparedIntentProof(prepared) },
        before: prepared.before, after: { ...prepared.after, documentSequence: state.documentSequence, persistedAt: state.persistedAt },
        inverseRecipes: prepared.inverseRecipes, afterStateSnapshotBase64: Buffer.from(snapshot).toString('base64'),
        resultEvidenceVersion: 4, parserVersion: 4, htmlSourceProof: prepared.htmlSourceProof,
        afterBinaryHash: sha(state.yjsState), afterVectorHash: sha(state.stateVector) });
    } finally { doc.destroy(); }
  }
  const targetId = plan.nativeTarget.documentId;
  after.privateCatalogue = after.privateCatalogue.filter(row => row.id !== targetId);
  after.privateNativeStates = after.privateNativeStates.filter(state => state.documentId !== targetId);
  after.nativeBindings = after.nativeBindings.filter(binding => binding.expected.documentId !== targetId);
  after.stage.namespace = after.stage.namespace.filter(entry => entry.documentId !== targetId);
  refresh(after);
  return { plan, after, original: { sourceEvidence: original.evidence, nativeLinks: receipts, beforeObservation: original.observation }, recipes };
}
function rejects(action: () => void): void {
  assert.throws(action, error => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value !== undefined);
}

export function workspaceOperationOriginalDeleteHtmlFinalGraphTest(): void {
  let groups = 0;
  // Positive native unlink plus unchanged physical Markdown/HTML and asset.
  // Honest coverage remains incomplete: final validation never upgrades it.
  {
    const value = fixture(), before = structuredClone(value);
    assert.equal(value.original.nativeLinks.length, 1); assert(value.recipes.length > 0);
    assert.equal(value.plan.coverage.complete, false);
    assert.equal(workspaceOperationMixedSourceSnapshotV5(captureWorkspaceOperationMixedSourceEvidenceV5(
      value.original.sourceEvidence.workspaceScope, value.after)).coverage.complete, false);
    assertOriginalDeleteHtmlFinalGraph(value.plan, value.after, value.original);
    assert.deepEqual(value, before);
    const prior = value.original.sourceEvidence.nativeComponent.htmlSources.find(source => source.path === 'incoming.md')!;
    const next = captureWorkspaceOperationMixedSourceEvidenceV5(value.original.sourceEvidence.workspaceScope, value.after)
      .nativeComponent.htmlSources.find(source => source.path === 'incoming.md')!;
    assert.equal(next.inspection.occurrences.length, 1); assert.equal(prior.inspection.occurrences.length, 1);
    assert.equal(next.inspection.occurrences[0].raw, prior.inspection.occurrences[0].raw);
    assert.notEqual(next.inspection.occurrences[0].start, prior.inspection.occurrences[0].start,
      'Genuine ordinary unlink may shift HTML offsets while preserving its exact raw syntax/targets.');
  }
  groups++;
  {
    const value = fixture(false); assert.deepEqual(value.original.nativeLinks, []); assert.deepEqual(value.recipes, []);
    assertOriginalDeleteHtmlFinalGraph(value.plan, value.after, value.original);
  }
  groups++;
  for (const alter of [
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks.length = 0; },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks.push(structuredClone(value.original.nativeLinks[0])); },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].resultEvidenceVersion = 3 as 4; },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].parserVersion = 2 as 4; },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].htmlSourceProof = '0'.repeat(64); },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].afterBinaryHash = '0'.repeat(64); },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].afterVectorHash = '0'.repeat(64); },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].afterStateSnapshotBase64 = Buffer.from('bad snapshot').toString('base64'); },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].after.documentSequence++; },
    (value: ReturnType<typeof fixture>) => { value.original.nativeLinks[0].before.documentSequence++; },
    (value: ReturnType<typeof fixture>) => { value.after.privateNativeStates[0].yjsState[0] ^= 1; },
    (value: ReturnType<typeof fixture>) => { value.after.nativeBindings[0].lineage.lineageId = 'foreign'; },
  ]) { const value = fixture(); alter(value); rejects(() => assertOriginalDeleteHtmlFinalGraph(value.plan, value.after, value.original)); }
  groups++;
  // Valid fresh E5 captures still cannot omit a pristine asset or change any
  // original physical byte/profile/HTML target under the final graph proof.
  {
    const value = fixture(); value.after.stage.namespace = value.after.stage.namespace.filter(entry => entry.path !== 'unindexed.bin');
    refresh(value.after); captureWorkspaceOperationMixedSourceEvidenceV5(value.original.sourceEvidence.workspaceScope, value.after);
    rejects(() => assertOriginalDeleteHtmlFinalGraph(value.plan, value.after, value.original));
  }
  for (const selected of ['raw.md', 'page.html']) {
    const value = fixture(), source = value.after.stage.sources.find(item => item.kind === 'physical' && item.inventory.path === selected);
    assert(source?.kind === 'physical'); const bytes = Buffer.from(selected === 'raw.md' ? '# Changed raw\n' : '<p>Different HTML</p>');
    source.inventory = inspectOriginalPhysicalLinksV3({ workspaceId: source.inventory.workspaceId,
      organizationId: source.inventory.organizationId, path: source.inventory.path, bytes,
      authority: source.inventory.authority, filesystemIdentity: `1:999:${bytes.length}:100:100` });
    const entry = value.after.stage.namespace.find(item => item.path === selected)!;
    entry.identity = source.inventory.physical.filesystemIdentity; entry.filesystemIdentity = source.inventory.physical.filesystemIdentity;
    refresh(value.after); captureWorkspaceOperationMixedSourceEvidenceV5(value.original.sourceEvidence.workspaceScope, value.after);
    rejects(() => assertOriginalDeleteHtmlFinalGraph(value.plan, value.after, value.original));
  }
  groups++;
  // The entire original catalogue, including has_state_history, participates
  // in the inverse proof; no host-side sort substitutes for original DB order.
  {
    const value = fixture(); value.after.privateCatalogue[0].has_state_history = !value.after.privateCatalogue[0].has_state_history;
    refresh(value.after); captureWorkspaceOperationMixedSourceEvidenceV5(value.original.sourceEvidence.workspaceScope, value.after);
    rejects(() => assertOriginalDeleteHtmlFinalGraph(value.plan, value.after, value.original));
  }
  groups++;
  // Plain malformed/side-effecting comparison inputs never become receipts.
  {
    const value = fixture(); let getters = 0;
    const supplied = { sourceEvidence: value.original.sourceEvidence, beforeObservation: value.original.beforeObservation,
      get nativeLinks() { getters++; return value.original.nativeLinks; } };
    rejects(() => assertOriginalDeleteHtmlFinalGraph(value.plan, value.after, supplied)); assert.equal(getters, 0);
  }
  groups++;
  console.log(JSON.stringify({ test: 'original-delete-html-final-graph-pure', groups, databaseOrFilesystemEvidence: false }));
}
