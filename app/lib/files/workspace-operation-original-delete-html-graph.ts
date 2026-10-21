import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { NativeNamespaceEntry, NativeResolvedLink, NativeLinkMutationRecipe } from '../markdown/workspace-link-contract-v2';
import { buildWorkspaceMixedHtmlLinkGraphV5, workspaceMixedHtmlBlockingCoverageV5 } from '../markdown/workspace-native-link-graph';
import type { NativeMixedBatchVirtualEntity } from '../markdown/workspace-native-mixed-batch-compiler';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationNativeDeleteBatchPlanV4 } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5,
  type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { decodeWorkspaceOperationNativeDeleteBatchPlan, getWorkspaceOperationNativeDeleteLinkRecipes } from './workspace-operation-native-delete-plan';
import { decodeWorkspaceOperationMixedOriginalSourceWitness } from './workspace-operation-native-original-source';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import type { WorkspaceOperationNativeHtmlSourceEvidenceV4 } from './workspace-operation-native-source-evidence';
import type { OriginalDeleteNativeLinkReceiptV4 } from './workspace-operation-original-delete-links';

function fail(): never {
  throw Object.assign(new Error('ORIGINAL_DELETE_POSTCONDITION'), { code: 'ORIGINAL_DELETE_POSTCONDITION', status: 409 });
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  return descriptor.value;
}
function binary(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) fail();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.byteLength || bytes.byteLength > maximum || bytes.toString('base64') !== value) fail();
  return bytes;
}
function inferredDirectory(entity: NativeMixedBatchVirtualEntity): boolean {
  return entity.kind === 'directory' && entity.binding.kind === 'existing'
    && entity.binding.namespaceEvidence.filesystemIdentity === null
    && entity.binding.namespaceEvidence.identity === `registry-directory:${nativeLinkJsonProof({ workspaceId: entity.workspaceId, path: entity.path })}`;
}
function directoryIdentity(entry: NativeNamespaceEntry): string {
  return entry.filesystemIdentity === null ? entry.identity : `directory:${entry.filesystemIdentity.split(':').slice(0, 2).join(':')}`;
}
function entityKey(entry: NativeNamespaceEntry): string {
  return nativeLinkJsonProof({ workspaceId: entry.workspaceId, identity: entry.identity });
}
function markdownFacts(sources: WorkspaceOperationMixedSourceEvidenceV5['physicalSources4']) {
  return sources.map(source => {
    const { physicalSourceProof: _proof, links, authority, ...body } = source;
    const { catalogueProof: _catalogue, ...identity } = authority;
    return { ...body, authority: identity, links: links.map(({ physicalLinkId: _id, ...link }) => link) };
  });
}
function htmlFacts(sources: WorkspaceOperationMixedSourceEvidenceV5['physicalHtmlSources4']) {
  return sources.map(source => {
    const { htmlSourceProof: _proof, authority, ...body } = source;
    const { catalogueProof: _catalogue, ...identity } = authority;
    return { ...body, authority: identity };
  });
}
function nativeHtmlFacts(component: WorkspaceOperationNativeHtmlSourceEvidenceV4, omittedDocumentId: string) {
  return component.htmlSources.filter(source => source.documentId !== omittedDocumentId).map(source => ({
    documentId: source.documentId, path: source.path,
    // An ordinary unlink can shift offsets/lines. Its actual ordered HTML
    // syntax and decoded targets must remain byte-for-byte the same.
    occurrences: source.inspection.occurrences.map(({ raw, fullyInspected, explicitLocalTargets }) => ({ raw, fullyInspected, explicitLocalTargets })),
  }));
}
function htmlProof(component: WorkspaceOperationNativeHtmlSourceEvidenceV4, documentId: string): string {
  const source = component.htmlSources.find(item => item.documentId === documentId);
  if (!source || source.inspection.parserVersion !== 4 || source.inspection.occurrences.some(item => !item.fullyInspected)) fail();
  return nativeLinkJsonProof({ parserVersion: 4, occurrences: source.inspection.occurrences.map(({ raw, fullyInspected, explicitLocalTargets }) => ({
    raw, fullyInspected, explicitLocalTargets,
  })) });
}

/** Local E4 comparison only. E4 is never relabelled as old E2. The genuine
 * Owner separately verifies each immutable intent/receipt and its actual B. */
function assertHtmlBindings(before: WorkspaceOperationNativeHtmlSourceEvidenceV4, actual: WorkspaceOperationNativeHtmlSourceEvidenceV4,
  targetDocumentId: string, recipes: readonly NativeLinkMutationRecipe[], receipts: readonly OriginalDeleteNativeLinkReceiptV4[]): void {
  const survivors = before.nativeBindings.filter(binding => binding.expected.documentId !== targetDocumentId);
  if (actual.nativeBindings.length !== survivors.length) fail();
  const changed = new Set(recipes.map(recipe => recipe.source.documentId));
  const byId = new Map(receipts.map(receipt => [receipt.source.documentId, receipt]));
  if (byId.size !== receipts.length || byId.size !== changed.size || [...byId.keys()].some(id => !changed.has(id))) fail();
  for (const binding of survivors) {
    const id = binding.expected.documentId, observed = actual.nativeBindings.find(item => item.expected.documentId === id), receipt = byId.get(id);
    if (!receipt) { if (!equal(observed, binding)) fail(); continue; }
    const prior = before.stage.sources.find(item => item.inventory.document.documentId === id)?.inventory;
    const inventory = actual.stage.sources.find(item => item.inventory.document.documentId === id)?.inventory;
    if (!observed || !prior || !inventory || receipt.contractVersion !== 2 || receipt.resultEvidenceVersion !== 4
      || receipt.parserVersion !== 4 || receipt.htmlSourceProof !== htmlProof(before, id) || receipt.htmlSourceProof !== htmlProof(actual, id)
      || typeof receipt.afterBinaryHash !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.afterBinaryHash)
      || receipt.afterVectorHash !== hash(binary(receipt.after.stateVector, 4 * 1024 ** 2))
      || `yjs-snapshot-sha256-v1:${hash(binary(receipt.afterStateSnapshotBase64, 4 * 1024 ** 2))}` !== receipt.after.stateProof
      || !equal(receipt.source, prior.document) || !equal(receipt.before, { stateProof: binding.expected.stateProof,
        documentSequence: binding.expected.documentSequence, stateVector: prior.version.stateVector })
      || receipt.after.documentSequence !== receipt.before.documentSequence + 1
      || !Number.isSafeInteger(receipt.after.persistedAt) || receipt.after.persistedAt < binding.expected.persistedAt) fail();
    const expected = { ...binding, expected: { ...binding.expected, stateProof: receipt.after.stateProof,
      documentSequence: receipt.after.documentSequence, persistedAt: receipt.after.persistedAt,
      binaryHash: receipt.afterBinaryHash, vectorHash: receipt.afterVectorHash }, inventoryProof: nativeLinkJsonProof(inventory) };
    if (!equal(observed, expected) || inventory.version.stateVector !== receipt.after.stateVector
      || inventory.version.stateProof !== receipt.after.stateProof || inventory.version.documentSequence !== receipt.after.documentSequence
      || inventory.version.persistedAt !== receipt.after.persistedAt) fail();
  }
}

/** Pure final comparison of actual Owner observations. The original E5
 * assessment is already sealed in the decoded plan; checking it against the
 * now-absent selected source would invent a different operation. Instead prove
 * its exact final namespace/ordinary edges and unchanged surviving HTML facts.
 * No synthetic complete coverage, actor, Claim, Admission or COMMIT is created. */
export function assertOriginalDeleteHtmlFinalGraph(plan: WorkspaceOperationNativeDeleteBatchPlanV4,
  finalObservation: WorkspaceLinkSourceAuthorityObservation,
  original: Readonly<{ sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
    nativeLinks: readonly OriginalDeleteNativeLinkReceiptV4[]; beforeObservation: WorkspaceLinkSourceAuthorityObservation }>): void {
  const decoded = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
  if (decoded.planIdentityVersion !== 4) fail();
  const witness = decodeWorkspaceOperationMixedOriginalSourceWitness(decoded.sourceEvidence, field(original, 'sourceEvidence'));
  const beforeObservation = field(original, 'beforeObservation') as WorkspaceLinkSourceAuthorityObservation;
  const receipts = captureWorkspaceOperationNativePlanData(field(original, 'nativeLinks'), fail, 2097152) as readonly OriginalDeleteNativeLinkReceiptV4[];
  if (!Array.isArray(receipts)) fail();
  const before = captureWorkspaceOperationMixedSourceEvidenceV5(witness.workspaceScope, beforeObservation);
  decodeWorkspaceOperationMixedOriginalSourceWitness(witness, before);
  const actual = captureWorkspaceOperationMixedSourceEvidenceV5(witness.workspaceScope, finalObservation);
  if (!equal(actual.scope, witness.scope)) fail();
  const beforeCatalogue = captureWorkspaceOperationNativeCatalogueWitness(field(beforeObservation, 'privateCatalogue'), before.workspaceScope,
    before.nativeComponent.stage.catalogueProof!, before.nativeComponent.nativeBindings, fail);
  const afterCatalogue = captureWorkspaceOperationNativeCatalogueWitness(field(finalObservation, 'privateCatalogue'), actual.workspaceScope,
    actual.nativeComponent.stage.catalogueProof!, actual.nativeComponent.nativeBindings, fail);
  if (beforeCatalogue.semanticCatalogueProof !== witness.nativeComponent.semanticCatalogueProof
    || beforeCatalogue.semanticCatalogueProof !== before.nativeComponent.semanticCatalogueProof
    || afterCatalogue.semanticCatalogueProof !== actual.nativeComponent.semanticCatalogueProof) fail();
  const targetId = decoded.nativeTarget.documentId, target = beforeCatalogue.entries.find(entry => entry.id === targetId);
  if (!target || target.authority !== 'initialized' || target.path !== decoded.nativeTarget.path
    || target.lineage_id !== decoded.nativeTarget.lineageId || afterCatalogue.entries.some(entry => entry.id === targetId)) fail();
  const inverse = new Map(afterCatalogue.entries.map(entry => [entry.id, entry]));
  if (inverse.size + 1 !== beforeCatalogue.entries.length) fail();
  inverse.set(targetId, target);
  const ordered = beforeCatalogue.entries.map(entry => inverse.get(entry.id) ?? fail());
  if (inverse.size !== ordered.length || new Set(ordered.map(entry => entry.id)).size !== inverse.size) fail();
  const inverseCatalogue = captureWorkspaceOperationNativeCatalogueWitness(ordered, before.workspaceScope,
    nativeLinkJsonProof(ordered), before.nativeComponent.nativeBindings, fail);
  if (inverseCatalogue.semanticCatalogueProof !== witness.nativeComponent.semanticCatalogueProof) fail();
  const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(decoded);
  assertHtmlBindings(witness.nativeComponent, actual.nativeComponent, targetId, recipes, receipts);
  if (!equal(nativeHtmlFacts(actual.nativeComponent, targetId), nativeHtmlFacts(witness.nativeComponent, targetId))
    || !equal(markdownFacts(actual.physicalSources4), markdownFacts(decoded.sourceEvidence.physicalSources4))
    || !equal(htmlFacts(actual.physicalHtmlSources4), htmlFacts(decoded.sourceEvidence.physicalHtmlSources4))) fail();
  const expected = decoded.nativeGraphPlan;
  if (expected.contractVersion !== 5) fail();
  const finalNamespace = expected.finalNamespace.filter(entity => !inferredDirectory(entity)
    || expected.finalNamespace.some(descendant => !inferredDirectory(descendant) && descendant.path.startsWith(`${entity.path}/`)));
  if (actual.namespace.length !== finalNamespace.length || new Set(actual.namespace.map(entry => entry.path)).size !== actual.namespace.length) fail();
  const snapshot = workspaceOperationMixedSourceSnapshotV5(actual), graph = buildWorkspaceMixedHtmlLinkGraphV5(snapshot);
  // Retain graph.coverage verbatim. Only the existing operation-aware policy
  // can assess HTML; every non-HTML/unsupported gap still fails closed here.
  if (workspaceMixedHtmlBlockingCoverageV5(snapshot).length || graph.edges.length !== expected.finalEdges.length) fail();
  const nativeEdges = graph.edges.filter((edge): edge is NativeResolvedLink & { sourceKind: 'native' } => edge.sourceKind === 'native');
  for (const entity of finalNamespace) {
    const entry = actual.namespace.find(candidate => candidate.path === entity.path), binding = entity.binding;
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
      const prior = decoded.sourceEvidence.nativeOrdinarySources4.find(source => source.documentId === entry.documentId)?.inventory;
      if (!prior) fail();
      const removed = new Set(recipes.filter(recipe => recipe.source.documentId === entry.documentId).map(recipe => recipe.linkId));
      const retained = prior.links.filter(link => !removed.has(link.id)), edges = nativeEdges.filter(edge => edge.source.documentId === entry.documentId);
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
      const physical = decoded.sourceEvidence.physicalSources4.find(source => source.path === entity.path);
      if (!physical) { if (entity.physicalReadSource !== undefined || entity.metadata !== null) fail(); continue; }
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
