import 'server-only';

import { createHash } from 'node:crypto';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { decodeWorkspaceOperationOriginalMoveNativeBundleData, readWorkspaceOperationOriginalMoveNativeBundle,
  type WorkspaceOperationOriginalMoveContext, type WorkspaceOperationOriginalMoveIntentData,
  type WorkspaceOperationOriginalMoveNativeBundleData } from './workspace-operation-original-move';
import { workspaceOperationSourceNativeEvidence, type WorkspaceOperationAnyMixedSourceEvidence } from './workspace-operation-mixed-source-evidence';

/** Deterministic protocol data only. Neither these fields nor their hashes
 * grant a claim, principal, lease, SQL session or mutation capability. */
export function createWorkspaceOperationOriginalMoveAdmissionRequest(context: WorkspaceOperationOriginalMoveContext,
  intent: WorkspaceOperationOriginalMoveIntentData | null): CollaborationAdmissionRequest {
  // Retain the original intent's private context/provenance validation. V2
  // bundles are bound to their original currentWitness, not a later read.
  if (intent) readWorkspaceOperationOriginalMoveNativeBundle(intent);
  return createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle(context, intent?.nativeBundle ?? null,
    intent && intent.version !== 1 ? intent.currentWitness : undefined);
}

/** Deterministic request data only. The caller must supply the exact held or
 * durably staged bundle; this neither prepares new bytes nor reserves work. */
export function createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle(context: WorkspaceOperationOriginalMoveContext,
  data: WorkspaceOperationOriginalMoveNativeBundleData | null,
  sourceEvidence?: WorkspaceOperationAnyMixedSourceEvidence): CollaborationAdmissionRequest {
  // Historical admission-only fallback deliberately accepts null even when
  // a native preparation would require a bundle. Keep that existing contract.
  if (data === null) return captureOriginalMoveAdmissionRequestData(context, null, null).request;
  return captureWorkspaceOperationOriginalMoveAdmissionBundleData(context, data, sourceEvidence).capturedRequest.request;
}

/** Strict pure data only. Always validate bundle semantics, including null;
 * the preparation caller receives the same decoded bundle and captured request
 * from one synchronous validation, without a reusable authority/cache token. */
export function captureWorkspaceOperationOriginalMoveAdmissionBundleData(context: WorkspaceOperationOriginalMoveContext,
  data: WorkspaceOperationOriginalMoveNativeBundleData | null,
  sourceEvidence?: WorkspaceOperationAnyMixedSourceEvidence) {
  const bundle = decodeWorkspaceOperationOriginalMoveNativeBundleData(data, context, sourceEvidence);
  return Object.freeze({ bundle, capturedRequest: captureOriginalMoveAdmissionRequestData(context, data, bundle) });
}

/** Module-private request assembly. Every public non-null entry above first
 * runs the existing strict context/bundle decoder in this same sync block. */
function captureOriginalMoveAdmissionRequestData(context: WorkspaceOperationOriginalMoveContext,
  data: WorkspaceOperationOriginalMoveNativeBundleData | null,
  bundle: ReturnType<typeof decodeWorkspaceOperationOriginalMoveNativeBundleData>) {
  const plan = context.plan;
  const hex = createHash('sha256').update(`canvas.original-move.admission.v1\0${context.batchId}\0${context.requestHash}\0${plan.planId}`).digest('hex');
  const requestId = bundle?.requestId ?? `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  const action = plan.actions[0].kind;
  const actionPayloadText = data?.actionPayloadText
    ?? JSON.stringify({version:1,batchId:context.batchId,planId:plan.planId,requestHash:context.requestHash});
  return captureCollaborationAdmissionRequest({requestId,actorId:context.actor.actorId,action,
    actionPayloadText,actionDigest:collaborationAdmissionActionDigest(action,actionPayloadText),
    scopes:[{workspaceId:plan.workspaceId,organizationId:plan.sourceEvidence.workspaceScope.organizationId,path:'',kind:'subtree'}],
    expectedDocuments:workspaceOperationSourceNativeEvidence(plan.sourceEvidence).nativeBindings.map(item => ({documentId:item.expected.documentId,workspaceId:item.expected.workspaceId,
      organizationId:item.expected.organizationId,path:item.expected.path,representation:item.expected.representation,
      lifecycleGeneration:item.expected.lifecycleGeneration,schemaVersion:item.expected.schemaVersion,status:'active'}))});
}
