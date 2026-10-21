import { isDeepStrictEqual as equal, types } from 'node:util';
import { captureOriginalPhysicalDeleteRegistryFactsV1, assertOriginalPhysicalDeleteRegistryReceiptV1,
  type OriginalPhysicalDeleteRegistryFactsV1, type OriginalPhysicalDeleteRegistryReceiptV1 } from './workspace-operation-original-physical-delete-registry-v5';
import type { WorkspaceOperationDeleteBatchPlan } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import { assertOriginalPhysicalDeleteLinkPlanV5 } from './workspace-operation-original-physical-delete-links-v5';
import type { NativeFileArchiveExpected, NativeFileArchiveTransition,
  NativeFileRestoreTransition } from '../collaboration/native-file-archive-transition';
import type { WorkspaceContext } from '../workspaces/types';
import type { PreparedSingleFileTrashOriginalFacts, PreparedSingleFileTrashReceipt,
  PreparedSingleFileRestoreOriginalFacts, PreparedSingleFileRestoreReceipt } from '../filesystem/prepared-single-file-trash';
import type { WorkspaceOperationBatchAuthorization, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import type { WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import { decodeWorkspaceOperationNativeSourceEvidenceV3, type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { decodeWorkspaceOperationMixedSourceEvidenceV5, type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { decodeOriginalDeleteNativeHtmlLinkIntentsV4, assertOriginalDeleteNativeHtmlLinkReceiptsV4,
  type OriginalDeleteNativeLinkIntentV4 } from './workspace-operation-original-delete-html-links';
import { workspaceOperationSourceNativeEvidence, workspaceOperationSourceNamespace } from './workspace-operation-mixed-source-evidence';
import { decodeWorkspaceOperationNativeSourceEvidence } from './workspace-operation-native-source-evidence';
import { decodeWorkspaceOperationNativeOriginalSourceWitness, decodeWorkspaceOperationMixedOriginalSourceWitness } from './workspace-operation-native-original-source';
import { workspaceOperationJobScopeMatches } from './workspace-operation-job-scope';
import { decodeWorkspaceOperationMcpAuthorization } from './workspace-operation-mcp-authorization';
import type { OriginalDeletePublicShare, OriginalDeletePublicShareResult } from './workspace-operation-original-delete-public';
import type { WorkspaceOperationOriginalDeleteIntent, WorkspaceOperationOriginalDeleteReceipt } from './workspace-operation-original-delete-repository';
import { decodeOriginalDeleteNativeLinkIntents, assertOriginalDeleteNativeLinkReceipts,
  assertOriginalDeleteNativeLinkPlan,
  type OriginalDeleteNativeLinkIntent,
  type AnyOriginalDeleteNativeLinkReceipt } from './workspace-operation-original-delete-links';

/** Factual original journal binding only. This is not a claim, current ACL,
 * owner-B identity, lifecycle lease or permission to perform a mutation. */
export type WorkspaceOperationOriginalDeleteEvidenceContext = Readonly<{
  batchId: string; planId: string; workspaceId: string;
  authorization: WorkspaceOperationBatchAuthorization; sourcePath: string;
}>;
type OriginalIntentFields = Readonly<{
  batchId: string; planId: string; requestHash: string;
  actor: Readonly<{ userId: string; actorId: string; actorType: 'user' | 'agent'; actorSessionId: string | null }>;
  jobScope: WorkspaceOperationJobScope;
  physical: PreparedSingleFileTrashOriginalFacts; native: NativeFileArchiveExpected | null;
  publicShare: OriginalDeletePublicShare | null;
}>;
/** Factual reference to this original job's actual stored P0 header. The fixed
 * Owner must reconstruct and compare the complete request before any mutation. */
export type OriginalDeleteAdmissionBinding = Readonly<{ requestId: string; requestDigest: string }>;
export type OriginalIntent = OriginalIntentFields & (
  Readonly<{ version: 1 | 2; currentWitness?: never; nativeLinks?: OriginalDeleteNativeLinkIntent[] }>
  | Readonly<{ version: 3; currentWitness: WorkspaceOperationNativeSourceEvidenceV2;
    nativeLinks: OriginalDeleteNativeLinkIntent[] }>
  | Readonly<{ version: 4; currentWitness: WorkspaceOperationNativeSourceEvidenceV2;
    nativeLinks: OriginalDeleteNativeLinkIntent[]; admission: OriginalDeleteAdmissionBinding }>
  | Readonly<{ version: 5; currentWitness: WorkspaceOperationNativeSourceEvidenceV3;
    nativeLinks: OriginalDeleteNativeLinkIntent[]; admission: OriginalDeleteAdmissionBinding }>
  | Readonly<{ version: 6; currentWitness: WorkspaceOperationMixedSourceEvidenceV5;
    nativeLinks: OriginalDeleteNativeLinkIntentV4[]; admission: OriginalDeleteAdmissionBinding }>
  | Readonly<{ version: 7; native: null; currentWitness: WorkspaceOperationMixedSourceEvidenceV5;
    nativeLinks: OriginalDeleteNativeLinkIntentV4[]; admission: OriginalDeleteAdmissionBinding; physicalRegistry: OriginalPhysicalDeleteRegistryFactsV1 }>
);
export type Completion = Readonly<{
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7; batchId: string; intentDigest: string; trashEntryId: string;
  physical: PreparedSingleFileTrashReceipt; native: NativeFileArchiveTransition | null;
  publicShare: OriginalDeletePublicShareResult; trashReceiptDigest: string;
  /** Versions 2/3/4: actual SQL receipts committed atomically with this completion. */
  nativeLinks?: AnyOriginalDeleteNativeLinkReceipt[];
  physicalRegistry?: OriginalPhysicalDeleteRegistryReceiptV1;
}>;
export type WorkspaceOperationOriginalDeleteResult = Readonly<Completion & { receiptDigest: string }>;
export type RestoreIntent = Readonly<{
  version: 1; batchId: string; planId: string; requestHash: string;
  originalIntentDigest: string; originalReceiptDigest: string; trashEntryId: string;
  actorUserId: string; jobScope: OriginalIntent['jobScope']; restoredAtMs: number;
  physical: PreparedSingleFileRestoreOriginalFacts;
}>;
export type RestoreCompletion = Readonly<{
  version: 1; batchId: string; intentDigest: string; originalReceiptDigest: string; trashEntryId: string;
  actorUserId: string; restoredAtMs: number; physical: PreparedSingleFileRestoreReceipt;
  native: NativeFileRestoreTransition | null;
}>;
export type WorkspaceOperationOriginalRestoreResult = Readonly<RestoreCompletion & { receiptDigest: string }>;

export class WorkspaceOperationOriginalDeleteError extends Error {
  readonly status = 409;
  constructor(readonly code: 'ORIGINAL_DELETE_INVALID' | 'ORIGINAL_DELETE_CHANGED' | 'ORIGINAL_DELETE_BUSY'
    | 'ORIGINAL_DELETE_UNSUPPORTED' | 'ORIGINAL_DELETE_UNPROVEN' | 'ORIGINAL_DELETE_POSTCONDITION') {
    super(code); this.name = 'WorkspaceOperationOriginalDeleteError';
  }
}
function fail(code: WorkspaceOperationOriginalDeleteError['code']): never { throw new WorkspaceOperationOriginalDeleteError(code); }
const json = (value: unknown): string => JSON.stringify(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('ORIGINAL_DELETE_UNPROVEN');
  return value as Record<string, unknown>;
}
function actor(context: WorkspaceOperationOriginalDeleteEvidenceContext): OriginalIntent['actor'] {
  const auth = context.authorization; if (auth.mode !== 'direct' && auth.mode !== 'direct-mcp') fail('ORIGINAL_DELETE_INVALID');
  if (auth.mode === 'direct-mcp' && decodeWorkspaceOperationMcpAuthorization(auth).tool !== 'delete_knowledge_source') fail('ORIGINAL_DELETE_INVALID');
  return Object.freeze({ userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null });
}

/** Bounded own-data capture only, never a P0 lookup, actor or execution grant. */
export function captureOriginalDeleteAdmissionBinding(value: unknown): OriginalDeleteAdmissionBinding {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 2) fail('ORIGINAL_DELETE_UNPROVEN');
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const name of ['requestId', 'requestDigest']) {
    if (!fields[name]?.enumerable || !Object.hasOwn(fields[name], 'value')) fail('ORIGINAL_DELETE_UNPROVEN');
  }
  const requestId = fields.requestId.value, requestDigest = fields.requestDigest.value;
  if (typeof requestId !== 'string' || requestId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requestId)
    || typeof requestDigest !== 'string' || requestDigest.length !== 64 || !/^[0-9a-f]{64}$/u.test(requestDigest)) fail('ORIGINAL_DELETE_UNPROVEN');
  return Object.freeze({ requestId, requestDigest });
}

// These are the original runner's parsers, shared rather than reconstructed by
// status readers. DATA is explicit so decoding performs no FS/ENV/SQL work.
export function parseIntent(row: WorkspaceOperationOriginalDeleteIntent, context: WorkspaceOperationOriginalDeleteEvidenceContext,
  workspace: WorkspaceContext, dataRoot: string): OriginalIntent {
  const auth = context.authorization; if (auth.mode !== 'direct' && auth.mode !== 'direct-mcp') fail('ORIGINAL_DELETE_INVALID');
  const parsed = JSON.parse(row.intentText);
  const value = object(parsed, ['version', 'batchId', 'planId', 'requestHash', 'actor', 'jobScope', 'physical', 'native', 'publicShare',
    ...(parsed?.version === 2 || parsed?.version === 3 || parsed?.version === 4 || parsed?.version === 5 || parsed?.version === 6 || parsed?.version === 7 ? ['nativeLinks'] : []),
    ...(parsed?.version === 3 || parsed?.version === 4 || parsed?.version === 5 || parsed?.version === 6 || parsed?.version === 7 ? ['currentWitness'] : []),
    ...(parsed?.version === 4 || parsed?.version === 5 || parsed?.version === 6 || parsed?.version === 7 ? ['admission'] : []),
    ...(parsed?.version === 7 ? ['physicalRegistry'] : [])]);
  if (![1, 2, 3, 4, 5, 6, 7].includes(value.version as number) || row.batchId !== context.batchId || value.batchId !== context.batchId
    || row.planId !== context.planId || value.planId !== context.planId || row.workspaceId !== context.workspaceId
    || row.requestHash !== auth.requestHash || value.requestHash !== auth.requestHash || !equal(value.actor, actor(context))
    || !equal(value.jobScope, auth.jobScope) || !workspaceOperationJobScopeMatches(value.jobScope, workspace)) fail('ORIGINAL_DELETE_UNPROVEN');
  const physical = value.physical as OriginalIntent['physical'];
  if (!physical || physical.version !== 1 || physical.canonicalPath !== context.sourcePath
    || physical.workspace.workspaceId !== context.workspaceId || physical.workspace.rootPath !== workspace.rootPath
    || physical.workspace.dataRoot !== dataRoot || !/^trash-[0-9a-f-]{36}$/u.test(physical.trashEntryId)) fail('ORIGINAL_DELETE_UNPROVEN');
  const native = value.native as NativeFileArchiveExpected | null;
  if (auth.mode === 'direct-mcp' && native === null && value.version !== 7) fail('ORIGINAL_DELETE_UNPROVEN');
  if (native !== null && (native.workspaceId !== workspace.workspaceId || native.organizationId !== (workspace.organizationId ?? null)
    || native.path !== physical.canonicalPath)) fail('ORIGINAL_DELETE_UNPROVEN');
  if (physical.source.kind === 'projection_absent' && native === null) fail('ORIGINAL_DELETE_UNPROVEN');
  if (value.version === 3 || value.version === 4) {
    const witness = decodeWorkspaceOperationNativeSourceEvidence(value.currentWitness);
    if (witness.evidenceVersion !== 2 || !equal(witness.workspaceScope, value.jobScope)
      || !native || !equal(witness.nativeBindings.find(binding => binding.expected.documentId === native.documentId)?.expected, native)) {
      fail('ORIGINAL_DELETE_UNPROVEN');
    }
    value.currentWitness = witness;
  }
  if (value.version === 5) {
    const witness = decodeWorkspaceOperationNativeSourceEvidenceV3(value.currentWitness);
    if (!equal(witness.workspaceScope, value.jobScope) || !native
      || !equal(witness.nativeComponent.nativeBindings.find(binding => binding.expected.documentId === native.documentId)?.expected, native)) {
      fail('ORIGINAL_DELETE_UNPROVEN');
    }
    value.currentWitness = witness;
  }
  if (value.version === 6) {
    const witness = decodeWorkspaceOperationMixedSourceEvidenceV5(value.currentWitness);
    if (!equal(witness.workspaceScope, value.jobScope) || !native
      || !equal(witness.nativeComponent.nativeBindings.find(binding => binding.expected.documentId === native.documentId)?.expected, native)) fail('ORIGINAL_DELETE_UNPROVEN');
    value.currentWitness = witness;
    value.nativeLinks = decodeOriginalDeleteNativeHtmlLinkIntentsV4(value.nativeLinks, { batchId: context.batchId,
      workspaceId: context.workspaceId, sourcePath: context.sourcePath, requestHash: auth.requestHash, actor: actor(context) });
    if ((value.nativeLinks as OriginalDeleteNativeLinkIntentV4[]).some(link => link.prepared.source.organizationId !== (workspace.organizationId ?? null))) fail('ORIGINAL_DELETE_UNPROVEN');
  }
  if (value.version === 7) {
    const witness = decodeWorkspaceOperationMixedSourceEvidenceV5(value.currentWitness);
    const registry = captureOriginalPhysicalDeleteRegistryFactsV1(value.physicalRegistry);
    const target = witness.namespace.find(entry => entry.path === context.sourcePath);
    const identity = physical.source.kind === 'regular_file' ? physical.source.identity : null;
    const fingerprint = identity ? `${identity.device}:${identity.inode}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}` : null;
    if (native !== null || !identity || !target || target.kind !== 'file' || target.documentId !== null || target.lifecycleGeneration !== null
      || target.provider !== undefined || target.filesystemIdentity !== fingerprint || target.identity !== fingerprint
      || /\.(?:md|markdown|mdx|html?|excalidraw)$/iu.test(target.path)
      || !equal(witness.workspaceScope,value.jobScope) || !equal(registry.workspaceScope,value.jobScope)
      || registry.sourcePath !== context.sourcePath || witness.nativeComponent.nativeBindings.some(binding => binding.expected.path === target.path)
      || [...witness.physicalSources4,...witness.physicalHtmlSources4].some(source => source.path === target.path)) fail('ORIGINAL_DELETE_UNPROVEN');
    value.currentWitness = witness; value.physicalRegistry = registry;
    value.nativeLinks = decodeOriginalDeleteNativeHtmlLinkIntentsV4(value.nativeLinks, { batchId: context.batchId,
      workspaceId: context.workspaceId, sourcePath: context.sourcePath, requestHash: auth.requestHash, actor: actor(context) });
    if ((value.nativeLinks as OriginalDeleteNativeLinkIntentV4[]).some(link => link.prepared.source.organizationId !== (workspace.organizationId ?? null))) fail('ORIGINAL_DELETE_UNPROVEN');
    value.admission = captureOriginalDeleteAdmissionBinding(value.admission);
  }
  if (value.version === 4 || value.version === 5 || value.version === 6) value.admission = captureOriginalDeleteAdmissionBinding(value.admission);
  if (value.version === 2 || value.version === 3 || value.version === 4 || value.version === 5) {
    if (!native) fail('ORIGINAL_DELETE_UNPROVEN');
    const links = decodeOriginalDeleteNativeLinkIntents(value.nativeLinks, { batchId: context.batchId, workspaceId: context.workspaceId,
      sourcePath: context.sourcePath, requestHash: auth.requestHash, actor: actor(context) }, value.version === 3 || value.version === 4 || value.version === 5);
    if (links.some(link => link.prepared.source.organizationId !== (workspace.organizationId ?? null))) fail('ORIGINAL_DELETE_UNPROVEN');
  }
  return freeze(value) as OriginalIntent;
}

/** Bind historical B1 facts to the original decoded plan. This validator does
 * not read today's path or adopt a later document at that spelling. */
export function assertOriginalDeleteIntentPlan(intent: OriginalIntent, plan: WorkspaceOperationDeleteBatchPlan): void {
  if (plan.version === 5) {
    const decoded = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan);
    if (intent.version !== 7 || intent.native !== null) fail('ORIGINAL_DELETE_UNPROVEN');
    const witness = decodeWorkspaceOperationMixedOriginalSourceWitness(decoded.sourceEvidence,intent.currentWitness);
    const physical = intent.physical, entry = witness.namespace.find(item => item.path === physical.canonicalPath);
    const identity = physical.source.kind === 'regular_file' ? physical.source.identity : null;
    const fingerprint = identity ? `${identity.device}:${identity.inode}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}` : null;
    if (!entry || !equal(entry,decoded.physicalTarget) || physical.canonicalPath !== decoded.physicalTarget.path
      || entry.filesystemIdentity !== fingerprint || intent.physicalRegistry.sourcePath !== physical.canonicalPath
      || !equal(intent.physicalRegistry.workspaceScope,intent.jobScope)) fail('ORIGINAL_DELETE_UNPROVEN');
    captureOriginalPhysicalDeleteRegistryFactsV1(intent.physicalRegistry);
    assertOriginalPhysicalDeleteLinkPlanV5(decoded,intent.nativeLinks); return;
  }
  if (intent.version === 7) fail('ORIGINAL_DELETE_UNPROVEN');
  if (plan.planIdentityVersion === 4) {
    if (intent.version !== 6 || !intent.native) fail('ORIGINAL_DELETE_UNPROVEN');
    const witness = decodeWorkspaceOperationMixedOriginalSourceWitness(plan.sourceEvidence, intent.currentWitness);
    const target = witness.nativeComponent.nativeBindings.find(binding => binding.expected.documentId === plan.nativeTarget.documentId);
    const physical = intent.physical, entry = witness.namespace.find(item => item.path === physical.canonicalPath);
    const identity = physical.source.kind === 'regular_file' ? physical.source.identity : null;
    const physicalIdentity = identity ? `${identity.device}:${identity.inode}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}` : null;
    if (!target || !equal(target.expected, intent.native) || target.expected.path !== plan.nativeTarget.path
      || physical.canonicalPath !== plan.nativeTarget.path || !entry || entry.documentId !== target.expected.documentId
      || entry.filesystemIdentity !== physicalIdentity) fail('ORIGINAL_DELETE_UNPROVEN');
    assertOriginalDeleteNativeLinkPlan(plan, intent.nativeLinks); return;
  }
  if (intent.version === 6) fail('ORIGINAL_DELETE_UNPROVEN');
  if (plan.planIdentityVersion === 3) {
    if (intent.version !== 5 || !intent.native) fail('ORIGINAL_DELETE_UNPROVEN');
    let witness: WorkspaceOperationNativeSourceEvidenceV3;
    try { witness = decodeWorkspaceOperationMixedOriginalSourceWitness(plan.sourceEvidence, intent.currentWitness); }
    catch { return fail('ORIGINAL_DELETE_UNPROVEN'); }
    const target = workspaceOperationSourceNativeEvidence(witness).nativeBindings
      .find(binding => binding.expected.documentId === plan.nativeTarget.documentId);
    const physical = intent.physical, entry = workspaceOperationSourceNamespace(witness).find(item => item.path === physical.canonicalPath);
    const identity = physical.source.kind === 'regular_file' ? physical.source.identity : null;
    const physicalIdentity = identity ? `${identity.device}:${identity.inode}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}` : null;
    if (!target || !equal(target.expected, intent.native) || target.expected.path !== plan.nativeTarget.path
      || physical.canonicalPath !== plan.nativeTarget.path || !entry || entry.documentId !== target.expected.documentId
      || entry.filesystemIdentity !== physicalIdentity) fail('ORIGINAL_DELETE_UNPROVEN');
    assertOriginalDeleteNativeLinkPlan(plan, intent.nativeLinks);
    return;
  }
  if (intent.version === 5) fail('ORIGINAL_DELETE_UNPROVEN');
  if (plan.planIdentityVersion !== 2) {
    if (intent.version === 3 || intent.version === 4 || !equal(intent.native, plan.nativeTarget)) fail('ORIGINAL_DELETE_UNPROVEN');
    return;
  }
  if (intent.version !== 3 && intent.version !== 4 || !intent.native) fail('ORIGINAL_DELETE_UNPROVEN');
  try { decodeWorkspaceOperationNativeOriginalSourceWitness(plan.sourceEvidence, intent.currentWitness); }
  catch { fail('ORIGINAL_DELETE_UNPROVEN'); }
  const target = intent.currentWitness.nativeBindings.find(binding => binding.expected.documentId === plan.nativeTarget.documentId);
  if (!target || !equal(target.expected, intent.native) || target.expected.path !== plan.nativeTarget.path) fail('ORIGINAL_DELETE_UNPROVEN');
  const physical = intent.physical;
  const entry = intent.currentWitness.stage.namespace.find(item => item.path === physical.canonicalPath);
  const identity = physical.source.kind === 'regular_file' ? physical.source.identity : null;
  const physicalIdentity = identity ? `${identity.device}:${identity.inode}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}` : null;
  if (physical.canonicalPath !== plan.nativeTarget.path || !entry || entry.documentId !== target.expected.documentId
    || entry.filesystemIdentity !== physicalIdentity) fail('ORIGINAL_DELETE_UNPROVEN');
  assertOriginalDeleteNativeLinkPlan(plan, intent.nativeLinks);
}
export function completed(row: WorkspaceOperationOriginalDeleteReceipt, trash: WorkspaceOperationOriginalDeleteReceipt | null,
  durable: WorkspaceOperationOriginalDeleteIntent, intent: OriginalIntent): WorkspaceOperationOriginalDeleteResult {
  const value = object(JSON.parse(row.receiptText), ['version', 'batchId', 'intentDigest', 'trashEntryId', 'physical', 'native', 'publicShare', 'trashReceiptDigest',
    ...(intent.version === 2 || intent.version === 3 || intent.version === 4 || intent.version === 5 || intent.version === 6 || intent.version === 7 ? ['nativeLinks'] : []),
    ...(intent.version === 7 ? ['physicalRegistry'] : [])]);
  const physical = value.physical as PreparedSingleFileTrashReceipt;
  if (!trash || row.batchId !== durable.batchId || trash.batchId !== durable.batchId || row.intentDigest !== durable.intentDigest
    || trash.intentDigest !== durable.intentDigest || value.version !== intent.version || value.batchId !== durable.batchId
    || value.intentDigest !== durable.intentDigest || value.trashEntryId !== intent.physical.trashEntryId
    || !physical || physical.version !== 1 || !equal(physical.original, intent.physical)
    || trash.receiptText !== json(physical) || value.trashReceiptDigest !== trash.receiptDigest
    || intent.native === null && value.native !== null || intent.native !== null
    && (!value.native || (value.native as NativeFileArchiveTransition).before.identity.documentId !== intent.native.documentId
      || (value.native as NativeFileArchiveTransition).before.identity.lineageId !== intent.native.lineageId
      || (value.native as NativeFileArchiveTransition).before.clock.stateProof !== intent.native.stateProof)) fail('ORIGINAL_DELETE_UNPROVEN');
  if (intent.version === 3 || intent.version === 4 || intent.version === 5 || intent.version === 6) {
    const transition = value.native as NativeFileArchiveTransition;
    if (!intent.native || !equal({ ...transition.before.identity, ...transition.before.clock,
      registryStateVersion: transition.before.registryStateVersion }, intent.native)
      || !equal(transition.after.identity, { ...transition.before.identity, lifecycleGeneration: intent.native.lifecycleGeneration + 1 })
      || !equal(transition.after.clock, transition.before.clock) || transition.after.registryStateVersion !== 0
      || transition.after.status !== 'archived') fail('ORIGINAL_DELETE_UNPROVEN');
  }
  if (intent.version === 2 || intent.version === 3 || intent.version === 4 || intent.version === 5) assertOriginalDeleteNativeLinkReceipts(value.nativeLinks,
    intent.nativeLinks ?? fail('ORIGINAL_DELETE_UNPROVEN'), intent.version === 3 || intent.version === 4 || intent.version === 5 ? 3 : undefined);
  if (intent.version === 6) assertOriginalDeleteNativeHtmlLinkReceiptsV4(value.nativeLinks, intent.nativeLinks);
  if (intent.version === 7) {
    if (value.native !== null || physical.original.source.kind !== 'regular_file' || physical.observation.kind !== 'moved'
      || physical.observation.method !== 'rename' || physical.observation.sha256 !== physical.original.source.sha256) fail('ORIGINAL_DELETE_UNPROVEN');
    const originalIdentity = physical.original.source.identity, observedIdentity = physical.observation.identity;
    if (Object.keys(originalIdentity).length !== Object.keys(observedIdentity).length
      || Object.entries(originalIdentity).some(([key,expected]) => key !== 'ctimeMs' && Reflect.get(observedIdentity,key) !== expected)
      || typeof observedIdentity.ctimeMs !== 'number' || !Number.isFinite(observedIdentity.ctimeMs)) fail('ORIGINAL_DELETE_UNPROVEN');
    assertOriginalDeleteNativeHtmlLinkReceiptsV4(value.nativeLinks,intent.nativeLinks);
    assertOriginalPhysicalDeleteRegistryReceiptV1(value.physicalRegistry,intent.physicalRegistry,intent.physical.trashEntryId,intent.physical.deletedAtMs);
  }
  return freeze({ ...value, receiptDigest: row.receiptDigest }) as WorkspaceOperationOriginalDeleteResult;
}
export function parseRestoreIntent(row: WorkspaceOperationOriginalDeleteIntent, context: WorkspaceOperationOriginalDeleteEvidenceContext,
  workspace: WorkspaceContext, original: OriginalIntent, originalDurable: WorkspaceOperationOriginalDeleteIntent,
  originalResult: WorkspaceOperationOriginalDeleteResult): RestoreIntent {
  const value = object(JSON.parse(row.intentText), ['version', 'batchId', 'planId', 'requestHash', 'originalIntentDigest',
    'originalReceiptDigest', 'trashEntryId', 'actorUserId', 'jobScope', 'restoredAtMs', 'physical']);
  const auth = context.authorization;
  if (auth.mode !== 'direct' || value.version !== 1 || value.batchId !== context.batchId || row.batchId !== context.batchId
    || value.planId !== context.planId || row.planId !== context.planId || row.workspaceId !== context.workspaceId
    || value.requestHash !== auth.requestHash || row.requestHash !== auth.requestHash
    || value.originalIntentDigest !== originalDurable.intentDigest || value.originalReceiptDigest !== originalResult.receiptDigest
    || value.trashEntryId !== original.physical.trashEntryId || value.actorUserId !== auth.actorUserId
    || !equal(value.jobScope, original.jobScope) || !workspaceOperationJobScopeMatches(value.jobScope, workspace)
    || !Number.isSafeInteger(value.restoredAtMs) || Number(value.restoredAtMs) < original.physical.deletedAtMs
    || Number(value.restoredAtMs) >= Number.MAX_SAFE_INTEGER) fail('ORIGINAL_DELETE_UNPROVEN');
  const physical = value.physical as PreparedSingleFileRestoreOriginalFacts;
  if (!physical || physical.version !== 1 || !equal(physical.trashReceipt, originalResult.physical)) fail('ORIGINAL_DELETE_UNPROVEN');
  return freeze(value) as RestoreIntent;
}
export function restored(row: WorkspaceOperationOriginalDeleteReceipt, durable: WorkspaceOperationOriginalDeleteIntent,
  intent: RestoreIntent, original: OriginalIntent): WorkspaceOperationOriginalRestoreResult {
  const value = object(JSON.parse(row.receiptText), ['version', 'batchId', 'intentDigest', 'originalReceiptDigest',
    'trashEntryId', 'actorUserId', 'restoredAtMs', 'physical', 'native']);
  const physical = value.physical as PreparedSingleFileRestoreReceipt;
  const native = value.native as NativeFileRestoreTransition | null;
  if (row.batchId !== durable.batchId || row.intentDigest !== durable.intentDigest || value.version !== 1
    || value.batchId !== durable.batchId || value.intentDigest !== durable.intentDigest
    || value.originalReceiptDigest !== intent.originalReceiptDigest || value.trashEntryId !== intent.trashEntryId
    || value.actorUserId !== intent.actorUserId || value.restoredAtMs !== intent.restoredAtMs
    || !physical || physical.version !== 1 || !equal(physical.original, intent.physical)
    || original.native === null && native !== null || original.native !== null
    && (!native || native.after.identity.documentId !== original.native.documentId
      || native.after.identity.lineageId !== original.native.lineageId
      || native.after.identity.lifecycleGeneration !== original.native.lifecycleGeneration + 2
      || native.after.clock.stateProof !== original.native.stateProof)) fail('ORIGINAL_DELETE_UNPROVEN');
  return freeze({ ...value, receiptDigest: row.receiptDigest }) as WorkspaceOperationOriginalRestoreResult;
}
