import 'server-only';

import path from 'node:path';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { NativeCopyDocumentReceipt, NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { decodeNativeCopyMarkdownBirthV1, nativeCopyMarkdownImportIds,
  type NativeCopyMarkdownBirthV1 } from '../collaboration/native-copy-markdown-birth-contract';
import type { NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry, NativeResolvedLink, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceMixedReadLinkSnapshotV3 } from '../markdown/workspace-link-contract-v3';
import type { WorkspaceMixedImportFinalLinkSnapshotV4 } from '../markdown/workspace-link-final-contract-v4';
import type { NativeMixedBatchPlan, NativeMixedReadBatchPlanV3, NativeMixedImportCopyBatchPlanV4 } from '../markdown/workspace-native-mixed-batch-compiler';
import { formatNativeLinkTargetForPathChange } from '../markdown/workspace-native-mixed-batch-compiler';
import { buildWorkspaceNativeLinkGraph, buildWorkspaceMixedReadLinkGraphV3, buildWorkspaceMixedImportFinalLinkGraphV4 } from '../markdown/workspace-native-link-graph';
import { inspectPersistedDocumentLinks, inspectPersistedDocumentLinksV3, nativeLinkJsonProof as proof,
  type NativeDocumentLinkInventoryV3 } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceSceneSnapshot, captureWorkspaceSceneSnapshotHeader,
  type WorkspaceSceneSnapshotRecord } from '../excalidraw-collaboration/workspace-scene-snapshot';
import type { WorkspaceSceneCatalogueEntry } from '../collaboration/workspace-scene-catalogue';
import type { WorkspaceSceneSourceBinding } from './workspace-operation-copy-source-observation';
import type { ExcalidrawCopyBirthReceipt } from '../excalidraw-collaboration/copy-contract';
import { decodeWorkspaceOperationNativeSourceEvidenceV3,
  type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import type { WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import type { ManagedCopyRawImportRequirementV5 } from './workspace-operation-managed-copy-plan-v5';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';

export type NativeCopyFinalManagedScenes = Readonly<{
  originalBindings: readonly WorkspaceSceneSourceBinding[];
  finalSnapshots: readonly WorkspaceSceneSnapshotRecord[];
  receipt: ExcalidrawCopyBirthReceipt;
}>;

type CopyGraphSnapshot = NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3 | WorkspaceMixedImportFinalLinkSnapshotV4;
type NativeCopyFinalGraphCommon = {
  receipt: NativeCopyReceipt;
  states: readonly PersistedCollaborationState[];
  physicalCopies: readonly Readonly<{ entityKey: string; entry: NativeNamespaceEntry }>[];
  createdParents: readonly NativeNamespaceEntry[];
  managedScenes?: NativeCopyFinalManagedScenes;
};
/** These are captured fresh by the owner on its actual B, including reparsed
 * original bytes. The pure graph comparison cannot establish that freshness. */
export type NativeCopyFinalPhysicalEvidence = Readonly<{
  original: WorkspaceOperationNativeSourceEvidenceV3;
  current: WorkspaceOperationNativeSourceEvidenceV3;
  currentCatalogue: readonly Readonly<WorkspaceDocumentCatalogueEntry>[];
}>;
type NativeCopyFinalMixedGraphInput = NativeCopyFinalGraphCommon & {
  compiled: NativeMixedReadBatchPlanV3;
  originals: readonly WorkspaceMixedReadLinkSnapshotV3[];
  final: readonly WorkspaceMixedReadLinkSnapshotV3[];
  physicalEvidence: readonly NativeCopyFinalPhysicalEvidence[];
};
type NativeCopyFinalLegacyGraphInput = NativeCopyFinalGraphCommon & {
  compiled: NativeMixedBatchPlan;
  originals: readonly NativeWorkspaceLinkSnapshot[];
  final: readonly NativeWorkspaceLinkSnapshot[];
};
export type NativeCopyFinalGraphInput = NativeCopyFinalLegacyGraphInput | NativeCopyFinalMixedGraphInput;
export type NativeCopyFinalRawImportGraphInput = NativeCopyFinalGraphCommon & {
  compiled: NativeMixedImportCopyBatchPlanV4;
  originals: readonly WorkspaceMixedReadLinkSnapshotV3[];
  final: readonly WorkspaceMixedImportFinalLinkSnapshotV4[];
  physicalEvidence: readonly NativeCopyFinalPhysicalEvidence[];
  rawParent: Pick<NativeCopyMarkdownBirthV1['parent'], 'operationId' | 'planId' | 'stageDigest' | 'requestHash'>;
  rawRequirements: readonly ManagedCopyRawImportRequirementV5[];
  rawBirths: readonly NativeCopyMarkdownBirthV1[];
  /** Exact complete original durable link receipts for changed raw births.
   * No receipt is supplied for an unchanged spelling/state. */
  rawLinkReceipts: readonly NativeLinkMutationReceipt[];
};

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

function sceneSemantics(header: Readonly<WorkspaceSceneCatalogueEntry>) {
  return { documentId: header.id, lineageId: header.lineage_id, workspaceId: header.workspace_id,
    workspaceType: header.workspace_type, organizationId: header.organization_id,
    customerId: header.customer_id, projectId: header.project_id, path: header.path,
    lifecycleGeneration: header.lifecycle_generation, sceneSchemaVersion: header.scene_schema_version,
    excalidrawVersion: header.excalidraw_version, sceneSequence: header.scene_sequence, canonicalHash: header.canonical_hash };
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
/** Additional Scene postconditions within the same complete graph comparison.
 * Scene identities remain provider facts, never fabricated Yjs inventories. */
function assertManagedScenes(input: NativeCopyFinalManagedScenes | undefined,
  originals: readonly CopyGraphSnapshot[], final: readonly CopyGraphSnapshot[], compiled: NativeMixedBatchPlan | NativeMixedReadBatchPlanV3 | NativeMixedImportCopyBatchPlanV4): void {
  const originalEntries = originals.flatMap(snapshot => snapshot.namespace).filter(entry => entry.provider === 'excalidraw');
  const finalEntries = final.flatMap(snapshot => snapshot.namespace).filter(entry => entry.provider === 'excalidraw');
  if (!input) { if (originalEntries.length || finalEntries.length) fail(); return; }
  const originalFacts = new Map<string, WorkspaceSceneSourceBinding>(), originalIds = new Set<string>(), originalLineages = new Set<string>();
  for (const binding of sceneArray(input.originalBindings)) {
    const header = captureWorkspaceSceneSnapshotHeader(sceneField(binding, 'header')), identity = key(header.workspace_id, header.path);
    const contentProof = sceneField(binding, 'contentProof');
    if (sceneField(binding, 'provider') !== 'excalidraw' || typeof contentProof !== 'string' || !/^[a-f0-9]{64}$/u.test(contentProof) || originalFacts.has(identity)
      || originalIds.has(header.id) || originalLineages.has(header.lineage_id)) fail();
    originalFacts.set(identity, { provider: 'excalidraw', header, contentProof });
    originalIds.add(header.id); originalLineages.add(header.lineage_id);
  }
  if (originalFacts.size !== originalEntries.length) fail();
  for (const entry of originalEntries) {
    const binding = originalFacts.get(key(entry.workspaceId, entry.path));
    if (!binding || entry.kind !== 'file' || entry.documentId !== null || entry.lifecycleGeneration !== null
      || entry.identity !== `scene:${binding.header.id}:${binding.header.lifecycle_generation}:${binding.contentProof}`) fail();
  }
  const finalFacts = new Map<string, WorkspaceSceneSnapshotRecord>(), finalIds = new Set<string>(), finalLineages = new Set<string>();
  let remaining = 384 * 1024 * 1024;
  for (const raw of sceneArray(input.finalSnapshots)) {
    const header = captureWorkspaceSceneSnapshotHeader(sceneField(raw, 'header'));
    const charge = header.elements_bytes! + header.shared_app_state_bytes! + header.assets_bytes!;
    if (charge > remaining) fail();
    const record = captureWorkspaceSceneSnapshot(raw, { maxTotalBytes: Math.min(remaining, 128 * 1024 * 1024) });
    const actualCharge = Math.max(charge, Buffer.byteLength(JSON.stringify(record)));
    if (actualCharge > remaining) fail(); remaining -= actualCharge;
    const identity = key(record.header.workspace_id, record.header.path);
    if (finalFacts.has(identity) || finalIds.has(record.header.id) || finalLineages.has(record.header.lineage_id)) fail();
    finalFacts.set(identity, record); finalIds.add(record.header.id); finalLineages.add(record.header.lineage_id);
  }
  if (finalFacts.size !== finalEntries.length) fail();
  for (const entry of finalEntries) {
    const record = finalFacts.get(key(entry.workspaceId, entry.path));
    if (!record || entry.kind !== 'file' || entry.documentId !== null || entry.lifecycleGeneration !== null
      || entry.identity !== `scene:${record.header.id}:${record.header.lifecycle_generation}:${record.contentProof}`) fail();
  }
  for (const [identity, before] of originalFacts) {
    const current = finalFacts.get(identity);
    // Checkpoint clocks/projection bytes may advance; actual content and IDs may not.
    if (!current || !equal(sceneSemantics(before.header), sceneSemantics(current.header))) fail();
    finalFacts.delete(identity);
  }
  const receipt = input.receipt, intents = sceneArray(receipt.intent.documents), births = sceneArray(receipt.documents);
  if (receipt.version !== 1 || receipt.intent.version !== 1 || receipt.stageDigest !== receipt.intent.stageDigest
    || receipt.operationId !== receipt.intent.operationId || !/^[a-f0-9]{64}$/u.test(receipt.receiptProof)
    || intents.length !== births.length || births.length !== finalFacts.size) fail();
  const cloneIds = new Set<string>(), cloneLineages = new Set<string>();
  for (const intent of intents) {
    const source = originalFacts.get(key(intent.sourceWorkspaceId, intent.sourcePath));
    const current = finalFacts.get(key(intent.destinationWorkspaceId, intent.destinationPath));
    const birth = births.find(value => value.documentId === intent.documentId);
    const entity = compiled.finalNamespace.find(value => value.workspaceId === intent.destinationWorkspaceId && value.path === intent.destinationPath);
    if (!source || !current || !birth || !entity || entity.binding.kind !== 'unbound-copy'
      || entity.contentBasisProof !== null || originalIds.has(intent.documentId) || originalLineages.has(intent.lineageId)
      || cloneIds.has(intent.documentId) || cloneLineages.has(intent.lineageId)
      || intent.sourceDocumentId !== source.header.id || intent.sourceLineageId !== source.header.lineage_id
      || intent.sourceGeneration !== source.header.lifecycle_generation || intent.sourceSceneSequence !== source.header.scene_sequence
      || intent.sourceCanonicalHash !== source.header.canonical_hash || intent.sourceContentProof !== source.contentProof
      || entity.binding.sourceEntityKey !== entityKey(originalEntries.find(entry => entry.workspaceId === intent.sourceWorkspaceId
        && entry.path === intent.sourcePath) ?? fail())
      || current.header.id !== intent.documentId || current.header.lineage_id !== intent.lineageId
      || current.header.lifecycle_generation !== 1 || current.header.scene_sequence !== 0 || current.header.checkpoint_sequence !== 0
      || current.header.state_version !== 0 || current.scene.checkpointRevisionId !== null || current.scene.checkpointContentHash !== null
      || current.scene.checkpointedAt !== null || current.scene.degradedReason !== null
      || current.header.scene_schema_version !== source.header.scene_schema_version || current.header.excalidraw_version !== source.header.excalidraw_version
      || current.header.canonical_hash !== source.header.canonical_hash || birth.documentId !== current.header.id
      || birth.lineageId !== current.header.lineage_id || birth.workspaceId !== current.header.workspace_id || birth.path !== current.header.path
      || birth.lifecycleGeneration !== 1 || birth.sceneSequence !== 0 || birth.canonicalHash !== current.header.canonical_hash
      || birth.persistedAt !== current.scene.persistedAt) fail();
    cloneIds.add(intent.documentId); cloneLineages.add(intent.lineageId);
    finalFacts.delete(key(intent.destinationWorkspaceId, intent.destinationPath));
  }
  if (finalFacts.size) fail();
}

/** Pure postcondition, never an authority/ownership or COMMIT check. The fixed
 * Copy owner must supply its freshly replayed C1 compiler result, original
 * snapshots, immutable initial copy receipt, actual complete final inventories
 * and native bytes, and physical facts verified against its original FD caps.
 * No source anchor or initial clone-link ID is reused after the link delta.
 * This comparison includes all original documents and resolution candidates.
 */
export function assertNativeCopyFinalGraph(input: NativeCopyFinalLegacyGraphInput): void {
  try { if (input.compiled.contractVersion !== 2) fail(); assertCopyGraph(input); }
  catch (error) { if (error instanceof NativeCopyFinalGraphError) throw error; fail(); }
}

/** Explicit mixed contract; the historical entry point remains V2-only. */
export function assertNativeCopyFinalMixedGraphV3(input: NativeCopyFinalMixedGraphInput): void {
  try { if (input.compiled.contractVersion !== 3) fail(); assertCopyGraph(input); }
  catch (error) { if (error instanceof NativeCopyFinalGraphError) throw error; fail(); }
}

/** Pure B2 postcondition only. Before calling, the fixed owner must verify the
 * actual current principal/realm/FD caps, full Stage6/ManagedPlan5 replay, original
 * parent/import/birth/link/reservation ledgers and their same-B1 transaction.
 * These supplied data do not grant authority or prove COMMIT/publication.
 * CurrentEvidence remains parser 2; only actual certified raw target states are
 * separately inspected as parser 3. No re-import or current-seq0 reconstruction. */
export function assertNativeCopyFinalRawImportGraphV4(input: NativeCopyFinalRawImportGraphInput): void {
  try { if (input.compiled.contractVersion !== 4) fail(); assertCopyGraph(input); }
  catch (error) { if (error instanceof NativeCopyFinalGraphError) throw error; fail(); }
}

function assertCopyGraph(input: NativeCopyFinalGraphInput | NativeCopyFinalRawImportGraphInput): void {
  const { compiled, originals, receipt, final, states, physicalCopies, createdParents } = input;
  if (compiled.contractVersion !== 2 && compiled.contractVersion !== 3 && compiled.contractVersion !== 4 || compiled.compilerVersion !== 1 || compiled.executionReady !== false
    || compiled.requests.length !== 1 || compiled.requests[0].kind !== 'copy' || compiled.issues.length
    || !compiled.finalGraphProof || !['ready', 'requires-clone-rebinding', ...(compiled.contractVersion === 4 ? ['requires-import-rebinding'] : [])].includes(compiled.readiness)
    || receipt.version !== 1 || receipt.workspaceId !== compiled.requests[0].destinationWorkspaceId
    || !['native_committed', 'published'].includes(receipt.publicationStatus)) fail();
  const beforeWorkspaces = new Set(originals.map(snapshot => snapshot.workspaceId));
  if (beforeWorkspaces.size !== originals.length || final.length !== originals.length
    || new Set(final.map(snapshot => snapshot.workspaceId)).size !== final.length
    || final.some(snapshot => !beforeWorkspaces.has(snapshot.workspaceId))) fail();
  const raw = compiled.contractVersion === 4 ? assertRawCopyBirths(input as NativeCopyFinalRawImportGraphInput) : new Map<string, NativeCopyMarkdownBirthV1>();
  for (const [cohort, version] of [[originals, compiled.contractVersion === 4 ? 3 : compiled.contractVersion],
    [final, compiled.contractVersion]] as const) for (const snapshot of cohort) {
    const { snapshotProof, ...body } = snapshot;
    if (snapshot.contractVersion !== version
      || !snapshot.coverage.complete || snapshot.coverage.gaps.length
      || snapshotProof !== proof(body) || snapshot.namespace.some(entry => entry.workspaceId !== snapshot.workspaceId)) fail();
  }
  if (compiled.contractVersion === 3 || compiled.contractVersion === 4) assertCopyPhysicalReadSources(input as NativeCopyFinalMixedGraphInput | NativeCopyFinalRawImportGraphInput, raw);
  assertManagedScenes(input.managedScenes, originals, final, compiled);
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
  const actual = new Map<string, NativeNamespaceEntry>(), inventories = new Map<string, NativeDocumentLinkInventory | NativeDocumentLinkInventoryV3>();
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
        || !equal(inventory, raw.has(id) ? inspectPersistedDocumentLinksV3(state) : inspectPersistedDocumentLinks(state))) fail();
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
        } else if (original.provider === 'excalidraw' && input.managedScenes) {
          if (entry.provider !== 'excalidraw') fail();
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
        if (!inventory || !state || !equal(inventory.metadata, entity.metadata)) fail();
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
  const graphs = final.map(snapshot => snapshot.contractVersion === 4 ? buildWorkspaceMixedImportFinalLinkGraphV4(snapshot)
    : snapshot.contractVersion === 3 ? buildWorkspaceMixedReadLinkGraphV3(snapshot) : buildWorkspaceNativeLinkGraph(snapshot));
  if (graphs.some(graph => !graph.coverage.complete || graph.coverage.gaps.length)
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
      if (compiled.contractVersion !== 3 && compiled.contractVersion !== 4 || !entity.physicalReadSource) continue;
      const original = originals.find(snapshot => snapshot.workspaceId === entity.workspaceId);
      const source = original?.contractVersion === 3 ? original.physicalSources.find(source => source.path === entity.path) : undefined;
      const graph = graphs.find(graph => graph.workspaceId === entity.workspaceId);
      if (!source || !graph || graph.contractVersion !== 3 && graph.contractVersion !== 4 || entity.binding.kind !== 'existing'
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
    const birth = entity.binding.kind === 'unbound-import' ? raw.get(entry.documentId) : undefined;
    const before = birth ? birth.binding.nativeInventory : original?.documentId ? originalInventories.get(original.documentId) : undefined;
    const edges = edgesByDocument.get(entry.documentId) ?? [];
    // Physical sources expose local occurrences only. The complete unchanged
    // external/anchor content is separately bound by the full native stateProof.
    const links = birth ? before?.links.filter(link => birth.binding.links.some(binding => binding.nativeLinkId === link.id)) : before?.links;
    if (!links || edges.length !== links.length) fail();
    const targetKey = (target: NativeNamespaceEntry) => {
      const actualTarget = actual.get(key(target.workspaceId, target.path));
      if (!equal(target, actualTarget)) fail();
      return expected.get(key(target.workspaceId, target.path))?.entityKey ?? fail();
    };
    for (const [index, link] of links.entries()) {
      const originId = birth ? birth.binding.links.find(binding => binding.nativeLinkId === link.id)?.physicalLinkId : link.id;
      const wanted = originId ? desiredEdges.get(JSON.stringify([entity.entityKey, originId])) : undefined, edge = edges[index];
      const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? targetKey(edge.resolution.target) : null,
        candidateEntityKeys: edge.resolution.candidates.map(targetKey).sort() };
      if (!wanted || !equal(wanted.resolution, resolution)) fail();
      if (birth) {
        if (compiled.contractVersion !== 4) fail();
        const intent = compiled.steps[0].physicalLinkIntents.find(intent => intent.entityKey === entity.entityKey
          && intent.physicalLinkId === originId);
        const formatted = intent ? formatNativeLinkTargetForPathChange(link, intent.targetPathAfter, entry.path)
          : link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected;
        const observed = edge.ref.kind === 'link-mark' ? edge.ref.expected.href : edge.ref.expected;
        if (typeof formatted !== 'string' || observed !== formatted || link.ref.kind !== edge.ref.kind
          || link.kind !== edge.kind || link.syntax !== edge.syntax || link.fragment !== edge.fragment
          || link.alias !== edge.alias || link.embed !== edge.embed) fail();
      } else if (wanted.literal !== edge.literal || wanted.targetPathText !== edge.targetPathText) fail();
    }
  }
}

/** Correlate only catalogue-derived physical IDs, after validating complete
 * evidence and reversing exactly the receipt-certified native births. Raw
 * bytes, FSI, parser facts, metadata and every span remain exact. */
function assertCopyPhysicalReadSources(input: NativeCopyFinalMixedGraphInput | NativeCopyFinalRawImportGraphInput,
  raw: ReadonlyMap<string, NativeCopyMarkdownBirthV1> = new Map()): void {
  const pieces = sceneArray(input.physicalEvidence), seen = new Set<string>(), bornIds = new Set<string>();
  if (pieces.length < 1 || pieces.length > 2 || pieces.length !== input.originals.length) fail();
  const physicalKeys = new Set<string>();
  for (const piece of pieces) {
    const original = decodeWorkspaceOperationNativeSourceEvidenceV3(sceneField(piece, 'original'));
    if (Reflect.ownKeys(piece).length !== 3) fail();
    const current = decodeWorkspaceOperationNativeSourceEvidenceV3(sceneField(piece, 'current'));
    const workspaceId = original.workspaceScope.workspaceId;
    if (seen.has(workspaceId) || !equal(original.workspaceScope, current.workspaceScope)) fail();
    seen.add(workspaceId);
    const before = input.originals.find(snapshot => snapshot.workspaceId === workspaceId);
    const after = input.final.find(snapshot => snapshot.workspaceId === workspaceId);
    if (!before || !after) fail();
    const sourceScopes: WorkspaceOperationNativeSourceEvidenceV3['scope'][] = [];
    for (const [snapshot, evidence] of [[before, original], [after, current]] as const) {
      const observed = evidence.nativeComponent.stage.sources.map(source => source.inventory);
      const documents = snapshot === after && raw.size ? observed.map(inventory => {
        if (!raw.has(inventory.document.documentId)) return inventory;
        const state = input.states.find(state => state.documentId === inventory.document.documentId);
        if (!state || !equal(inventory, inspectPersistedDocumentLinks(state))) fail();
        return inspectPersistedDocumentLinksV3(state);
      }) : observed;
      if (!equal(snapshot.physicalSources, evidence.physicalSources) || !equal(snapshot.documents, documents)) fail();
      const paths = new Set(evidence.namespace.map(entry => entry.path));
      const retained = snapshot.namespace.filter(entry => {
        if (entry.provider === 'excalidraw') return false;
        if (paths.has(entry.path)) return true;
        if (!implied(entry) || !snapshot.namespace.some(child => child.provider === 'excalidraw' && child.path.startsWith(entry.path + '/'))
          || snapshot.namespace.some(child => child.path.startsWith(entry.path + '/') && child.provider !== 'excalidraw'
            && !(implied(child) && !paths.has(child.path)))) fail();
        return false;
      });
      if (!equal(retained, evidence.namespace)) fail();
      const scenePaths = new Set(snapshot.namespace.filter(entry => entry.provider === 'excalidraw').map(entry => entry.path));
      if ([...scenePaths].some(path => !evidence.scope.excludedPaths.includes(path))) fail();
      // Partition exclusions legitimately grow with confirmed Scene copies.
      // Strip only exact, actually observed Scene leaves; preserve all others.
      sourceScopes.push({ ...evidence.scope, excludedPaths: evidence.scope.excludedPaths.filter(path => !scenePaths.has(path)) });
    }
    if (!equal(sourceScopes[0], sourceScopes[1])) fail();
    const catalogue = captureWorkspaceOperationNativeCatalogueWitness(sceneField(piece, 'currentCatalogue'),
      current.workspaceScope, current.nativeComponent.stage.catalogueProof!, current.nativeComponent.nativeBindings, fail);
    if (catalogue.semanticCatalogueProof !== current.nativeComponent.semanticCatalogueProof) fail();
    const births = input.receipt.workspaceId === workspaceId ? input.receipt.documents : [];
    const byId = new Map(catalogue.entries.map(entry => [entry.id, entry]));
    for (const birth of births) {
      const row = byId.get(birth.clone.documentId);
      if (!row || bornIds.has(row.id) || row.lineage_id !== birth.clone.lineageId || row.path !== birth.clone.path
        || row.authority !== 'initialized' || row.lifecycle_generation !== 1) fail();
      bornIds.add(row.id);
    }
    // Raw IDs can be removed only after their entire ordered cohort, actual
    // receipt/state/profile and original full source evidence were certified.
    for (const birth of raw.values()) if (birth.binding.receipt.target.workspaceId === workspaceId) {
      const target = birth.binding.receipt.target, row = byId.get(target.documentId);
      if (!row || bornIds.has(row.id) || row.lineage_id !== target.lineageId || row.path !== target.path
        || row.authority !== 'initialized' || row.lifecycle_generation !== 1) fail();
      bornIds.add(row.id);
    }
    // Copy preserves original paths, hence removing inserted clone rows also
    // preserves the real database's ordering of every original catalogue row.
    const inverse = catalogue.entries.filter(entry => !bornIds.has(entry.id));
    const originalBindings = current.nativeComponent.nativeBindings.filter(binding => !bornIds.has(binding.expected.documentId));
    const witness = captureWorkspaceOperationNativeCatalogueWitness(inverse, original.workspaceScope, proof(inverse),
      originalBindings, fail);
    if (witness.semanticCatalogueProof !== original.nativeComponent.semanticCatalogueProof) fail();
    const [originalFacts, currentFacts] = [original, current].map(evidence => evidence.physicalSources.map(source => {
      const { physicalSourceProof: _proof, links, authority, ...body } = source;
      const { catalogueProof: _catalogue, ...identity } = authority;
      return { ...body, authority: identity, links: links.map(({ physicalLinkId: _id, ...link }) => link) };
    }));
    if (!equal(originalFacts, currentFacts)) fail();
    for (const source of original.physicalSources) {
      const entry = before.namespace.find(entry => entry.path === source.path);
      const entity = input.compiled.finalNamespace.find(entity => entity.workspaceId === workspaceId && entity.path === source.path);
      if (!entry || !entity || entity.entityKey !== entityKey(entry) || entity.binding.kind !== 'existing'
        || !equal(entity.binding.namespaceEvidence, entry) || !equal(entity.metadata, source.metadata)
        || entity.physicalReadSource?.physicalSourceProof !== source.physicalSourceProof) fail();
      physicalKeys.add(entity.entityKey);
    }
  }
  if (bornIds.size !== input.receipt.documents.length + raw.size || input.compiled.finalNamespace.some(entity => entity.binding.kind === 'unbound-copy'
    && physicalKeys.has(entity.binding.sourceEntityKey))) fail();
}

/** Certify complete ordered data, not ownership. The fixed owner supplies the
 * matching immutable ledgers and actual original ManagedPlan5 parent facts. */
function assertRawCopyBirths(input: NativeCopyFinalRawImportGraphInput): Map<string, NativeCopyMarkdownBirthV1> {
  const parent = captureWorkspaceOperationNativePlanData(input.rawParent, fail) as NativeCopyFinalRawImportGraphInput['rawParent'];
  if (Object.keys(parent).length !== 4 || !parent.operationId || parent.operationId !== input.receipt.operationId
    || ![parent.planId, parent.stageDigest, parent.requestHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) fail();
  const requirements = captureWorkspaceOperationNativePlanData(input.rawRequirements, fail, 16 * 1024 * 1024) as readonly ManagedCopyRawImportRequirementV5[];
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
    original: decodeWorkspaceOperationNativeSourceEvidenceV3(sceneField(piece, 'original')),
  }));
  const originalLineages = new Set(pieces.flatMap(piece => piece.original.nativeComponent.nativeBindings.map(binding => binding.expected.lineageId)));
  for (const [index, birth] of births.entries()) {
    const requirement = requirements[index], { preparation, ...logical } = requirement;
    const target = birth.binding.receipt.target, state = states.get(target.documentId);
    const source = input.originals.find(snapshot => snapshot.workspaceId === requirement.sourceWorkspaceId)
      ?.physicalSources.find(source => source.path === requirement.sourcePath);
    const originalEntry = input.originals.find(snapshot => snapshot.workspaceId === requirement.sourceWorkspaceId)
      ?.namespace.find(entry => entry.path === requirement.sourcePath);
    const entity = input.compiled.finalNamespace.find(entity => entity.entityKey === requirement.entityKey);
    const sourceScope = pieces.find(piece => piece.original.workspaceScope.workspaceId === requirement.sourceWorkspaceId)?.original.workspaceScope;
    const destinationScope = pieces.find(piece => piece.original.workspaceScope.workspaceId === requirement.destinationWorkspaceId)?.original.workspaceScope;
    const { requirementIndex, entityKey: birthEntity, requirementProof, ...birthParent } = birth.parent;
    const importedIds = nativeCopyMarkdownImportIds(parent.operationId, parent.stageDigest, index);
    if (!equal(logical, input.compiled.rawImportRequirements[index]) || !equal(birthParent, parent)
      || requirementIndex !== index || birthEntity !== requirement.entityKey || requirementProof !== proof(requirement)
      || birth.binding.receipt.operationId !== importedIds.operationId
      || !equal(birth.origin.sourceScope, sourceScope) || !equal(birth.origin.destinationScope, destinationScope)
      || !equal(birth.origin, births[0].origin) || birth.b1TransactionId !== births[0].b1TransactionId
      || !source || source.physicalSourceProof !== requirement.physicalSourceProof || !equal(source.physical, requirement.physical)
      || !originalEntry || originalEntry.documentId !== null || entityKey(originalEntry) !== requirement.sourceEntityKey
      || !equal(birth.binding.source, { workspaceId: source.workspaceId, organizationId: source.organizationId, path: source.path,
        physicalSourceProof: source.physicalSourceProof, filesystemIdentity: source.physical.filesystemIdentity,
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
    const current = inspectPersistedDocumentLinksV3(state), receipt = receipts.get(target.documentId);
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

function assertRawCopyLinkVersion(birth: NativeCopyMarkdownBirthV1, current: NativeDocumentLinkInventoryV3,
  supplied: NativeLinkMutationReceipt | undefined): void {
  const initial = birth.binding.nativeInventory;
  if (!equal(current.document, initial.document)) fail();
  if (!supplied) { if (!equal(current, initial)) fail(); return; }
  const receipt = captureWorkspaceOperationNativePlanData({ contractVersion: sceneField(supplied, 'contractVersion'),
    source: sceneField(supplied, 'source'), before: sceneField(supplied, 'before'), after: sceneField(supplied, 'after') }, fail) as
    Pick<NativeLinkMutationReceipt, 'contractVersion' | 'source' | 'before' | 'after'>;
  const { persistedAt: _persistedAt, ...before } = initial.version;
  if (receipt.contractVersion !== 2 || !equal(receipt.source, initial.document) || !equal(receipt.before, before)
    || receipt.after.documentSequence !== initial.version.documentSequence + 1 || receipt.after.stateProof === initial.version.stateProof
    || !equal(current.version, receipt.after)) fail();
}
