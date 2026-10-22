import 'server-only';

import path from 'node:path';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { NativeCopyDocumentReceipt, NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { NativeNamespaceEntry, NativeResolvedLink } from '../markdown/workspace-link-contract-v2';
import type { NativeMixedHtmlImportCopyBatchPlanV6 } from '../markdown/workspace-native-mixed-batch-compiler';
import { buildWorkspaceMixedHtmlLinkGraphV5, workspaceMixedHtmlBlockingCoverageV5 } from '../markdown/workspace-native-link-graph';
import { inspectPersistedDocumentLinksV4, nativeLinkJsonProof as proof,
  type NativeDocumentLinkInventoryV4 } from '../markdown/workspace-native-link-inventory';
import { decodeWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5,
  type WorkspaceOperationMixedSourceEvidenceV5, type WorkspaceOperationMixedSourceSnapshotV5 } from './workspace-operation-mixed-source-evidence-v5';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import type { WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import { decodeNativeCopyMarkdownBirthV1, nativeCopyMarkdownImportIds, type NativeCopyMarkdownBirthV1 } from '../collaboration/native-copy-markdown-birth-contract';
import type { NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import { formatNativeLinkTargetForPathChange } from '../markdown/workspace-native-mixed-batch-compiler';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import type { ManagedCopyRawImportRequirementV7 } from './workspace-operation-managed-copy-plan-v7';
import { decodeRawHtmlSourceBindingV1 } from '../markdown/workspace-raw-html-source-binding';
import { NativeCopyFinalGraphError } from './workspace-operation-native-copy-graph';

export type NativeCopyFinalRawHtmlGraphInput = {
  compiled: NativeMixedHtmlImportCopyBatchPlanV6; originals: readonly WorkspaceOperationMixedSourceSnapshotV5[];
  final: readonly WorkspaceOperationMixedSourceSnapshotV5[]; receipt: NativeCopyReceipt;
  states: readonly PersistedCollaborationState[];
  physicalCopies: readonly Readonly<{ entityKey: string; entry: NativeNamespaceEntry }>[];
  createdParents: readonly NativeNamespaceEntry[];
  rawParent: Pick<NativeCopyMarkdownBirthV1['parent'],'operationId'|'planId'|'stageDigest'|'requestHash'>;
  rawRequirements: readonly ManagedCopyRawImportRequirementV7[]; rawBirths: readonly NativeCopyMarkdownBirthV1[];
  rawLinkReceipts: readonly NativeLinkMutationReceipt[];
  physicalEvidence: readonly Readonly<{ original: WorkspaceOperationMixedSourceEvidenceV5;
    current: WorkspaceOperationMixedSourceEvidenceV5; currentCatalogue: readonly Readonly<WorkspaceDocumentCatalogueEntry>[] }>[];
};
function fail(): never { throw new NativeCopyFinalGraphError(); }
const key = (workspaceId: string, filePath: string) => JSON.stringify([workspaceId, filePath]);
const entityKey = (entry: NativeNamespaceEntry) => proof({ workspaceId: entry.workspaceId, identity: entry.identity });
const directoryKey = (entry: NativeNamespaceEntry) => entry.filesystemIdentity === null ? entry.identity
  : `directory:${entry.filesystemIdentity.split(':').slice(0, 2).join(':')}`;
const implied = (entry: NativeNamespaceEntry) => entry.kind === 'directory' && entry.filesystemIdentity === null
  && entry.identity === `registry-directory:${proof({ workspaceId: entry.workspaceId, path: entry.path })}`;

/** Pure E5 postcondition. Current principal/B/XID/admission/FD and SQL receipt
 * authority remain mandatory in the fixed owner before calling this function. */
export function assertNativeCopyFinalRawHtmlGraphV6(input: NativeCopyFinalRawHtmlGraphInput): void {
  try { assertRawHtmlCopyGraph(input); }
  catch (error) { if (error instanceof NativeCopyFinalGraphError) throw error; fail(); }
}
function normalizedCloneContent(state: PersistedCollaborationState, receipt: NativeCopyDocumentReceipt): unknown {
  const content = structuredClone(authoritativeNativeCollaborationSnapshot(state).content);
  const mapping = receipt.blockIdMapping;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))) fail();
  const reverse = new Map<string, string>();
  for (const original of Reflect.ownKeys(mapping)) {
    const property = Object.getOwnPropertyDescriptor(mapping, original);
    if (typeof original !== 'string' || !original || !property?.enumerable || !Object.hasOwn(property, 'value')
      || typeof property.value !== 'string' || !property.value || reverse.has(property.value)) fail();
    reverse.set(property.value, original);
  }
  const used = new Set<string>();
  const visit = (node: JSONContent): void => {
    if (node.type !== 'doc' && node.type !== 'text') {
      const id = node.attrs?.id, original = typeof id === 'string' ? reverse.get(id) : undefined;
      if (!original || used.has(id!)) fail();
      used.add(id!); node.attrs = { ...node.attrs, id: original };
    }
    for (const child of node.content ?? []) visit(child);
  };
  if (content.kind === 'rich_text') visit(content.document);
  if (used.size !== reverse.size) fail();
  return content;
}

function assertRawHtmlCopyGraph(input: NativeCopyFinalRawHtmlGraphInput): void {
  const { compiled, originals, receipt, final, states, physicalCopies, createdParents } = input;
  if (compiled.contractVersion !== 6 || compiled.compilerVersion !== 1 || compiled.executionReady !== false
    || !compiled.htmlAssessment.complete || compiled.htmlAssessment.blockers.length
    || !/^[a-f0-9]{64}$/u.test(compiled.htmlAssessmentProof)
    || compiled.requests.length !== 1 || compiled.requests[0].kind !== 'copy' || compiled.issues.length
    || !compiled.finalGraphProof || !['ready', 'requires-clone-rebinding', 'requires-import-rebinding'].includes(compiled.readiness)
    || receipt.version !== 1 || receipt.workspaceId !== compiled.requests[0].destinationWorkspaceId
    || !['native_committed', 'published'].includes(receipt.publicationStatus)) fail();
  const beforeWorkspaces = new Set(originals.map(snapshot => snapshot.workspaceId));
  if (beforeWorkspaces.size !== originals.length || final.length !== originals.length
    || new Set(final.map(snapshot => snapshot.workspaceId)).size !== final.length
    || final.some(snapshot => !beforeWorkspaces.has(snapshot.workspaceId))) fail();
  const raw = assertRawCopyBirths(input);
  for (const [cohort, version] of [[originals, 5],
    [final, 5]] as const) for (const snapshot of cohort) {
    const { snapshotProof, ...body } = snapshot;
    if (snapshot.contractVersion !== version
      || workspaceMixedHtmlBlockingCoverageV5(snapshot).length
      || snapshotProof !== proof(body) || snapshot.namespace.some(entry => entry.workspaceId !== snapshot.workspaceId)) fail();
  }
  assertRawHtmlCopyPhysicalReadSources(input,raw);
  if ([...originals, ...final].some(snapshot => snapshot.namespace.some(entry => entry.provider === 'excalidraw'))) fail();
  if (!equal(originals.map(snapshot => ({ workspaceId: snapshot.workspaceId, proof: snapshot.snapshotProof }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  [...compiled.snapshotProofs].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)))) fail();
  if (!equal(originals.map(snapshot => ({ workspaceId: snapshot.workspaceId, coverage: snapshot.coverage }))
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
  [...compiled.sourceCoverage].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)))) fail();
  const originalEntries = new Map<string, NativeNamespaceEntry>();
  const originalInventories = new Map<string, NativeDocumentLinkInventoryV4>();
  for (const snapshot of originals) {
    for (const entry of snapshot.namespace) {
      const id = entityKey(entry); if (originalEntries.has(id)) fail(); originalEntries.set(id, entry);
    }
    for (const inventory of snapshot.documents) {
      if (originalInventories.has(inventory.document.documentId)) fail();
      originalInventories.set(inventory.document.documentId, inventory);
    }
  }
  const physical = new Map(physicalCopies.map(item => [item.entityKey, item.entry]));
  const parents = new Map(createdParents.map(entry => [key(entry.workspaceId, entry.path), entry]));
  if (physical.size !== physicalCopies.length || parents.size !== createdParents.length) fail();
  const cloneReceipts = new Map(receipt.documents.map(item => [item.clone.documentId, item]));
  const requiredClones = compiled.finalNamespace.filter(entity => entity.binding.kind === 'unbound-copy' && entity.contentBasisProof !== null);
  if (cloneReceipts.size !== receipt.documents.length || requiredClones.length !== receipt.documents.length) fail();
  const expected = new Map(compiled.finalNamespace.map(entity => [key(entity.workspaceId, entity.path), entity]));
  if (expected.size !== compiled.finalNamespace.length) fail();
  const actual = new Map<string, NativeNamespaceEntry>(), inventories = new Map<string, NativeDocumentLinkInventoryV4>();
  const nativeStates = new Map(states.map(state => [state.documentId, state]));
  if (nativeStates.size !== states.length) fail();
  const impliedParents = new Set<string>();
  const nativeCloneParents = new Set<string>();
  const changedLinkEntities = new Set(compiled.steps[0].linkIntents.map(intent => intent.entityKey));
  for (const entity of compiled.finalNamespace) {
    let parent = path.posix.dirname(entity.path);
    while (parent !== '.' && parent !== '/') {
      const parentKey = key(entity.workspaceId, parent); impliedParents.add(parentKey);
      if (entity.binding.kind === 'unbound-import' || entity.binding.kind === 'unbound-copy' && entity.contentBasisProof !== null) nativeCloneParents.add(parentKey);
      parent = path.posix.dirname(parent);
    }
  }
  for (const snapshot of final) {
    for (const inventory of snapshot.documents) {
      const id = inventory.document.documentId, state = nativeStates.get(id);
      if (inventories.has(id) || !state || state.workspaceId !== snapshot.workspaceId
        || !equal(inventory, inspectPersistedDocumentLinksV4(state))) fail();
      inventories.set(id, inventory);
    }
    for (const entry of snapshot.namespace) {
      const id = key(entry.workspaceId, entry.path);
      if (actual.has(id)) fail(); actual.set(id, entry);
      const entity = expected.get(id);
      if (!entity) {
        if (entry.kind !== 'directory' || entry.documentId !== null || entry.lifecycleGeneration !== null
          || (!equal(entry, parents.get(id)) && !(impliedParents.has(id) && implied(entry)))) fail();
        continue;
      }
      if (entry.kind !== entity.kind) fail();
      let original: NativeNamespaceEntry | undefined;
      let clone: NativeCopyDocumentReceipt | undefined;
      if (entity.binding.kind === 'existing') {
        original = entity.binding.namespaceEvidence;
        if (!equal(originalEntries.get(entity.entityKey), original) || entry.documentId !== original.documentId
          || entry.lifecycleGeneration !== original.lifecycleGeneration) fail();
        if (entry.kind === 'directory') {
          if (directoryKey(entry) !== directoryKey(original)
            && !(implied(original) && equal(entry, parents.get(id)))) fail();
        } else if (entry.documentId ? entry.identity !== original.identity : !equal(entry, original)) fail();
      } else {
        original = originalEntries.get(entity.binding.sourceEntityKey);
        if (!original || original.kind !== entry.kind) fail();
        if (entity.binding.kind === 'unbound-import') {
          const birth = entry.documentId ? raw.get(entry.documentId) : undefined;
          if (!birth || birth.parent.entityKey !== entity.entityKey || original.documentId !== null
            || entry.lifecycleGeneration !== 1 || entry.identity !== `registry:${entry.documentId}:1`) fail();
        } else if (original.documentId !== null) {
          clone = entry.documentId ? cloneReceipts.get(entry.documentId) : undefined;
          const source = originalInventories.get(original.documentId);
          if (!clone || !source || clone.version !== 1 || clone.source.documentId !== original.documentId
            || clone.source.lifecycleGeneration !== original.lifecycleGeneration || clone.source.stateProof !== source.version.stateProof
            || clone.source.documentSequence !== source.version.documentSequence || clone.clone.path !== entry.path
            || clone.clone.lifecycleGeneration !== 1 || clone.clone.initialSequence !== 0 || entry.lifecycleGeneration !== 1
            || entry.identity !== `registry:${clone.clone.documentId}:1` || original.documentId === clone.clone.documentId) fail();
          cloneReceipts.delete(clone.clone.documentId);
        } else {
          const logicalParent = implied(original) && implied(entry) && nativeCloneParents.has(id);
          if (entry.documentId !== null || entry.lifecycleGeneration !== null
            || !logicalParent && !equal(entry, physical.get(entity.entityKey))) fail();
          if (!logicalParent) physical.delete(entity.entityKey);
        }
      }
      const inventory = entry.documentId ? inventories.get(entry.documentId) : undefined;
      const state = entry.documentId ? nativeStates.get(entry.documentId) : undefined;
      if (entity.binding.kind === 'unbound-import') {
        if (!inventory || !state || !equal(inventory.metadata,entity.metadata)) fail();
      } else if (entity.contentBasisProof !== null) {
        if (!inventory || !state || inventory.document.path !== entry.path || inventory.document.lifecycleGeneration !== entry.lifecycleGeneration
          || proof(clone ? normalizedCloneContent(state, clone) : authoritativeNativeCollaborationSnapshot(state).content) !== entity.contentBasisProof
          || !equal(inventory.metadata, entity.metadata)) fail();
        if (clone) {
          const source = nativeStates.get(clone.source.documentId);
          const changedLinks = changedLinkEntities.has(entity.entityKey);
          if (!source || source.newlineStyle !== state.newlineStyle || source.hasBom !== state.hasBom
            || source.representation !== state.representation || source.schemaVersion !== state.schemaVersion
            || state.documentSequence !== (changedLinks ? 1 : 0)
            || !changedLinks && inventory.version.stateProof !== clone.clone.stateProof) fail();
        }
        if (!clone) {
          const before = originalInventories.get(entry.documentId!);
          if (!before || !equal(inventory, before)) fail();
        }
      } else if (inventory || state || entry.documentId !== null) fail();
    }
  }
  if (cloneReceipts.size || physical.size || states.length !== inventories.size
    || [...expected.keys()].some(id => !actual.has(id))) fail();
  for (const [id, parent] of parents) if (parent.kind !== 'directory' || parent.documentId !== null
    || parent.lifecycleGeneration !== null || !equal(parent, actual.get(id))) fail();
  const graphs = final.map(snapshot => {
    const graph=buildWorkspaceMixedHtmlLinkGraphV5(snapshot);
    return {...graph,edges:graph.edges.filter(edge=>edge.sourceKind==='physical-read'||!raw.has(edge.source.documentId)
      ||edge.classification==='local'||edge.classification==='anchor-only'&&edge.kind==='wiki')};
  });
  if (graphs.some(graph => workspaceMixedHtmlBlockingCoverageV5(graph).length)
    || graphs.reduce((count, graph) => count + graph.edges.length, 0) !== compiled.finalEdges.length) fail();
  const edgesByDocument = new Map<string, NativeResolvedLink[]>();
  for (const graph of graphs) for (const edge of graph.edges) {
    if ('sourceKind' in edge && edge.sourceKind === 'physical-read') continue;
    const edges = edgesByDocument.get(edge.source.documentId) ?? [];
    edges.push(edge); edgesByDocument.set(edge.source.documentId, edges);
  }
  const desiredEdges = new Map(compiled.finalEdges.map(edge => [JSON.stringify([edge.sourceEntityKey, edge.originEvidenceLinkId]), edge]));
  if (desiredEdges.size !== compiled.finalEdges.length) fail();
  for (const entity of compiled.finalNamespace) {
    const entry = actual.get(key(entity.workspaceId, entity.path))!;
    if (!entry.documentId) {
      if (!entity.physicalReadSource) continue;
      const original = originals.find(snapshot => snapshot.workspaceId === entity.workspaceId);
      const source = original?.contractVersion === 5 ? original.physicalSources.find(source => source.path === entity.path) : undefined;
      const graph = graphs.find(graph => graph.workspaceId === entity.workspaceId);
      if (!source || !graph || graph.contractVersion !== 5 || entity.binding.kind !== 'existing'
        || entity.physicalReadSource.physicalSourceProof !== source.physicalSourceProof) fail();
      const edges = graph.edges.filter(edge => edge.sourceKind === 'physical-read' && edge.source.path === source.path);
      if (edges.length !== source.links.length) fail();
      const targetKey = (target: NativeNamespaceEntry) => {
        if (!equal(target, actual.get(key(target.workspaceId, target.path)))) fail();
        return expected.get(key(target.workspaceId, target.path))?.entityKey ?? fail();
      };
      for (const [index, link] of source.links.entries()) {
        const wanted = desiredEdges.get(JSON.stringify([entity.entityKey, link.physicalLinkId])), edge = edges[index];
        const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? targetKey(edge.resolution.target) : null,
          candidateEntityKeys: edge.resolution.candidates.map(targetKey).sort() };
        if (!wanted || wanted.physicalReadSource !== true || wanted.literal !== edge.literal
          || wanted.targetPathText !== edge.targetPathText || !equal(wanted.resolution, resolution)) fail();
      }
      continue;
    }
    const original = entity.binding.kind === 'existing' ? entity.binding.namespaceEvidence : originalEntries.get(entity.binding.sourceEntityKey);
    const birth=entity.binding.kind==='unbound-import'?raw.get(entry.documentId):undefined;
    const before = birth ? birth.binding.nativeInventory : original?.documentId ? originalInventories.get(original.documentId) : undefined;
    const edges = edgesByDocument.get(entry.documentId) ?? [];
    // Physical sources expose local occurrences only. The complete unchanged
    // external/anchor content is separately bound by the full native stateProof.
    const links = birth ? before?.links.filter(link=>birth.binding.links.some(binding=>binding.nativeLinkId===link.id)) : before?.links;
    if (!links || edges.length !== links.length) fail();
    const targetKey = (target: NativeNamespaceEntry) => {
      const actualTarget = actual.get(key(target.workspaceId, target.path));
      if (!equal(target, actualTarget)) fail();
      return expected.get(key(target.workspaceId, target.path))?.entityKey ?? fail();
    };
    for (const [index, link] of links.entries()) {
      const originId = birth ? birth.binding.links.find(binding=>binding.nativeLinkId===link.id)?.physicalLinkId : link.id;
      const wanted = originId ? desiredEdges.get(JSON.stringify([entity.entityKey, originId])) : undefined, edge = edges[index];
      const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? targetKey(edge.resolution.target) : null,
        candidateEntityKeys: edge.resolution.candidates.map(targetKey).sort() };
      if (!wanted || !equal(wanted.resolution, resolution)) fail();
      if (birth) {
        const intent=compiled.steps[0].physicalLinkIntents.find(intent=>intent.entityKey===entity.entityKey&&intent.physicalLinkId===originId);
        const formatted=intent?formatNativeLinkTargetForPathChange(link,intent.targetPathAfter,entry.path)
          :link.ref.kind==='link-mark'?link.ref.expected.href:link.ref.expected;
        const observed=edge.ref.kind==='link-mark'?edge.ref.expected.href:edge.ref.expected;
        if(typeof formatted!=='string'||observed!==formatted||link.ref.kind!==edge.ref.kind||link.kind!==edge.kind||link.syntax!==edge.syntax
          ||link.fragment!==edge.fragment||link.alias!==edge.alias||link.embed!==edge.embed)fail();
      } else if (wanted.literal !== edge.literal || wanted.targetPathText !== edge.targetPathText) fail();
    }
  }
}


/** Reverse exactly actual receipt-certified inserted catalogue rows. All
 * original rows, scopes, raw bytes, FSI, metadata and HTML facts stay bound. */
function assertRawHtmlCopyPhysicalReadSources(input: NativeCopyFinalRawHtmlGraphInput, raw: ReadonlyMap<string,NativeCopyMarkdownBirthV1>): void {
  if (input.physicalEvidence.length !== input.originals.length || input.originals.length < 1 || input.originals.length > 2) fail();
  const seen = new Set<string>(), bornIds = new Set<string>();
  for (const piece of input.physicalEvidence) {
    const original = decodeWorkspaceOperationMixedSourceEvidenceV5(piece.original), current = decodeWorkspaceOperationMixedSourceEvidenceV5(piece.current);
    const workspaceId = original.workspaceScope.workspaceId;
    if (seen.has(workspaceId) || !equal(original.workspaceScope, current.workspaceScope) || !equal(original.scope, current.scope)) fail();
    seen.add(workspaceId);
    if (!equal(input.originals.find(snapshot => snapshot.workspaceId === workspaceId), workspaceOperationMixedSourceSnapshotV5(original))
      || !equal(input.final.find(snapshot => snapshot.workspaceId === workspaceId), workspaceOperationMixedSourceSnapshotV5(current))) fail();
    const component = current.nativeComponent;
    const catalogue = captureWorkspaceOperationNativeCatalogueWitness(piece.currentCatalogue, current.workspaceScope,
      component.stage.catalogueProof!, component.nativeBindings, fail);
    if (catalogue.semanticCatalogueProof !== component.semanticCatalogueProof) fail();
    const clones = input.receipt.workspaceId === workspaceId ? input.receipt.documents : [];
    const byId = new Map(catalogue.entries.map(entry => [entry.id, entry]));
    const localBorn = new Set<string>();
    for (const birth of clones) {
      const row = byId.get(birth.clone.documentId);
      if (!row || bornIds.has(row.id) || row.lineage_id !== birth.clone.lineageId || row.path !== birth.clone.path
        || row.authority !== 'initialized' || row.lifecycle_generation !== 1) fail();
      localBorn.add(row.id); bornIds.add(row.id);
    }
    for(const birth of raw.values())if(birth.binding.receipt.target.workspaceId===workspaceId){
      const target=birth.binding.receipt.target,row=byId.get(target.documentId);
      if(!row||bornIds.has(row.id)||row.lineage_id!==target.lineageId||row.path!==target.path||row.authority!=='initialized'||row.lifecycle_generation!==1)fail();
      localBorn.add(row.id);bornIds.add(row.id);
    }
    const inverse = catalogue.entries.filter(row => !localBorn.has(row.id));
    const originalBindings = component.nativeBindings.filter(binding => !localBorn.has(binding.expected.documentId));
    const witness = captureWorkspaceOperationNativeCatalogueWitness(inverse, original.workspaceScope, proof(inverse), originalBindings, fail);
    if (witness.semanticCatalogueProof !== original.nativeComponent.semanticCatalogueProof) fail();
    const physical = (evidence: WorkspaceOperationMixedSourceEvidenceV5) => ({
      markdown: evidence.physicalSources4.map(source => {
        const { physicalSourceProof: _proof, links, authority, ...body } = source;
        const { catalogueProof: _catalogue, ...identity } = authority;
        return { ...body, authority: identity, links: links.map(({ physicalLinkId: _id, ...link }) => link) };
      }),
      html: evidence.physicalHtmlSources4.map(source => {
        const { htmlSourceProof: _proof, authority, ...body } = source;
        const { catalogueProof: _catalogue, ...identity } = authority;
        return { ...body, authority: identity };
      }),
    });
    if (!equal(physical(original), physical(current))) fail();
    for (const source of original.physicalSources4) {
      const before = original.namespace.find(entry => entry.path === source.path);
      const entity = input.compiled.finalNamespace.find(entity => entity.workspaceId === workspaceId && entity.path === source.path);
      if (!before || !entity || entity.entityKey !== entityKey(before) || entity.binding.kind !== 'existing'
        || !equal(entity.binding.namespaceEvidence, before) || entity.physicalReadSource?.physicalSourceProof !== source.physicalSourceProof) fail();
    }
  }
  if (bornIds.size !== input.receipt.documents.length + raw.size) fail();
}

function sceneArray<T>(input: readonly T[]): readonly T[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > 20_000 || Reflect.ownKeys(input).length !== input.length + 1) fail();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); return descriptor.value as T;
  });
}
function sceneField(input: unknown, name: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); return descriptor.value;
}

function assertRawCopyBirths(input: NativeCopyFinalRawHtmlGraphInput): Map<string, NativeCopyMarkdownBirthV1> {
  const parent = captureWorkspaceOperationNativePlanData(input.rawParent, fail) as NativeCopyFinalRawHtmlGraphInput['rawParent'];
  if (Object.keys(parent).length !== 4 || !parent.operationId || parent.operationId !== input.receipt.operationId
    || ![parent.planId, parent.stageDigest, parent.requestHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) fail();
  const requirements = captureWorkspaceOperationNativePlanData(input.rawRequirements, fail, 16 * 1024 * 1024) as readonly ManagedCopyRawImportRequirementV7[];
  const births = sceneArray(input.rawBirths).map(decodeNativeCopyMarkdownBirthV1), result = new Map<string, NativeCopyMarkdownBirthV1>();
  if (births.length !== requirements.length || requirements.length !== input.compiled.rawImportRequirements.length
    || input.compiled.finalNamespace.filter(entity => entity.binding.kind === 'unbound-import').length !== births.length) fail();
  const originalIds = new Set(input.originals.flatMap(snapshot => snapshot.namespace.flatMap(entry => entry.documentId ? [entry.documentId] : [])));
  const lineages = new Set<string>(), entities = new Set<string>();
  const states = new Map(input.states.map(state => [state.documentId, state]));
  const receipts = new Map<string, NativeLinkMutationReceipt>();
  for (const receipt of sceneArray(input.rawLinkReceipts)) {
    const source = sceneField(receipt, 'source') as NativeLinkMutationReceipt['source'];
    const documentId = sceneField(source, 'documentId');
    if (typeof documentId !== 'string' || receipts.has(documentId)) fail(); receipts.set(documentId, receipt);
  }
  const pieces = sceneArray(input.physicalEvidence).map(piece => ({
    original: decodeWorkspaceOperationMixedSourceEvidenceV5(sceneField(piece, 'original')),
  }));
  const originalLineages = new Set(pieces.flatMap(piece => piece.original.nativeComponent.nativeBindings.map(binding => binding.expected.lineageId)));
  for (const [index, birth] of births.entries()) {
    const requirement = requirements[index], { preparation, ordinaryRequirement, sourceBinding, ...logical } = requirement;
    void logical;
    const target = birth.binding.receipt.target, state = states.get(target.documentId);
    const source = input.originals.find(snapshot => snapshot.workspaceId === requirement.sourceWorkspaceId)
      ?.physicalSources.find(source => source.path === requirement.sourcePath);
    if(!source)fail();
    const source3=decodeRawHtmlSourceBindingV1(sourceBinding,source).original3;
    const originalEntry = input.originals.find(snapshot => snapshot.workspaceId === requirement.sourceWorkspaceId)
      ?.namespace.find(entry => entry.path === requirement.sourcePath);
    const entity = input.compiled.finalNamespace.find(entity => entity.entityKey === requirement.entityKey);
    const sourceScope = pieces.find(piece => piece.original.workspaceScope.workspaceId === requirement.sourceWorkspaceId)?.original.workspaceScope;
    const destinationScope = pieces.find(piece => piece.original.workspaceScope.workspaceId === requirement.destinationWorkspaceId)?.original.workspaceScope;
    const { requirementIndex, entityKey: birthEntity, requirementProof, ...birthParent } = birth.parent;
    const importedIds = nativeCopyMarkdownImportIds(parent.operationId, parent.stageDigest, index);
    if (!equal(ordinaryRequirement, input.compiled.rawImportRequirements[index]) || !equal(birthParent, parent)
      || requirementIndex !== index || birthEntity !== requirement.entityKey || requirementProof !== proof(requirement)
      || birth.binding.receipt.operationId !== importedIds.operationId
      || !equal(birth.origin.sourceScope, sourceScope) || !equal(birth.origin.destinationScope, destinationScope)
      || !equal(birth.origin, births[0].origin) || birth.b1TransactionId !== births[0].b1TransactionId
      || !source || source3.physicalSourceProof !== requirement.physicalSourceProof || !equal(source.physical, requirement.physical)
      || !originalEntry || originalEntry.documentId !== null || entityKey(originalEntry) !== requirement.sourceEntityKey
      || !equal(birth.binding.source, { workspaceId: source.workspaceId, organizationId: source.organizationId, path: source.path,
        physicalSourceProof: source3.physicalSourceProof, filesystemIdentity: source.physical.filesystemIdentity,
        sourceHash: source.physical.byteHash, sourceBytes: source.physical.byteLength })
      || !entity || entity.binding.kind !== 'unbound-import' || entity.binding.sourceEntityKey !== requirement.sourceEntityKey
      || entity.workspaceId !== target.workspaceId || entity.path !== target.path || entity.kind !== 'file' || entity.contentBasisProof !== null
      || entity.physicalReadSource?.physicalSourceProof !== source.physicalSourceProof
      || target.workspaceId !== requirement.destinationWorkspaceId || target.path !== requirement.destinationPath
      || target.representation !== preparation.representation || target.newlineStyle !== preparation.newlineStyle || target.hasBom !== preparation.hasBom
      || preparation.sourceHash !== source.physical.byteHash || preparation.sourceBytes !== source.physical.byteLength
      || originalIds.has(target.documentId) || originalLineages.has(target.lineageId) || result.has(target.documentId)
      || lineages.has(target.lineageId) || entities.has(requirement.entityKey)
      || input.receipt.documents.some(clone => clone.clone.documentId === target.documentId || clone.clone.lineageId === target.lineageId)
      || !state || state.path !== target.path || state.workspaceId !== target.workspaceId || state.organizationId !== target.organizationId
      || state.lifecycleGeneration !== 1 || state.schemaVersion !== target.schemaVersion || state.representation !== target.representation
      || state.newlineStyle !== target.newlineStyle || state.hasBom !== target.hasBom) fail();
    if (birth.binding.links.length !== source.links.length || requirement.linkBindings.length !== source.links.length
      || source.links.some(link => birth.binding.links.filter(binding => binding.physicalLinkId === link.physicalLinkId).length !== 1
        || requirement.linkBindings.filter(binding => binding.physicalLinkId === link.physicalLinkId).length !== 1)) fail();
    for (const link of source.links) {
      const mapped = birth.binding.links.find(binding => binding.physicalLinkId === link.physicalLinkId)!;
      const native = birth.binding.nativeInventory.links.find(link => link.id === mapped.nativeLinkId) ?? fail();
      if (native.kind !== link.kind || native.syntax !== link.syntax || native.literal !== link.targetLiteral
        || native.targetPathText !== link.targetPathText || native.fragment !== link.fragment
        || native.alias !== link.alias || native.embed !== link.embed) fail();
    }
    const current = inspectPersistedDocumentLinksV4(state), receipt = receipts.get(target.documentId);
    const changed = birth.binding.links.some(binding => {
      const original = birth.binding.nativeInventory.links.find(link => link.id === binding.nativeLinkId) ?? fail();
      const intent = input.compiled.steps[0].physicalLinkIntents.find(intent => intent.entityKey === requirement.entityKey
        && intent.physicalLinkId === binding.physicalLinkId);
      if (!intent) return false;
      const expected = formatNativeLinkTargetForPathChange(original, intent.targetPathAfter, target.path);
      if (expected === null) fail();
      return (original.ref.kind === 'link-mark' ? original.ref.expected.href : original.ref.expected) !== expected;
    });
    if (changed !== !!receipt) fail();
    assertRawCopyLinkVersion(birth, current, receipt);
    if (receipt) receipts.delete(target.documentId);
    result.set(target.documentId, birth); lineages.add(target.lineageId); entities.add(requirement.entityKey);
  }
  if (receipts.size) fail();
  return result;
}


function assertRawCopyLinkVersion(birth: NativeCopyMarkdownBirthV1, current: NativeDocumentLinkInventoryV4,
  supplied: NativeLinkMutationReceipt | undefined): void {
  const initial = birth.binding.nativeInventory;
  if (!equal(current.document, initial.document)) fail();
  if (!supplied) { const {parserVersion:_current,...currentFacts}=current; const {parserVersion:_initial,...initialFacts}=initial;
    if (!equal(currentFacts,initialFacts)) fail(); return; }
  const receipt = captureWorkspaceOperationNativePlanData({ contractVersion: sceneField(supplied, 'contractVersion'),
    source: sceneField(supplied, 'source'), before: sceneField(supplied, 'before'), after: sceneField(supplied, 'after') }, fail) as
    Pick<NativeLinkMutationReceipt, 'contractVersion' | 'source' | 'before' | 'after'>;
  const { persistedAt: _persistedAt, ...before } = initial.version;
  if (receipt.contractVersion !== 2 || !equal(receipt.source, initial.document) || !equal(receipt.before, before)
    || receipt.after.documentSequence !== initial.version.documentSequence + 1 || receipt.after.stateProof === initial.version.stateProof
    || !equal(current.version, receipt.after)) fail();
}
