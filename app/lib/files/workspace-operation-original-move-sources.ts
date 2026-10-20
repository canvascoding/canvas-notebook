import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { PreparedWorkspacePathMoveOriginal, PreparedWorkspacePathMoveReceipt,
  PreparedWorkspacePathMoveParentReceipt, PreparedPathMoveIdentity } from '../filesystem/prepared-workspace-path-move-contract';
import type { NativeNamespaceEntry, NativeResolvedLink, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { NativeMixedBatchPlan, NativeMixedReadBatchPlanV3, NativeMixedHtmlBatchPlanV5 } from '../markdown/workspace-native-mixed-batch-compiler';
import type { NativeFileOperationReceipt } from '../markdown/native-file-operation-handoff';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../markdown/workspace-source-authority-stage';
import { buildWorkspaceNativeLinkGraph, buildWorkspaceMixedReadLinkGraphV3, buildWorkspaceMixedHtmlLinkGraphV5,
  workspaceMixedHtmlBlockingCoverageV5 } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinksV4, inspectOriginalPhysicalHtmlV4,
  type WorkspaceSourceAuthorityStage } from '../markdown/workspace-physical-link-inventory';
import { captureWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5 } from './workspace-operation-mixed-source-evidence-v5';
import { assertWorkspaceOperationNativeMoveBatchPlanCurrent } from './workspace-operation-native-move-plan';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { workspaceOperationMixedSourceSnapshot, workspaceOperationSourceNamespace,
  workspaceOperationSourceNativeEvidence, workspaceOperationSourceScope } from './workspace-operation-mixed-source-evidence';
import { deriveWorkspacePathPhysicalParserVersion } from './workspace-operation-path-source-parser';
import { decodeWorkspaceOperationOriginalMoveParentReceipt, decodeWorkspaceOperationOriginalMovePathReceipt,
  readWorkspaceOperationOriginalMoveNativeBundle, type WorkspaceOperationOriginalMoveContext,
  type WorkspaceOperationOriginalMoveIntentData } from './workspace-operation-original-move';

export class WorkspaceOperationOriginalMoveSourcesError extends Error {
  readonly status = 409;
  constructor(readonly code: 'ORIGINAL_MOVE_SOURCES_REQUIRED' | 'ORIGINAL_MOVE_SOURCES_CHANGED'
    | 'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED') { super(code); this.name = 'WorkspaceOperationOriginalMoveSourcesError'; }
}
const fail = (code: WorkspaceOperationOriginalMoveSourcesError['code'] = 'ORIGINAL_MOVE_SOURCES_CHANGED'): never => {
  throw new WorkspaceOperationOriginalMoveSourcesError(code);
};
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const directoryIdentity = (entry: NativeNamespaceEntry) => entry.filesystemIdentity === null ? entry.identity
  : `directory:${entry.filesystemIdentity.split(':').slice(0, 2).join(':')}`;
const inferredDirectory = (entry: NativeNamespaceEntry) => entry.kind === 'directory' && entry.filesystemIdentity === null
  && entry.identity === `registry-directory:${nativeLinkJsonProof({ workspaceId: entry.workspaceId, path: entry.path })}`;
const parentOf = (filePath: string) => path.posix.dirname(filePath);

export type OriginalMoveSourceNamespaceFacts = Readonly<{
  /** Exact physical membership only. No prefix substitutions or authority. */
  moved: readonly Readonly<{ originalPath: string; currentPath: string; entry: NativeNamespaceEntry;
    /** Only the explicit HTML-aware arm carries a bound regular-file read. */
    physicalRead?: Readonly<{ currentIdentity: PreparedPathMoveIdentity; byteHash: string }> }>[];
  bornParents: readonly PreparedWorkspacePathMoveParentReceipt[];
}>;
/** Pure facts, not a collector context or import/mutation permission. Its only
 * production caller obtains every argument from the fixed genuine owner. */
export function deriveOriginalMoveSourceNamespaceFacts(context: WorkspaceOperationOriginalMoveContext,
  originals: readonly PreparedWorkspacePathMoveOriginal[], receipts: readonly PreparedWorkspacePathMoveReceipt[],
  bornParents: readonly PreparedWorkspacePathMoveParentReceipt[]): OriginalMoveSourceNamespaceFacts {
  if (originals.length !== receipts.length || originals.length > 1000 || bornParents.length > 1000) fail();
  const before = new Map(workspaceOperationSourceNamespace(context.plan.sourceEvidence).map(entry => [entry.path, entry]));
  const moved: Array<OriginalMoveSourceNamespaceFacts['moved'][number]> = [], sources = new Set<string>(), destinations = new Set<string>();
  for (const [index, original] of originals.entries()) {
    const receipt = receipts[index];
    if (!equal(receipt.original, original)) fail();
    if (original.source.kind === 'projection_absent') {
      if (receipt.observation.kind !== 'projection_absent') fail();
      continue;
    }
    if (receipt.observation.kind !== 'moved') fail();
    const currentSource = receipt.observation.kind === 'moved' ? receipt.observation.source : fail();
    const entries = original.source.kind === 'directory' ? original.source.entries
      : [{ relativePath: '', kind: 'regular_file' as const, identity: original.source.identity, sha256: original.source.sha256 }];
    for (const physical of entries) {
      const originalPath = physical.relativePath ? `${original.sourcePath}/${physical.relativePath}` : original.sourcePath;
      const currentPath = physical.relativePath ? `${original.destinationPath}/${physical.relativePath}` : original.destinationPath;
      const entry = before.get(originalPath);
      if (!entry || entry.kind !== (physical.kind === 'directory' ? 'directory' : 'file')
        || sources.has(originalPath) || destinations.has(currentPath)) fail();
      sources.add(originalPath); destinations.add(currentPath);
      let physicalRead: OriginalMoveSourceNamespaceFacts['moved'][number]['physicalRead'];
      if (context.plan.planIdentityVersion === 4 && physical.kind === 'regular_file') {
        const current = currentSource.kind === 'directory'
          ? currentSource.entries.find(item => item.relativePath === physical.relativePath)
          : currentSource.kind === 'regular_file' && physical.relativePath === '' ? currentSource : undefined;
        if (!current) return fail();
        if (current.kind !== 'regular_file') return fail();
        if (!('sha256' in physical) || current.sha256 !== physical.sha256) return fail();
        physicalRead = Object.freeze({ currentIdentity: current.identity, byteHash: current.sha256 });
      }
      moved.push(Object.freeze({ originalPath, currentPath, entry: entry!, ...(physicalRead ? { physicalRead } : {}) }));
    }
  }
  return Object.freeze({ moved: Object.freeze(moved), bornParents: Object.freeze([...bornParents]) });
}

/** Pure comparison only. Restore the saved observation order with the exact
 * FRESH gap objects, preserving duplicates and every field. This grants no
 * collector frame, Current proof, missing-source exception or mutation right. */
export function restoreOriginalMoveSourceCoverageOrder(original: WorkspaceSourceAuthorityStage['coverage'],
  current: WorkspaceSourceAuthorityStage['coverage']): WorkspaceSourceAuthorityStage['coverage'] {
  const capture = (coverage: WorkspaceSourceAuthorityStage['coverage']) => {
    const value = captureWorkspaceOperationNativePlanData(coverage, () => fail(), 8 * 1024 * 1024) as WorkspaceSourceAuthorityStage['coverage'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'complete') || !Object.hasOwn(value, 'gaps')
      || typeof value.complete !== 'boolean' || !Array.isArray(value.gaps) || value.gaps.length > 20_000
      || value.complete !== (value.gaps.length === 0)) return fail();
    for (const gap of value.gaps) {
      if (!gap || typeof gap !== 'object' || Array.isArray(gap)
        || Object.keys(gap).some(key => !['code', 'path', 'startUtf16', 'htmlTargets'].includes(key))
        || typeof gap.code !== 'string' || !gap.code || typeof gap.path !== 'string'
        || gap.startUtf16 !== undefined && (!Number.isSafeInteger(gap.startUtf16) || gap.startUtf16 < 0)
        || gap.htmlTargets !== undefined && (!Array.isArray(gap.htmlTargets) || gap.htmlTargets.length > 20_000
          || gap.htmlTargets.some(target => typeof target !== 'string'))) return fail();
    }
    return value;
  };
  const expected = capture(original), actual = capture(current);
  if (expected.complete !== actual.complete || expected.gaps.length !== actual.gaps.length) return fail();
  const byProof = new Map<string, { indexes: number[]; next: number }>();
  for (const [index, gap] of actual.gaps.entries()) {
    const proof = nativeLinkJsonProof(gap), bucket = byProof.get(proof);
    if (bucket) bucket.indexes.push(index); else byProof.set(proof, { indexes: [index], next: 0 });
  }
  const gaps = expected.gaps.map(gap => {
    const bucket = byProof.get(nativeLinkJsonProof(gap));
    if (!bucket || bucket.next >= bucket.indexes.length) return fail();
    const index = bucket.indexes[bucket.next++];
    if (!equal(gap, actual.gaps[index])) return fail();
    // Capture rejected getters, proxies, sparse arrays and oversized payloads.
    // Return the actual freshly observed object, never its historical twin.
    return Object.getOwnPropertyDescriptor(current.gaps, String(index))!.value as typeof gap;
  });
  if ([...byProof.values()].some(bucket => bucket.next !== bucket.indexes.length)) return fail();
  return { complete: actual.complete, gaps };
}

type Overlay = Readonly<{
  physicalEntry: (entry: NativeNamespaceEntry) => NativeNamespaceEntry | null;
  logicalPath: (actualPath: string) => string;
  /** Invoked only AFTER the real bounded FD read and all physical rechecks. */
  physicalSource: (actualPath: string, actualIdentity: string, bytes: Uint8Array) => { path: string; filesystemIdentity: string };
}>;
type Frame = { database: SqlConnection; workspace: WorkspaceContext; mode: 'original' | 'final';
  facts: OriginalMoveSourceNamespaceFacts; active: boolean; claimed: boolean; failed: boolean };
const frames = new AsyncLocalStorage<Frame>();
function active(frame: Frame): void {
  if (!frame.active || frames.getStore() !== frame || frame.failed) { frame.failed = true; fail('ORIGINAL_MOVE_SOURCES_REQUIRED'); }
}
/** Internal collector seam. A normal caller has no frame and gets no overlay.
 * There is deliberately no public frame setter, DTO argument or bypass flag. */
export function readOriginalMoveCollectorOverlay(database: SqlConnection, workspace: WorkspaceContext): Overlay | undefined {
  const frame = frames.getStore(); if (!frame) return undefined;
  active(frame);
  if (frame.database !== database || frame.claimed || frame.workspace.workspaceId !== workspace.workspaceId
    || frame.workspace.rootPath !== workspace.rootPath || frame.workspace.workspaceType !== workspace.workspaceType
    || (frame.workspace.organizationId ?? null) !== (workspace.organizationId ?? null)) {
    frame.failed = true; fail('ORIGINAL_MOVE_SOURCES_REQUIRED');
  }
  frame.claimed = true;
  const exact = new Map(frame.facts.moved.map(item => [item.currentPath, item]));
  const born = new Map(frame.facts.bornParents.map(item => [item.relativePath, item]));
  return Object.freeze({
    logicalPath: actualPath => { active(frame); return frame.mode === 'original' ? exact.get(actualPath)?.originalPath ?? actualPath : actualPath; },
    physicalSource: (actualPath, actualIdentity, bytes) => {
      active(frame); const item = exact.get(actualPath);
      // Historical profiles and files outside exact receipt membership retain
      // their actual physical read identity without a path substitution.
      if (!item?.physicalRead) return { path: actualPath, filesystemIdentity: actualIdentity };
      const expected = item.physicalRead.currentIdentity, identity = actualIdentity.split(':');
      if (item.entry.kind !== 'file' || !item.entry.filesystemIdentity
        || identity[0] !== expected.device || identity[1] !== expected.inode || identity[2] !== expected.size
        || hash(bytes) !== item.physicalRead.byteHash) { frame.failed = true; fail(); }
      return { path: frame.mode === 'original' ? item.originalPath : item.currentPath,
        filesystemIdentity: item.entry.filesystemIdentity! };
    },
    physicalEntry: entry => {
      active(frame); const item = exact.get(entry.path), birth = born.get(entry.path);
      if (item) {
        if (entry.kind !== item.entry.kind) { frame.failed = true; fail(); }
        // Genuine cap checks bind current inode/bytes/root rename ctime; retain
        // the ORIGINAL asset identity required by compiler entity keys.
        return { ...entry, path: frame.mode === 'original' ? item.originalPath : item.currentPath,
          identity: item.entry.identity, filesystemIdentity: item.entry.filesystemIdentity };
      }
      if (birth && frame.mode === 'original') {
        const parts = entry.filesystemIdentity?.split(':');
        if (entry.kind !== 'directory' || parts?.[0] !== birth.identity.device || parts[1] !== birth.identity.inode) {
          frame.failed = true; fail();
        }
        // A real birth can replace an original implicit parent at the same
        // logical path. The fixed reader restores that original view below.
        return null;
      }
      return entry;
    },
  });
}

type CompiledMove = NativeMixedBatchPlan | NativeMixedReadBatchPlanV3 | NativeMixedHtmlBatchPlanV5;
type Cache = { transaction: string; journalProof: string; context: WorkspaceOperationOriginalMoveContext;
  compiled: CompiledMove; facts: OriginalMoveSourceNamespaceFacts };
const preparedGraphs = new WeakMap<SqlConnection, Cache>();
async function transactionIdentity(database: SqlConnection): Promise<string> {
  const row = await database.get(`SELECT pg_backend_pid()::text AS backend_pid,
    pg_current_xact_id()::text AS transaction_id, current_schema()::regnamespace::oid::text AS schema_oid,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`) as Record<string, unknown> | undefined;
  if (!row || Object.values(row).some(value => typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value))) fail();
  return nativeLinkJsonProof(row);
}
function expectedFinalNamespace(cache: Cache): Map<string, NativeMixedBatchPlan['finalNamespace'][number]> {
  const entries = cache.compiled.finalNamespace.filter(entity => entity.binding.kind !== 'existing'
    || !inferredDirectory(entity.binding.namespaceEvidence)
    || cache.compiled.finalNamespace.some(descendant => descendant.path.startsWith(`${entity.path}/`)
      && (descendant.binding.kind !== 'existing' || !inferredDirectory(descendant.binding.namespaceEvidence))));
  return new Map(entries.map(entity => [entity.path, entity]));
}
/** Pure comparison. It confers no authority and cannot install a collector
 * overlay. Production supplies the private original-current compiler result. */
export function assertOriginalMoveFinalSourceGraph(input: {
  context: WorkspaceOperationOriginalMoveContext; intent: WorkspaceOperationOriginalMoveIntentData;
  compiled: CompiledMove; facts: OriginalMoveSourceNamespaceFacts;
  observation: WorkspaceLinkSourceAuthorityObservation; nativeReceipts: readonly NativeFileOperationReceipt[];
  /** Original path ordering using the real registry column's DB collation.
   * Data only; the complete inverse catalogue proof is still checked below. */
  catalogueOriginalOrder?: readonly string[];
}): void {
  const { context, intent, compiled, facts, observation, nativeReceipts } = input;
  const bad = () => fail('ORIGINAL_MOVE_FINAL_GRAPH_CHANGED');
  // A V3 final graph needs a genuine full catalogue and fresh original bytes,
  // even for a source which no mutation selected. Native receipts alone cannot
  // prove that an unchanged physical backlink or alias still resolves safely.
  const currentMixed = context.plan.planIdentityVersion === 4
    ? captureWorkspaceOperationMixedSourceEvidenceV5(context.plan.sourceEvidence.workspaceScope, observation)
    : context.plan.planIdentityVersion === 3
      ? captureWorkspaceOperationNativeSourceEvidenceV3(context.plan.sourceEvidence.workspaceScope, observation) : null;
  const htmlSnapshot = currentMixed?.evidenceVersion === 5 ? workspaceOperationMixedSourceSnapshotV5(currentMixed) : null;
  if (compiled.planId !== context.plan.compilerPlanProof || compiled.finalGraphProof !== context.plan.finalGraphProof
    || compiled.contractVersion !== (context.plan.planIdentityVersion === 4 ? 5 : context.plan.planIdentityVersion === 3 ? 3 : 2)
    || (htmlSnapshot ? workspaceMixedHtmlBlockingCoverageV5(htmlSnapshot).length !== 0
      : !observation.stage.coverage.complete || observation.stage.coverage.gaps.length !== 0)
    || !currentMixed && observation.stage.sources.some(source => source.kind !== 'native')
    || !equal(observation.stage.scope, workspaceOperationSourceScope(context.plan.sourceEvidence))) bad();
  const expected = expectedFinalNamespace({ context, compiled, facts, transaction: '', journalProof: '' });
  const bundle = readWorkspaceOperationOriginalMoveNativeBundle(intent), mutations = bundle?.mutations ?? [];
  if (nativeReceipts.length !== mutations.length) bad();
  const receipts = new Map(nativeReceipts.map(receipt => [receipt.source.documentId, receipt]));
  if (receipts.size !== nativeReceipts.length) bad();
  for (const mutation of mutations) {
    const receipt = receipts.get(mutation.source.documentId);
    if (!receipt || receipt.operationId !== bundle!.operationId || receipt.requestId !== bundle!.requestId
      || receipt.mutationId !== mutation.mutationId || receipt.kind !== mutation.kind || receipt.action !== bundle!.action
      || receipt.changesBundleProof !== intent.nativeBundle!.changesBundleProof || !equal(receipt.actor, bundle!.actor)
      || receipt.reviewDigest !== bundle!.reviewDigest || !equal(receipt.source, mutation.source)
      || receipt.lineageId !== mutation.lineageId || receipt.beforeRegistryStateVersion !== mutation.registryStateVersion
      || !equal(receipt.before, mutation.before) || receipt.after.status !== 'active'
      || !equal(receipt.after.identity, { ...mutation.source, path: mutation.destinationPath ?? mutation.source.path })) bad();
  }
  const originalEvidence = workspaceOperationSourceNativeEvidence(intent.version !== 1 ? intent.currentWitness : context.plan.sourceEvidence);
  const originalBindings = new Map(originalEvidence.nativeBindings.map(binding => [binding.expected.documentId, binding]));
  const bindings = new Map(observation.nativeBindings.map(binding => [binding.expected.documentId, binding]));
  const inventories = observation.stage.sources.flatMap(source => source.kind === 'native' ? [source.inventory] : []);
  if (bindings.size !== originalBindings.size || observation.nativeBindings.length !== bindings.size
    || inventories.length !== originalBindings.size || observation.privateNativeStates.length !== originalBindings.size) bad();
  const allowedParents = new Map(facts.bornParents.map(parent => [parent.relativePath, parent]));
  const impliedParents = new Set<string>();
  for (const entity of expected.values()) if (entity.kind === 'file' && entity.binding.kind === 'existing' && entity.binding.namespaceEvidence.documentId) {
    let parent = parentOf(entity.path);
    while (parent !== '.' && parent !== '/') { impliedParents.add(parent); parent = parentOf(parent); }
  }
  const actualPaths = new Set<string>();
  for (const entry of observation.stage.namespace) {
    if (actualPaths.has(entry.path)) bad(); actualPaths.add(entry.path);
    const entity = expected.get(entry.path);
    if (!entity) {
      if (entry.kind !== 'directory' || entry.documentId !== null || entry.lifecycleGeneration !== null) bad();
      const birth = allowedParents.get(entry.path);
      if (birth) {
        if (directoryIdentity(entry) !== `directory:${birth.identity.device}:${birth.identity.inode}`) bad();
      } else if (!impliedParents.has(entry.path) || !inferredDirectory(entry)) bad();
      continue;
    }
    if (entity.binding.kind !== 'existing') bad();
    const before = entity.binding.kind === 'existing' ? entity.binding.namespaceEvidence : undefined;
    if (!before || entry.kind !== entity.kind || entry.workspaceId !== entity.workspaceId
      || entry.documentId !== before.documentId || entry.lifecycleGeneration !== before.lifecycleGeneration) bad();
    if (entry.kind === 'directory') {
      const birth = allowedParents.get(entry.path);
      if (birth && before!.filesystemIdentity === null) {
        if (directoryIdentity(entry) !== `directory:${birth.identity.device}:${birth.identity.inode}`) bad();
      } else if (inferredDirectory(before!) && inferredDirectory(entry) && impliedParents.has(entry.path)) {
        // The compiler retains the original logical directory ID. A fresh
        // collector derives the implied directory ID from its final spelling.
      } else if (directoryIdentity(entry) !== directoryIdentity(before!)) bad();
    } else if (!entry.documentId) {
      if (!equal(entry, { ...before!, path: entry.path })) bad();
    } else {
      if (entry.identity !== before!.identity) bad();
      const binding = bindings.get(entry.documentId), original = originalBindings.get(entry.documentId);
      const inventory = inventories.find(item => item.document.documentId === entry.documentId);
      const state = observation.privateNativeStates.find(item => item.documentId === entry.documentId);
      if (!binding || !original || !inventory || !state
        || nativeLinkJsonProof(authoritativeNativeCollaborationSnapshot(state).content) !== entity.contentBasisProof
        || !equal(currentMixed?.evidenceVersion === 5
          ? currentMixed.nativeOrdinarySources4.find(source => source.documentId === entry.documentId)?.inventory.metadata
          : inventory.metadata, entity.metadata)) bad();
      const receipt = receipts.get(entry.documentId);
      if (!receipt) {
        if (!equal(binding, original)) bad();
      } else {
        const clock = receipt.after.clock, identity = receipt.after.identity;
        const expectedBinding: WorkspaceNativeSourceBinding = { ...original!, expected: { ...original!.expected, ...identity,
          registryStateVersion: receipt.after.registryStateVersion, documentSequence: clock.documentSequence,
          persistedAt: clock.persistedAt, stateProof: clock.stateProof, binaryHash: clock.binaryHash,
          vectorHash: hash(Buffer.from(clock.stateVector, 'base64')) }, registry: { ...original!.registry,
          path: identity.path, stateVersion: receipt.after.registryStateVersion }, lineage: { ...original!.lineage, path: identity.path,
          trashEntryId: mutations.find(mutation => mutation.source.documentId === entry.documentId)!.trashEntryId },
          inventoryProof: nativeLinkJsonProof(inventory) };
        if (!equal(binding, expectedBinding) || hash(state!.yjsState) !== clock.binaryHash
          || Buffer.from(state!.stateVector).toString('base64') !== clock.stateVector
          || !equal(inventory!.document, identity) || inventory!.version.stateProof !== clock.stateProof
          || inventory!.version.documentSequence !== clock.documentSequence || inventory!.version.persistedAt !== clock.persistedAt) bad();
      }
    }
  }
  for (const entity of expected.values()) if (!actualPaths.has(entity.path)) bad();
  if (currentMixed && (intent.version === 3 || intent.version === 4)) {
    const catalogue = captureWorkspaceOperationNativeCatalogueWitness(observation.privateCatalogue,
      currentMixed.workspaceScope, currentMixed.nativeComponent.stage.catalogueProof!,
      currentMixed.nativeComponent.nativeBindings, bad);
    // Only IDs with a fully checked native receipt may return to their before
    // path/clock for this comparison. Every other catalogue row remains exact,
    // including pristine non-Markdown assets absent from physical link sources.
    const originalCatalogue = catalogue.entries.map(entry => {
      if (!receipts.has(entry.id)) return entry;
      const binding = originalBindings.get(entry.id); if (!binding) return bad();
      return { ...entry, path: binding.expected.path, state_path: binding.expected.path,
        state_version: binding.expected.registryStateVersion };
    });
    const order = input.catalogueOriginalOrder, byId = new Map(originalCatalogue.map(entry => [entry.id, entry]));
    if (!Array.isArray(order) || order.length !== originalCatalogue.length || new Set(order).size !== order.length
      || order.some(id => !byId.has(id))) return bad();
    const ordered = order.map(id => byId.get(id)!);
    const before = captureWorkspaceOperationNativeCatalogueWitness(ordered,
      intent.currentWitness.workspaceScope, nativeLinkJsonProof(ordered), originalEvidence.nativeBindings, bad);
    if (before.semanticCatalogueProof !== intent.currentWitness.nativeComponent.semanticCatalogueProof) bad();
  }
  const snapshotBody = { contractVersion: 2 as const, workspaceId: observation.stage.workspaceId,
    namespace: observation.stage.namespace, documents: inventories, coverage: { complete: true, gaps: [] } };
  const graph = htmlSnapshot ? buildWorkspaceMixedHtmlLinkGraphV5(htmlSnapshot)
    : currentMixed?.evidenceVersion === 3 ? buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedSourceSnapshot(currentMixed))
      : buildWorkspaceNativeLinkGraph({ ...snapshotBody, snapshotProof: nativeLinkJsonProof(snapshotBody) } as NativeWorkspaceLinkSnapshot);
  if (graph.contractVersion !== 5 && !graph.coverage.complete || graph.edges.length !== compiled.finalEdges.length) bad();
  const nativeEdges = graph.contractVersion === 3 || graph.contractVersion === 5
    ? graph.edges.filter((edge): edge is NativeResolvedLink & { sourceKind: 'native' } => edge.sourceKind === 'native') : graph.edges;
  for (const entity of expected.values()) {
    if (entity.binding.kind !== 'existing' || entity.binding.namespaceEvidence.documentId === null) continue;
    const documentId = entity.binding.namespaceEvidence.documentId;
    const original = context.plan.planIdentityVersion === 4
      ? context.plan.sourceEvidence.nativeOrdinarySources4.find(source => source.documentId === documentId)
      : workspaceOperationSourceNativeEvidence(context.plan.sourceEvidence).stage.sources
        .find(source => source.inventory.document.documentId === documentId);
    if (!original) bad();
    const actual = nativeEdges.filter(edge => edge.source.documentId === documentId);
    if (actual.length !== original!.inventory.links.length) bad();
    for (const [index, link] of original!.inventory.links.entries()) {
      const edge = actual[index], desired = compiled.finalEdges.find(item => item.sourceEntityKey === entity.entityKey && item.originEvidenceLinkId === link.id);
      const key = (target: NativeNamespaceEntry) => expected.get(target.path)?.entityKey ?? bad();
      const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? key(edge.resolution.target) : null,
        candidateEntityKeys: edge.resolution.candidates.map(key).sort() };
      if (!desired || desired.literal !== edge.literal || desired.targetPathText !== edge.targetPathText || !equal(desired.resolution, resolution)) bad();
    }
  }
  if (context.plan.planIdentityVersion === 3) {
    if (currentMixed?.evidenceVersion !== 3 || graph.contractVersion !== 3) return bad();
    // Native path/clock commits legitimately change the catalogue proof, hence
    // physical derived IDs. Compare every physical fact before dropping just
    // those derived values, then bind final edges to ORIGINAL compiler IDs.
    const physicalFacts = (sources: typeof currentMixed.physicalSources) => sources.map(source => {
      const { physicalSourceProof: _proof, links, authority, ...body } = source;
      const { catalogueProof: _catalogue, ...authorityIdentity } = authority;
      return { ...body, authority: authorityIdentity, links: links.map(({ physicalLinkId: _id, ...link }) => link) };
    });
    if (!equal(physicalFacts(currentMixed.physicalSources), physicalFacts(context.plan.sourceEvidence.physicalSources))) bad();
    for (const source of context.plan.sourceEvidence.physicalSources) {
      const entity = expected.get(source.path);
      if (!entity || !entity.physicalReadSource) bad();
      const actual = graph.edges.filter(edge => edge.sourceKind === 'physical-read' && edge.source.path === source.path);
      if (actual.length !== source.links.length) bad();
      for (const [index, link] of source.links.entries()) {
        const edge = actual[index], desired = compiled.finalEdges.find(item => item.sourceEntityKey === entity!.entityKey
          && item.originEvidenceLinkId === link.physicalLinkId && item.physicalReadSource === true);
        const key = (target: NativeNamespaceEntry) => expected.get(target.path)?.entityKey ?? bad();
        const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? key(edge.resolution.target) : null,
          candidateEntityKeys: edge.resolution.candidates.map(key).sort() };
        if (!desired || desired.literal !== edge.literal || desired.targetPathText !== edge.targetPathText
          || !equal(desired.resolution, resolution)) bad();
      }
    }
  }
  if (context.plan.planIdentityVersion === 4) {
    if (currentMixed?.evidenceVersion !== 5 || graph.contractVersion !== 5 || compiled.contractVersion !== 5
      || !compiled.htmlAssessment.complete || compiled.htmlAssessment.blockers.length) return bad();
    const original = context.plan.sourceEvidence;
    const finalPath = (sourcePath: string) => facts.moved.find(item => item.originalPath === sourcePath)?.currentPath ?? sourcePath;
    // Actual native content was already compared with the final compiler basis
    // above. Independently preserve every HTML syntax occurrence while allowing
    // its source path and ordinary-link-induced UTF-16 offsets to change.
    const htmlMeaning = (source: typeof original.nativeComponent.htmlSources[number]) => source.inspection.occurrences.map(item => ({
      raw: item.raw, fullyInspected: item.fullyInspected, explicitLocalTargets: item.explicitLocalTargets,
    }));
    if (currentMixed.nativeComponent.htmlSources.length !== original.nativeComponent.htmlSources.length) bad();
    for (const source of original.nativeComponent.htmlSources) {
      const actual = currentMixed.nativeComponent.htmlSources.find(item => item.documentId === source.documentId);
      const mutation = mutations.find(item => item.source.documentId === source.documentId);
      if (!actual || actual.path !== (mutation?.destinationPath ?? source.path) || !equal(htmlMeaning(actual), htmlMeaning(source))) bad();
    }
    const physical = observation.stage.sources.flatMap(source => source.kind === 'physical' ? [source.inventory] : []);
    if (currentMixed.physicalSources4.length !== original.physicalSources4.length
      || currentMixed.physicalHtmlSources4.length !== original.physicalHtmlSources4.length
      || physical.length !== original.physicalSources4.length + original.physicalHtmlSources4.length) bad();
    // Re-inspect FRESH actually-read bytes at the saved original spelling and
    // compare the complete saved proof. Neither directory relocation nor a
    // catalogue clock may mask changed bytes, metadata, syntax or HTML facts.
    for (const source of original.physicalSources4) {
      const path = finalPath(source.path), actual = physical.find(item => item.path === path);
      const current = currentMixed.physicalSources4.find(item => item.path === path), entity = expected.get(path);
      if (!actual || !current || !entity?.physicalReadSource
        || !equal(actual.physical, source.physical)) return bad();
      const replay = inspectOriginalPhysicalLinksV4({ workspaceId: source.workspaceId, organizationId: source.organizationId,
        path: source.path, authority: source.authority, bytes: actual.originalBytes, filesystemIdentity: actual.physical.filesystemIdentity });
      if (replay.physicalSourceProof !== source.physicalSourceProof || !equal(current.metadata, entity.metadata)) bad();
      const actualEdges = graph.edges.filter(edge => edge.sourceKind === 'physical-read' && edge.source.path === path);
      if (actualEdges.length !== source.links.length) bad();
      for (const [index, link] of source.links.entries()) {
        const edge = actualEdges[index], desired = compiled.finalEdges.find(item => item.sourceEntityKey === entity!.entityKey
          && item.originEvidenceLinkId === link.physicalLinkId && item.physicalReadSource === true);
        const key = (target: NativeNamespaceEntry) => expected.get(target.path)?.entityKey ?? bad();
        const resolution = { status: edge.resolution.status, targetEntityKey: edge.resolution.target ? key(edge.resolution.target) : null,
          candidateEntityKeys: edge.resolution.candidates.map(key).sort() };
        if (!desired || desired.literal !== edge.literal || desired.targetPathText !== edge.targetPathText
          || !equal(desired.resolution, resolution)) bad();
      }
    }
    for (const source of original.physicalHtmlSources4) {
      const path = finalPath(source.path), actual = physical.find(item => item.path === path);
      const current = currentMixed.physicalHtmlSources4.find(item => item.path === path);
      if (!actual || !current || !equal(actual.physical, source.physical)) return bad();
      const replay = inspectOriginalPhysicalHtmlV4({ workspaceId: source.workspaceId, organizationId: source.organizationId,
        path: source.path, authority: source.authority, bytes: actual.originalBytes, filesystemIdentity: actual.physical.filesystemIdentity });
      if (replay.htmlSourceProof !== source.htmlSourceProof || !equal(current.htmlInspection, source.htmlInspection)) bad();
    }
  }
}

/** The only overlay entry. The fixed owner proves actual immutable journal rows,
 * genuine current prepared caps, exact old-leaf vacancy and its active B/claim.
 * No dependency parameter or free caller DTO can install this read context. */
export async function readWorkspaceOperationOriginalMoveSourcesOnConnection(database: SqlConnection, workspace: WorkspaceContext,
  mode: 'original' | 'final'): Promise<WorkspaceLinkSourceAuthorityObservation> {
  if (mode !== 'original' && mode !== 'final') fail('ORIGINAL_MOVE_SOURCES_REQUIRED');
  if (frames.getStore()) { frames.getStore()!.failed = true; fail('ORIGINAL_MOVE_SOURCES_REQUIRED'); }
  const suppliedScope = captureWorkspaceOperationJobScope(workspace);
  workspace = structuredClone(workspace);
  const { readWorkspaceOperationOriginalMoveSourcesContext } = await import('./workspace-operation-job-lifecycle-owner');
  const owner = await readWorkspaceOperationOriginalMoveSourcesContext(database);
  if (!equal(suppliedScope, owner.intent.jobScope)) fail('ORIGINAL_MOVE_SOURCES_REQUIRED');
  await owner.assertCurrent();
  const transaction = await transactionIdentity(database);
  await owner.assertCurrent();
  const journalProof = nativeLinkJsonProof({ context: owner.context, intent: owner.intent,
    parentRows: owner.parentRows, pathRows: owner.pathRows });
  const receipts = owner.intent.steps.map(step => {
    const row = owner.pathRows.find(item => item.stepKey === step.stepKey); if (!row) fail();
    return decodeWorkspaceOperationOriginalMovePathReceipt(row!, owner.intent, owner.parentRows).physical;
  });
  const parents = owner.parentRows.map(row => decodeWorkspaceOperationOriginalMoveParentReceipt(row, owner.intent).birth);
  const facts = deriveOriginalMoveSourceNamespaceFacts(owner.context, owner.intent.steps.map(step => step.physical), receipts, parents);
  const cached = preparedGraphs.get(database);
  if (mode === 'final' && (!cached || cached.transaction !== transaction || cached.journalProof !== journalProof)) fail('ORIGINAL_MOVE_SOURCES_REQUIRED');
  const frame: Frame = { database, workspace, mode, facts, active: true, claimed: false, failed: false };
  try {
    const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../markdown/workspace-source-authority-stage');
    const observation = await frames.run(frame, () => readWorkspaceLinkSourceAuthorityOnConnection(database, workspace,
      { physicalParserVersion: deriveWorkspacePathPhysicalParserVersion(owner.context.plan.sourceEvidence) }));
    if (!frame.claimed || frame.failed) fail();
    await owner.assertCurrent();
    if (await transactionIdentity(database) !== transaction) fail();
    await owner.assertCurrent();
    if (mode === 'original') {
      // Births at an original implicit directory restore precisely that view;
      // all other actual siblings/paths remain visible and must match the plan.
      const original = new Map(workspaceOperationSourceNamespace(owner.context.plan.sourceEvidence).map(entry => [entry.path, entry]));
      for (const birth of facts.bornParents) {
        const prior = original.get(birth.relativePath);
        if (prior && !observation.stage.namespace.some(entry => entry.path === prior.path)) observation.stage.namespace.push(prior);
      }
      observation.stage.namespace.sort((a, b) => a.path.localeCompare(b.path));
      if (owner.context.plan.planIdentityVersion === 4) {
        // A rename can change FS traversal order while all actual original
        // paths/bytes/gaps remain equal. Only this genuine post-read frame may
        // restore their original order; Evidence5's saved hash policy stays exact.
        observation.stage.coverage = restoreOriginalMoveSourceCoverageOrder(owner.context.plan.sourceEvidence.coverage,
          observation.stage.coverage);
      }
      const { workspaceSourceAuthorityStageProof } = await import('../markdown/workspace-physical-link-inventory');
      observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
      const compiled = assertWorkspaceOperationNativeMoveBatchPlanCurrent(owner.context.plan, observation, owner.intent.jobScope);
      preparedGraphs.set(database, { transaction, journalProof, context: owner.context, compiled, facts });
    } else {
      // The catalogue reader sorts by the actual registry path/id columns.
      // Reproduce that order in this same B after projecting native paths back,
      // rather than assuming a JavaScript or host collation matches PostgreSQL.
      const catalogueOriginalOrder = owner.context.plan.planIdentityVersion === 3 || owner.context.plan.planIdentityVersion === 4
        ? (await database.all(`SELECT d.id FROM collaboration_documents d
          LEFT JOIN jsonb_to_recordset($2::jsonb) basis(document_id text,original_path text) ON basis.document_id=d.id
          WHERE d.workspace_id=$1 AND d.provider='yjs' AND d.status='active'
          ORDER BY COALESCE(basis.original_path,d.path),d.id LIMIT 10001`, [workspace.workspaceId,
          JSON.stringify(workspaceOperationSourceNativeEvidence(owner.context.plan.sourceEvidence).nativeBindings
            .map(binding => ({ document_id: binding.expected.documentId, original_path: binding.expected.path })))] ) as Array<{ id: string }>).map(row => row.id)
        : undefined;
      assertOriginalMoveFinalSourceGraph({ context: owner.context, intent: owner.intent, compiled: cached!.compiled, facts,
        observation, nativeReceipts: owner.nativeReceipts, catalogueOriginalOrder });
      preparedGraphs.delete(database);
    }
    await owner.assertCurrent();
    if (frame.failed) fail();
    return observation;
  } catch (error) { preparedGraphs.delete(database); throw error; }
  finally { frame.active = false; }
}
