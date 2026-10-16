import 'server-only';

import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { NativeCopyDocumentReceipt, NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { NativeMixedBatchPlan } from '../markdown/workspace-native-mixed-batch-compiler';
import { buildWorkspaceNativeLinkGraph } from '../markdown/workspace-native-link-graph';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';

export class NativeCopyFinalGraphError extends Error {
  readonly status = 409;
  readonly code = 'NATIVE_COPY_FINAL_GRAPH_CHANGED';
  constructor() { super('The actual copy does not match its complete original native graph.'); }
}
function fail(): never { throw new NativeCopyFinalGraphError(); }
const key = (workspaceId: string, filePath: string) => JSON.stringify([workspaceId, filePath]);
const entityKey = (entry: NativeNamespaceEntry) => proof({ workspaceId: entry.workspaceId, identity: entry.identity });
const directoryKey = (entry: NativeNamespaceEntry) => entry.filesystemIdentity === null ? entry.identity
  : `directory:${entry.filesystemIdentity.split(':').slice(0, 2).join(':')}`;
const implied = (entry: NativeNamespaceEntry) => entry.kind === 'directory' && entry.filesystemIdentity === null
  && entry.identity === `registry-directory:${proof({ workspaceId: entry.workspaceId, path: entry.path })}`;

/** Rewrites semantic node IDs only. Link literals, frontmatter and arbitrary
 * user strings that happen to contain an ID remain untouched. */
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

/** Pure postcondition, never an authority/ownership or COMMIT check. The fixed
 * Copy owner must supply its freshly replayed C1 compiler result, original
 * snapshots, immutable initial copy receipt, actual complete final inventories
 * and native bytes, and physical facts verified against its original FD caps.
 * No source anchor or initial clone-link ID is reused after the link delta.
 * This comparison includes all original documents and resolution candidates.
 */
export function assertNativeCopyFinalGraph(input: {
  compiled: NativeMixedBatchPlan;
  originals: readonly NativeWorkspaceLinkSnapshot[];
  receipt: NativeCopyReceipt;
  final: readonly NativeWorkspaceLinkSnapshot[];
  states: readonly PersistedCollaborationState[];
  physicalCopies: readonly Readonly<{ entityKey: string; entry: NativeNamespaceEntry }>[];
  createdParents: readonly NativeNamespaceEntry[];
}): void {
  try { assertCopyGraph(input); }
  catch (error) { if (error instanceof NativeCopyFinalGraphError) throw error; fail(); }
}

function assertCopyGraph(input: Parameters<typeof assertNativeCopyFinalGraph>[0]): void {
  const { compiled, originals, receipt, final, states, physicalCopies, createdParents } = input;
  if (compiled.contractVersion !== 2 || compiled.compilerVersion !== 1 || compiled.executionReady !== false
    || compiled.requests.length !== 1 || compiled.requests[0].kind !== 'copy' || compiled.issues.length
    || !compiled.finalGraphProof || !['ready', 'requires-clone-rebinding'].includes(compiled.readiness)
    || receipt.version !== 1 || receipt.workspaceId !== compiled.requests[0].destinationWorkspaceId
    || !['native_committed', 'published'].includes(receipt.publicationStatus)) fail();
  const beforeWorkspaces = new Set(originals.map(snapshot => snapshot.workspaceId));
  if (beforeWorkspaces.size !== originals.length || final.length !== originals.length
    || new Set(final.map(snapshot => snapshot.workspaceId)).size !== final.length
    || final.some(snapshot => !beforeWorkspaces.has(snapshot.workspaceId))) fail();
  for (const snapshot of [...originals, ...final]) {
    const { snapshotProof, ...body } = snapshot;
    if (snapshot.contractVersion !== 2 || !snapshot.coverage.complete || snapshot.coverage.gaps.length
      || snapshotProof !== proof(body) || snapshot.namespace.some(entry => entry.workspaceId !== snapshot.workspaceId)) fail();
  }
  if (!equal(originals.map(snapshot => ({ workspaceId: snapshot.workspaceId, proof: snapshot.snapshotProof }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  [...compiled.snapshotProofs].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)))) fail();
  const originalEntries = new Map<string, NativeNamespaceEntry>();
  const originalInventories = new Map<string, NativeDocumentLinkInventory>();
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
  const actual = new Map<string, NativeNamespaceEntry>(), inventories = new Map<string, NativeDocumentLinkInventory>();
  const nativeStates = new Map(states.map(state => [state.documentId, state]));
  if (nativeStates.size !== states.length) fail();
  const impliedParents = new Set<string>();
  const nativeCloneParents = new Set<string>();
  const changedLinkEntities = new Set(compiled.steps[0].linkIntents.map(intent => intent.entityKey));
  for (const entity of compiled.finalNamespace) {
    let parent = path.posix.dirname(entity.path);
    while (parent !== '.' && parent !== '/') {
      const parentKey = key(entity.workspaceId, parent); impliedParents.add(parentKey);
      if (entity.binding.kind === 'unbound-copy' && entity.contentBasisProof !== null) nativeCloneParents.add(parentKey);
      parent = path.posix.dirname(parent);
    }
  }
  for (const snapshot of final) {
    for (const inventory of snapshot.documents) {
      const id = inventory.document.documentId, state = nativeStates.get(id);
      if (inventories.has(id) || !state || state.workspaceId !== snapshot.workspaceId
        || !equal(inventory, inspectPersistedDocumentLinks(state))) fail();
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
        if (original.documentId !== null) {
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
      if (entity.contentBasisProof !== null) {
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
  const graphs = final.map(buildWorkspaceNativeLinkGraph);
  if (graphs.some(graph => !graph.coverage.complete || graph.coverage.gaps.length)
    || graphs.reduce((count, graph) => count + graph.edges.length, 0) !== compiled.finalEdges.length) fail();
  const edgesByDocument = new Map<string, (typeof graphs)[number]['edges']>();
  for (const graph of graphs) for (const edge of graph.edges) {
    const edges = edgesByDocument.get(edge.source.documentId) ?? [];
    edges.push(edge); edgesByDocument.set(edge.source.documentId, edges);
  }
  const desiredEdges = new Map(compiled.finalEdges.map(edge => [JSON.stringify([edge.sourceEntityKey, edge.originEvidenceLinkId]), edge]));
  if (desiredEdges.size !== compiled.finalEdges.length) fail();
  for (const entity of compiled.finalNamespace) {
    const entry = actual.get(key(entity.workspaceId, entity.path))!;
    if (!entry.documentId) continue;
    const original = entity.binding.kind === 'existing' ? entity.binding.namespaceEvidence : originalEntries.get(entity.binding.sourceEntityKey);
    const before = original?.documentId ? originalInventories.get(original.documentId) : undefined;
    const edges = edgesByDocument.get(entry.documentId) ?? [];
    if (!before || edges.length !== before.links.length) fail();
    const targetKey = (target: NativeNamespaceEntry) => {
      const actualTarget = actual.get(key(target.workspaceId, target.path));
      if (!equal(target, actualTarget)) fail();
      return expected.get(key(target.workspaceId, target.path))?.entityKey ?? fail();
    };
    for (const [index, link] of before.links.entries()) {
      const wanted = desiredEdges.get(JSON.stringify([entity.entityKey, link.id])), edge = edges[index];
      const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? targetKey(edge.resolution.target) : null,
        candidateEntityKeys: edge.resolution.candidates.map(targetKey).sort() };
      if (!wanted || wanted.literal !== edge.literal || wanted.targetPathText !== edge.targetPathText || !equal(wanted.resolution, resolution)) fail();
    }
  }
}
