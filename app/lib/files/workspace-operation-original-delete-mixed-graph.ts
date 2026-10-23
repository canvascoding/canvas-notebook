import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { NativeNamespaceEntry, NativeResolvedLink } from '../markdown/workspace-link-contract-v2';
import { buildWorkspaceMixedReadLinkGraphV3 } from '../markdown/workspace-native-link-graph';
import type { NativeMixedBatchVirtualEntity } from '../markdown/workspace-native-mixed-batch-compiler';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationNativeDeleteBatchPlanV3 } from './workspace-operation-batch-contract';
import { workspaceOperationMixedSourceSnapshot } from './workspace-operation-mixed-source-evidence';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { decodeWorkspaceOperationNativeDeleteBatchPlan,
  getWorkspaceOperationNativeDeleteLinkRecipes } from './workspace-operation-native-delete-plan';
import { decodeWorkspaceOperationMixedOriginalSourceWitness } from './workspace-operation-native-original-source';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationNativeSourceEvidenceV3,
  type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { assertOriginalDeleteNativeBindingEvidence,
  type OriginalDeleteNativeLinkReceipt } from './workspace-operation-original-delete-links';

function fail(): never {
  throw Object.assign(new Error('ORIGINAL_DELETE_POSTCONDITION'), { code: 'ORIGINAL_DELETE_POSTCONDITION', status: 409 });
}
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  return descriptor.value;
}
function inferredDirectory(entity: NativeMixedBatchVirtualEntity): boolean {
  return entity.kind === 'directory' && entity.binding.kind === 'existing'
    && entity.binding.namespaceEvidence.filesystemIdentity === null
    && entity.binding.namespaceEvidence.identity === `registry-directory:${nativeLinkJsonProof({ workspaceId: entity.workspaceId, path: entity.path })}`;
}
function directoryIdentity(entry: NativeNamespaceEntry): string {
  return entry.filesystemIdentity === null ? entry.identity : `directory:${entry.filesystemIdentity.split(':').slice(0, 2).join(':')}`;
}
function physicalFacts(sources: WorkspaceOperationNativeSourceEvidenceV3['physicalSources']) {
  return sources.map(source => {
    const { physicalSourceProof: _proof, links, authority, ...body } = source;
    const { catalogueProof: _catalogue, ...identity } = authority;
    return { ...body, authority: identity, links: links.map(({ physicalLinkId: _id, ...link }) => link) };
  });
}
function entityKey(entry: NativeNamespaceEntry): string {
  return nativeLinkJsonProof({ workspaceId: entry.workspaceId, identity: entry.identity });
}

/** Pure final comparison only. Both observations must have been collected by
 * the genuine fixed Owner on its same B2 connection, before/after its writes.
 * These facts grant no actor, claim, transaction, Admission or COMMIT authority.
 * Historical V1/V2 graph validation remains in the original native module. */
export function assertOriginalDeleteMixedFinalGraph(plan: WorkspaceOperationNativeDeleteBatchPlanV3,
  finalObservation: WorkspaceLinkSourceAuthorityObservation,
  original: Readonly<{ sourceEvidence: WorkspaceOperationNativeSourceEvidenceV3;
    nativeLinks: readonly OriginalDeleteNativeLinkReceipt[]; beforeObservation: WorkspaceLinkSourceAuthorityObservation }>): void {
  const decoded = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
  if (decoded.planIdentityVersion !== 3) fail();
  const witness = decodeWorkspaceOperationMixedOriginalSourceWitness(decoded.sourceEvidence, field(original, 'sourceEvidence'));
  const beforeObservation = field(original, 'beforeObservation') as WorkspaceLinkSourceAuthorityObservation;
  const nativeLinks = captureWorkspaceOperationNativePlanData(field(original, 'nativeLinks'), fail, 2097152) as readonly OriginalDeleteNativeLinkReceipt[];
  // Fresh capture reparses every physical original byte and checks the full
  // catalogue, including pristine non-Markdown rows, before any normalization.
  const before = captureWorkspaceOperationNativeSourceEvidenceV3(witness.workspaceScope, beforeObservation);
  decodeWorkspaceOperationMixedOriginalSourceWitness(witness, before);
  const actual = captureWorkspaceOperationNativeSourceEvidenceV3(witness.workspaceScope, finalObservation);
  if (!equal(actual.scope, witness.scope)) fail();
  const beforeCatalogue = captureWorkspaceOperationNativeCatalogueWitness(field(beforeObservation, 'privateCatalogue'),
    before.workspaceScope, before.nativeComponent.stage.catalogueProof!, before.nativeComponent.nativeBindings, fail);
  const afterCatalogue = captureWorkspaceOperationNativeCatalogueWitness(field(finalObservation, 'privateCatalogue'),
    actual.workspaceScope, actual.nativeComponent.stage.catalogueProof!, actual.nativeComponent.nativeBindings, fail);
  if (beforeCatalogue.semanticCatalogueProof !== before.nativeComponent.semanticCatalogueProof
    || beforeCatalogue.semanticCatalogueProof !== witness.nativeComponent.semanticCatalogueProof
    || afterCatalogue.semanticCatalogueProof !== actual.nativeComponent.semanticCatalogueProof) fail();
  const targetId = decoded.nativeTarget.documentId;
  const target = beforeCatalogue.entries.find(entry => entry.id === targetId);
  if (!target || target.authority !== 'initialized' || target.path !== decoded.nativeTarget.path
    || target.lineage_id !== decoded.nativeTarget.lineageId || afterCatalogue.entries.some(entry => entry.id === targetId)) fail();
  // Archive removes the target from the active catalogue. Restore precisely
  // the actual pre-write row, never a row fabricated from NativeArchiveExpected
  // (which does not contain e.g. has_state_history). The original DB-ordered ID
  // list also avoids assuming host/JavaScript collation equals PostgreSQL.
  const inverse = new Map(afterCatalogue.entries.map(entry => [entry.id, entry]));
  if (inverse.size + 1 !== beforeCatalogue.entries.length) fail();
  inverse.set(targetId, target);
  const ordered = beforeCatalogue.entries.map(entry => inverse.get(entry.id) ?? fail());
  if (inverse.size !== ordered.length || new Set(ordered.map(entry => entry.id)).size !== inverse.size) fail();
  const inverseCatalogue = captureWorkspaceOperationNativeCatalogueWitness(ordered, before.workspaceScope,
    nativeLinkJsonProof(ordered), before.nativeComponent.nativeBindings, fail);
  if (inverseCatalogue.semanticCatalogueProof !== witness.nativeComponent.semanticCatalogueProof) fail();
  const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(decoded);
  assertOriginalDeleteNativeBindingEvidence(witness.nativeComponent, actual.nativeComponent, targetId, recipes, nativeLinks);

  // Only the proven own catalogue transition may alter derived physical IDs.
  // Every other original byte/profile/metadata/span/authority fact stays exact.
  if (!equal(physicalFacts(actual.physicalSources), physicalFacts(decoded.sourceEvidence.physicalSources))) fail();
  const expected = decoded.nativeGraphPlan;
  if (expected.contractVersion !== 3) fail();
  const finalNamespace = expected.finalNamespace.filter(entity => !inferredDirectory(entity)
    || expected.finalNamespace.some(descendant => !inferredDirectory(descendant) && descendant.path.startsWith(`${entity.path}/`)));
  const actualNamespace = actual.namespace;
  if (actualNamespace.length !== finalNamespace.length || new Set(actualNamespace.map(entry => entry.path)).size !== actualNamespace.length) fail();
  const snapshot = workspaceOperationMixedSourceSnapshot(actual), graph = buildWorkspaceMixedReadLinkGraphV3(snapshot);
  if (!graph.coverage.complete || graph.coverage.gaps.length || graph.edges.length !== expected.finalEdges.length) fail();
  const nativeEdges = graph.edges.filter((edge): edge is NativeResolvedLink & { sourceKind: 'native' } => edge.sourceKind === 'native');
  for (const entity of finalNamespace) {
    const entry = actualNamespace.find(candidate => candidate.path === entity.path), binding = entity.binding;
    if (!entry || binding.kind !== 'existing' || entry.workspaceId !== entity.workspaceId || entry.kind !== entity.kind
      || entry.documentId !== binding.namespaceEvidence.documentId || entry.lifecycleGeneration !== binding.namespaceEvidence.lifecycleGeneration
      || entity.entityKey !== entityKey(binding.namespaceEvidence)) fail();
    if (!entry.documentId && entry.kind === 'file' && !equal(entry, binding.namespaceEvidence)) fail();
    if (entry.documentId && entry.identity !== binding.namespaceEvidence.identity) fail();
    if (entry.kind === 'directory' && directoryIdentity(entry) !== directoryIdentity(binding.namespaceEvidence)) fail();
    const inventory = snapshot.documents.find(item => item.document.documentId === entry.documentId);
    const state = finalObservation.privateNativeStates.find(item => item.documentId === entry.documentId);
    if (entry.documentId) {
      if (!inventory || !state || entity.physicalReadSource !== undefined
        || nativeLinkJsonProof(authoritativeNativeCollaborationSnapshot(state).content) !== entity.contentBasisProof
        || !equal(inventory.metadata, entity.metadata)) fail();
      const prior = decoded.sourceEvidence.nativeComponent.stage.sources.find(source => source.inventory.document.documentId === entry.documentId);
      if (!prior) fail();
      const removed = new Set(recipes.filter(recipe => recipe.source.documentId === entry.documentId).map(recipe => recipe.linkId));
      const retained = prior.inventory.links.filter(link => !removed.has(link.id));
      const edges = nativeEdges.filter(edge => edge.source.documentId === entry.documentId);
      if (edges.length !== retained.length) fail();
      for (const [index, link] of retained.entries()) {
        const edge = edges[index], desired = expected.finalEdges.find(item => item.sourceEntityKey === entity.entityKey && item.originEvidenceLinkId === link.id);
        const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? entityKey(edge.resolution.target) : null,
          candidateEntityKeys: edge.resolution.candidates.map(entityKey).sort() };
        if (!desired || desired.physicalReadSource !== undefined || desired.literal !== edge.literal
          || desired.targetPathText !== edge.targetPathText || !equal(desired.resolution, resolution)) fail();
      }
    } else {
      if (inventory || state || entity.contentBasisProof !== null) fail();
      const physical = decoded.sourceEvidence.physicalSources.find(source => source.path === entity.path);
      if (!physical) {
        if (entity.physicalReadSource !== undefined || entity.metadata !== null) fail();
        continue;
      }
      if (entry.kind !== 'file' || !equal(entity.physicalReadSource, { physicalSourceProof: physical.physicalSourceProof })
        || !equal(entity.metadata, physical.metadata)) fail();
      const edges = graph.edges.filter(edge => edge.sourceKind === 'physical-read' && edge.source.path === physical.path);
      if (edges.length !== physical.links.length) fail();
      for (const [index, link] of physical.links.entries()) {
        const edge = edges[index], desired = expected.finalEdges.find(item => item.sourceEntityKey === entity.entityKey
          && item.originEvidenceLinkId === link.physicalLinkId && item.physicalReadSource === true);
        const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? entityKey(edge.resolution.target) : null,
          candidateEntityKeys: edge.resolution.candidates.map(entityKey).sort() };
        if (!desired || desired.literal !== edge.literal || desired.targetPathText !== edge.targetPathText || !equal(desired.resolution, resolution)) fail();
      }
    }
  }
}
