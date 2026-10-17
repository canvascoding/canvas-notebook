import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../../app/lib/workspaces/types';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../../app/lib/markdown/workspace-source-authority-stage';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../../app/lib/markdown/workspace-physical-link-inventory';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../../app/lib/markdown/workspace-native-link-inventory';
import { createWorkspaceOperationNativeCopyPlan } from '../../app/lib/files/workspace-operation-native-copy-plan';
import { captureWorkspaceOperationCopyOrigin } from '../../app/lib/files/workspace-operation-copy-origin';
import { prepareNativeCopyStage, decodeNativeCopyStage, type WorkspaceOperationNativeCopyStage } from '../../app/lib/files/workspace-operation-native-copy-stage';
import { nativeCopyPhaseSha } from '../../app/lib/files/workspace-operation-native-copy-phase-contract';

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
export function nativeCopyMetadataFixture(representation: PersistedCollaborationState['representation'] = 'tiptap_blocks'): WorkspaceOperationNativeCopyStage {
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
