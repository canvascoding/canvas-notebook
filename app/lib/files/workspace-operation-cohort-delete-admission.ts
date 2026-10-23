import 'server-only';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest, type CollaborationAdmissionStatus } from '../collaboration/room-admission-contract';
import { captureCollaborationAdmissionOutcomeResult, readHistoricalCollaborationAdmissionOutcomeOnConnection } from '../collaboration/room-admission-outcome';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { readOriginalDeleteAdmissionNamespace } from './workspace-operation-original-delete-admission';
import { captureOriginalDeleteAdmissionBinding } from './workspace-operation-original-delete-evidence';
import { cohortDeleteActor, type CohortDeleteIntent, type CohortDeleteResult, type CohortDeleteEvidenceBinding } from './workspace-operation-cohort-delete-evidence';
import { decodeWorkspaceOperationCohortDeletePlan, failCohortDelete } from './workspace-operation-cohort-delete-plan';
export function createCohortDeleteAdmissionRequest(binding:CohortDeleteEvidenceBinding){
  const auth=binding.authorization;if(binding.actionMode!=='apply'||binding.plan.version!==6||auth.mode!=='direct'&&auth.mode!=='direct-mcp'||!auth.jobScope)return failCohortDelete();
  const plan=decodeWorkspaceOperationCohortDeletePlan(binding.plan);
  if(!equal(plan.sourceEvidence.workspaceScope,auth.jobScope)||plan.planId!==binding.planId||plan.workspaceId!==binding.workspaceId)return failCohortDelete();
  const hex=createHash('sha256').update(`canvas.original-delete.admission.v1\0${binding.batchId}\0${auth.requestHash}\0${binding.planId}`).digest('hex');
  const requestId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  const actionPayloadText=JSON.stringify({version:1,batchId:binding.batchId,planId:binding.planId,requestHash:auth.requestHash,originalActor:cohortDeleteActor(binding),jobScope:auth.jobScope});
  return captureCollaborationAdmissionRequest({requestId,actorId:auth.actorId,action:'archive',actionPayloadText,
    actionDigest:collaborationAdmissionActionDigest('archive',actionPayloadText),scopes:[{workspaceId:binding.workspaceId,organizationId:auth.jobScope.organizationId,path:'',kind:'subtree'}],
    expectedDocuments:plan.sourceEvidence.nativeComponent.nativeBindings.map(item=>({documentId:item.expected.documentId,workspaceId:item.expected.workspaceId,
      organizationId:item.expected.organizationId,path:item.expected.path,representation:item.expected.representation,lifecycleGeneration:item.expected.lifecycleGeneration,schemaVersion:item.expected.schemaVersion,status:'active'}))}).request;
}
export function cohortDeleteAdmissionResult(result:CohortDeleteResult){
  return captureCollaborationAdmissionOutcomeResult({originalDeleteIntentDigest:result.intentDigest,originalDeleteReceiptDigest:result.receiptDigest,
    originalDeleteTrashReceiptDigest:result.trashReceiptDigest,trashEntriesProof:proof(result.physical.map(item=>({stepKey:item.stepKey,trashEntryId:item.receipt.original.trashEntryId})))});
}
export async function readCohortDeleteAdmissionOnConnection(database:SqlConnection,input:Readonly<{schema:string;binding:CohortDeleteEvidenceBinding;intent:CohortDeleteIntent;result?:CohortDeleteResult}>){
  const {schema,binding,intent,result}=input,request=captureCollaborationAdmissionRequest(createCohortDeleteAdmissionRequest(binding)),reference=captureOriginalDeleteAdmissionBinding(intent.admission);
  if(reference.requestId!==request.request.requestId||reference.requestDigest!==request.requestDigest||intent.batchId!==binding.batchId||intent.planId!==binding.planId)return failCohortDelete();
  const namespace=await readOriginalDeleteAdmissionNamespace(database,schema),prefix=`"${schema.replaceAll('"','""')}"`;
  const sql=`SELECT CASE WHEN octet_length(request_id)=36 THEN request_id END AS request_id,
    CASE WHEN octet_length(request_digest)=64 THEN request_digest END AS request_digest,
    CASE WHEN octet_length(intent_text)=$2 AND octet_length(intent_text)<=16777216 THEN intent_text END AS intent_text,
    CASE WHEN octet_length(status)<=32 THEN status END AS status,outcome_text IS NOT NULL AS has_outcome
    FROM ${prefix}.collaboration_admission_requests WHERE request_id=$1`;
  const values=[request.request.requestId,Buffer.byteLength(request.intentText)],header=await database.get(sql,values) as Record<string,unknown>|undefined;
  if(!header||header.request_id!==request.request.requestId||header.request_digest!==request.requestDigest||header.intent_text!==request.intentText
    ||!['reserved','draining','recovery_required','committed','cancelled'].includes(header.status as string)||typeof header.has_outcome!=='boolean'
    ||header.has_outcome!==(header.status==='committed'))return failCohortDelete('COHORT_DELETE_UNPROVEN');
  const outcome=await readHistoricalCollaborationAdmissionOutcomeOnConnection(database,request,{readOnly:true});
  if((header.status==='committed')!==(outcome!==null)||result&&(!outcome||outcome.version!==1||!equal(outcome.result,cohortDeleteAdmissionResult(result)))
    ||!result&&outcome?.version===1||!equal(await database.get(sql,values),header)||!equal(await readOriginalDeleteAdmissionNamespace(database,schema),namespace))return failCohortDelete('COHORT_DELETE_UNPROVEN');
  return Object.freeze({request:request.request,status:header.status as CollaborationAdmissionStatus,outcome});
}
