import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { prepareNativeFileArchiveTransition, prepareNativeFileRestoreTransition } from '../app/lib/collaboration/native-file-archive-transition';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { createWorkspaceOperationNativeDeleteBatchPlan } from '../app/lib/files/workspace-operation-native-delete-plan';
import { assertWorkspaceOperationNativeDeleteUndoGraphCurrent } from '../app/lib/files/workspace-operation-native-delete-undo-graph';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../app/lib/markdown/workspace-source-authority-stage';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'native-undo-graph', workspaceType: 'personal',
  organizationId: null, customerId: null, projectId: null, ownerUserId: 'user1', rootPath: '/tmp/native-undo-graph',
  rootRelativePath: 'workspaces/native-undo-graph', legacy: false, status: 'active', actor: { userId: 'user1', role: 'owner' },
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } }, fileOptions: {} };
scope.fileOptions.workspace = scope.workspace;
function state(text: string, filePath: string, representation: PersistedCollaborationState['representation'] = 'plain_text'): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try {
    return { documentId: `document:${filePath}`, workspaceId: scope.workspace.workspaceId, organizationId: null, path: filePath, representation,
      lifecycleGeneration: 4, schemaVersion: COLLABORATION_SCHEMA_VERSION, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
      documentSequence: 2, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null,
      serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  } finally { doc.destroy(); }
}
function observation(states: PersistedCollaborationState[]): WorkspaceLinkSourceAuthorityObservation {
  const sources = states.map(value => ({ kind: 'native' as const, inventory: inspectPersistedDocumentLinks(value) }));
  const nativeBindings = states.map((value, index) => ({ expected: { documentId: value.documentId, lineageId: `lineage:${value.documentId}`,
    workspaceId: value.workspaceId, organizationId: value.organizationId, path: value.path, representation: value.representation,
    schemaVersion: value.schemaVersion, lifecycleGeneration: value.lifecycleGeneration, registryStateVersion: value.lifecycleGeneration === 6 ? 0 : value.documentSequence,
    documentSequence: value.documentSequence, persistedAt: value.persistedAt, stateProof: sources[index].inventory.version.stateProof,
    binaryHash: sha(value.yjsState), vectorHash: sha(value.stateVector) },
  registry: { documentId: value.documentId, lineageId: `lineage:${value.documentId}`, workspaceId: value.workspaceId, workspaceType: 'personal' as const,
    organizationId: null, customerId: null, projectId: null, path: value.path, provider: 'yjs' as const, stateLifecycle: 'initialized' as const,
    stateVersion: value.lifecycleGeneration === 6 ? 0 : value.documentSequence, status: 'active' as const },
  lineage: { lineageId: `lineage:${value.documentId}`, workspaceId: value.workspaceId, workspaceType: 'personal' as const, organizationId: null,
    customerId: null, projectId: null, path: value.path, status: 'active' as const, archivedAt: null, trashEntryId: null },
  byteProfile: { newlineStyle: value.newlineStyle, hasBom: value.hasBom }, inventoryProof: nativeLinkJsonProof(sources[index].inventory) }));
  const body = { stageVersion: 1 as const, workspaceId: scope.workspace.workspaceId, organizationId: null,
    catalogueProof: nativeLinkJsonProof(nativeBindings.map(value => value.registry)), sources,
    namespace: states.map(value => ({ workspaceId: value.workspaceId, path: value.path, kind: 'file' as const,
      identity: `registry:${value.documentId}:${value.lifecycleGeneration}`, documentId: value.documentId,
      lifecycleGeneration: value.lifecycleGeneration, filesystemIdentity: null })), scope: { kind: 'visible-workspace' as const, excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required' as const, executionReady: false as const };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states };
}
function plan(states: PersistedCollaborationState[]) {
  return createWorkspaceOperationNativeDeleteBatchPlan({ scope, actions: [{ reviewId: 'native-delete', kind: 'delete', selections: [{ sourcePath: 'target.md' }] }],
    observation: observation(states) });
}
function restored(original: PersistedCollaborationState) {
  const selected = observation([original]).nativeBindings[0].expected;
  const archived = prepareNativeFileArchiveTransition(original, selected, { trashEntryId: 'trash-original', archivedAt: 300 });
  const archivedState: PersistedCollaborationState = { ...original, ...archived.writes.state, projectionError: undefined };
  const transition = prepareNativeFileRestoreTransition(archivedState, selected, archived, { trashEntryId: 'trash-original', restoredAt: 400 });
  return { ...original, ...transition.writes.state, projectionError: undefined } satisfies PersistedCollaborationState;
}
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: original self-link and unrelated fresh native document survive inverse graph checks`, () => {
    const target = state('[Self](target.md)', 'target.md', representation), home = state('Home', 'home.md', representation);
    const original = plan([target, home]), added = state('[Home](home.md)', 'added.md', representation);
    assert.doesNotThrow(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original, observation([home, added])));
    assert.doesNotThrow(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original, observation([restored(target), home, added]), 'after-restore'));
  });
  test(`${representation}: new Markdown and Wiki links to the deleted target conflict before and after Restore`, () => {
    const target = state('---\naliases: [Original]\n---\n\nTarget', 'target.md', representation), original = plan([target]);
    for (const text of ['[Fresh](target.md)', '[[Original]]']) {
      const added = state(text, 'added.md', representation);
      assert.throws(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original, observation([added])), { code: 'NATIVE_DELETE_UNDO_LINK_CONFLICT' });
      assert.throws(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original, observation([restored(target), added]), 'after-restore'),
        { code: 'NATIVE_DELETE_UNDO_LINK_CONFLICT' });
    }
  });
  test(`${representation}: original outgoing links never silently acquire a replacement document identity`, () => {
    const target = state('[Other](other.md)', 'target.md', representation), other = state('Original other', 'other.md', representation);
    const original = plan([target, other]);
    assert.doesNotThrow(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original, observation([other])));
    const replacement = { ...state('Replacement', 'other.md', representation), documentId: 'replacement-D2' };
    assert.throws(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original, observation([replacement])),
      { code: 'NATIVE_DELETE_UNDO_LINK_CONFLICT' });
  });
}
test('replacement at the original path and an incomplete current source catalogue never grant native Undo', () => {
  const target = state('Target', 'target.md'), original = plan([target]);
  assert.throws(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original,
    observation([{ ...target, documentId: 'replacement-D2' }])), { code: 'NATIVE_DELETE_UNDO_LINK_CONFLICT' });
  const incomplete = observation([]);
  incomplete.stage.coverage.complete = false;
  assert.throws(() => assertWorkspaceOperationNativeDeleteUndoGraphCurrent(original, incomplete));
});
