import 'server-only';

import { buildWorkspaceNativeLinkGraph } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry, NativeResolvedLink,
  NativeWorkspaceLinkGraph, NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-native-delete-plan';
import { captureWorkspaceOperationNativeSourceEvidence } from './workspace-operation-native-source-evidence';

export class WorkspaceOperationNativeDeleteUndoGraphError extends Error {
  readonly code = 'NATIVE_DELETE_UNDO_LINK_CONFLICT';
  readonly status = 409;
  constructor() { super('NATIVE_DELETE_UNDO_LINK_CONFLICT'); this.name = 'WorkspaceOperationNativeDeleteUndoGraphError'; }
}
const fail = (): never => { throw new WorkspaceOperationNativeDeleteUndoGraphError(); };
const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);

function graph(workspaceId: string, namespace: NativeNamespaceEntry[], documents: NativeDocumentLinkInventory[]): NativeWorkspaceLinkGraph {
  const body: Omit<NativeWorkspaceLinkSnapshot, 'snapshotProof'> = { contractVersion: 2, workspaceId, namespace, documents,
    coverage: { complete: true, gaps: [] } };
  const result = buildWorkspaceNativeLinkGraph({ ...body, snapshotProof: nativeLinkJsonProof(body) });
  if (!result.coverage.complete || result.coverage.gaps.length) fail();
  return result;
}
function identity(entry: NativeNamespaceEntry | null, original: WorkspaceOperationNativeDeleteBatchPlan['nativeTarget']): unknown {
  if (!entry) return null;
  // Compare the restored D1's identity across its intentional G -> G+2 lifecycle
  // transition. This changes no state, parser inventory, receipt or authority.
  return { workspaceId: entry.workspaceId, path: entry.path, kind: entry.kind,
    documentId: entry.documentId, lifecycleGeneration: entry.documentId === original.documentId
      ? original.lifecycleGeneration : entry.lifecycleGeneration,
    physicalIdentity: entry.documentId === null ? entry.identity : null };
}
function resolution(edge: NativeResolvedLink, target: WorkspaceOperationNativeDeleteBatchPlan['nativeTarget']): string {
  return nativeLinkJsonProof({ status: edge.resolution.status, target: identity(edge.resolution.target, target),
    candidates: edge.resolution.candidates.map(entry => identity(entry, target))
      .sort((a, b) => nativeLinkJsonProof(a).localeCompare(nativeLinkJsonProof(b))) });
}
function linkMeaning(edge: NativeResolvedLink): string {
  return nativeLinkJsonProof({ sourceDocumentId: edge.source.documentId, kind: edge.kind, syntax: edge.syntax,
    literal: edge.literal, targetPathText: edge.targetPathText, fragment: edge.fragment, alias: edge.alias,
    embed: edge.embed, classification: edge.classification, ref: edge.ref, cloneLocator: edge.cloneLocator });
}
function compare(edges: NativeResolvedLink[], expected: NativeResolvedLink[], target: WorkspaceOperationNativeDeleteBatchPlan['nativeTarget']): void {
  const before = new Map(expected.map(edge => [linkMeaning(edge), resolution(edge, target)]));
  if (before.size !== expected.length || edges.length !== expected.length) fail();
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = linkMeaning(edge);
    if (seen.has(key) || before.get(key) !== resolution(edge, target)) fail();
    seen.add(key);
  }
}

/** Pure inverse-link assessment only. The original inventory is historical
 * content evidence bound to the original Delete plan, never an active state.
 * The caller separately verifies the actual archived bytes/receipt, vacancy,
 * fresh policy and lifecycle fence. B2 invokes the after branch only AFTER its
 * genuine original-D1 CAS, so a returned physical projection is never parsed as
 * a new unregistered Markdown source. No Yjs status is relabelled here. */
export function assertWorkspaceOperationNativeDeleteUndoGraphCurrent(input: WorkspaceOperationNativeDeleteBatchPlan,
  observation: WorkspaceLinkSourceAuthorityObservation, phase: 'before-restore' | 'after-restore' = 'before-restore'): void {
  const plan = decodeWorkspaceOperationNativeDeleteBatchPlan(input), target = plan.nativeTarget;
  if (plan.planIdentityVersion === 3) return fail();
  if (phase !== 'before-restore' && phase !== 'after-restore') fail();
  const current = captureWorkspaceOperationNativeSourceEvidence(plan.sourceEvidence.workspaceScope, observation);
  const original = plan.sourceEvidence.stage;
  const originalInventory = original.sources.find(source => source.inventory.document.documentId === target.documentId)?.inventory;
  const originalEntry = original.namespace.find(entry => entry.documentId === target.documentId);
  if (!originalInventory || !originalEntry) return fail();
  const currentInventory = current.stage.sources.map(source => source.inventory);
  const collisions = current.stage.namespace.filter(entry => entry.kind === 'file'
    && (within(entry.path, target.path) || within(target.path, entry.path)));
  if (phase === 'before-restore') {
    if (collisions.length || current.nativeBindings.some(binding => binding.expected.documentId === target.documentId)) fail();
  } else {
    const binding = current.nativeBindings.find(candidate => candidate.expected.documentId === target.documentId);
    const wanted = { ...target, lifecycleGeneration: target.lifecycleGeneration + 2, registryStateVersion: 0 };
    if (!binding || nativeLinkJsonProof(binding.expected) !== nativeLinkJsonProof(wanted)
      || collisions.length !== 1 || collisions[0].documentId !== target.documentId || collisions[0].path !== target.path) fail();
  }
  const survivingNamespace = current.stage.namespace.filter(entry => entry.documentId !== target.documentId);
  const survivingInventories = currentInventory.filter(inventory => inventory.document.documentId !== target.documentId);
  const before = graph(plan.workspaceId, survivingNamespace, survivingInventories);
  const after = phase === 'before-restore'
    ? graph(plan.workspaceId, [...survivingNamespace, { ...originalEntry, filesystemIdentity: null }],
      [...survivingInventories, originalInventory])
    : graph(plan.workspaceId, current.stage.namespace, currentInventory);
  compare(after.edges.filter(edge => edge.source.documentId !== target.documentId), before.edges, target);
  const originalGraph = graph(plan.workspaceId, original.namespace, original.sources.map(source => source.inventory));
  compare(after.edges.filter(edge => edge.source.documentId === target.documentId),
    originalGraph.edges.filter(edge => edge.source.documentId === target.documentId), target);
}
