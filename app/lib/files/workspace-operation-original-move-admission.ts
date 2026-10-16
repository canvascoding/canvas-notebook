import 'server-only';

import { createHash } from 'node:crypto';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { readWorkspaceOperationOriginalMoveNativeBundle, type WorkspaceOperationOriginalMoveContext,
  type WorkspaceOperationOriginalMoveIntentData } from './workspace-operation-original-move';

/** Deterministic protocol data only. Neither these fields nor their hashes
 * grant a claim, principal, lease, SQL session or mutation capability. */
export function createWorkspaceOperationOriginalMoveAdmissionRequest(context: WorkspaceOperationOriginalMoveContext,
  intent: WorkspaceOperationOriginalMoveIntentData | null): CollaborationAdmissionRequest {
  const plan = context.plan, bundle = intent ? readWorkspaceOperationOriginalMoveNativeBundle(intent) : null;
  const hex = createHash('sha256').update(`canvas.original-move.admission.v1\0${context.batchId}\0${context.requestHash}\0${plan.planId}`).digest('hex');
  const requestId = bundle?.requestId ?? `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  const action = plan.actions[0].kind;
  const actionPayloadText = intent?.nativeBundle?.actionPayloadText
    ?? JSON.stringify({version:1,batchId:context.batchId,planId:plan.planId,requestHash:context.requestHash});
  return captureCollaborationAdmissionRequest({requestId,actorId:context.actor.actorId,action,
    actionPayloadText,actionDigest:collaborationAdmissionActionDigest(action,actionPayloadText),
    scopes:[{workspaceId:plan.workspaceId,organizationId:plan.sourceEvidence.workspaceScope.organizationId,path:'',kind:'subtree'}],
    expectedDocuments:plan.sourceEvidence.nativeBindings.map(item => ({documentId:item.expected.documentId,workspaceId:item.expected.workspaceId,
      organizationId:item.expected.organizationId,path:item.expected.path,representation:item.expected.representation,
      lifecycleGeneration:item.expected.lifecycleGeneration,schemaVersion:item.expected.schemaVersion,status:'active'}))}).request;
}
