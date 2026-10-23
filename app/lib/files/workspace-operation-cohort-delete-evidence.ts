import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { NativeFileArchiveExpected, NativeFileArchiveTransition } from '../collaboration/native-file-archive-transition';
import type { WorkspaceContext } from '../workspaces/types';
import { decodePreparedWorkspacePathTrashOriginal, decodePreparedWorkspacePathTrashReceipt, preparedWorkspacePathTrashNamespaceFingerprints,
  type PreparedWorkspacePathTrashOriginal, type PreparedWorkspacePathTrashReceipt } from '../filesystem/prepared-workspace-path-trash';
import type { WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import type { WorkspaceOperationOriginalDeleteIntent, WorkspaceOperationOriginalDeleteReceipt } from './workspace-operation-original-delete-repository';
import { workspaceOperationJobScopeMatches } from './workspace-operation-job-scope';
import { decodeWorkspaceOperationMixedOriginalSourceWitness } from './workspace-operation-native-original-source';
import type { WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { captureOriginalDeleteAdmissionBinding, type OriginalDeleteAdmissionBinding } from './workspace-operation-original-delete-evidence';
import { captureOriginalPhysicalDeleteRegistryFactsV1, assertOriginalPhysicalDeleteRegistryReceiptV1,
  type OriginalPhysicalDeleteRegistryFactsV1, type OriginalPhysicalDeleteRegistryReceiptV1 } from './workspace-operation-original-physical-delete-registry-v5';
import { decodeOriginalDeleteNativeHtmlLinkIntentsV4, assertOriginalDeleteNativeHtmlLinkReceiptsV4,
  type OriginalDeleteNativeLinkIntentV4, type OriginalDeleteNativeLinkReceiptV4 } from './workspace-operation-original-delete-html-links';
import type { OriginalDeletePublicShare, OriginalDeletePublicShareResult } from './workspace-operation-original-delete-public';
import { assertOriginalDeleteNativeLinkRecipeIntents } from './workspace-operation-original-delete-link-recipe-intents';
import { decodeWorkspaceOperationCohortDeletePlan, getWorkspaceOperationCohortDeleteRecipes, cohortWithin,
  captureCohortDeleteData, freezeCohortDelete, failCohortDelete, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';

export type CohortDeleteEvidenceBinding=Pick<WorkspaceOperationBatchClaimBinding,'batchId'|'planId'|'workspaceId'|'authorization'|'plan'|'actionMode'>;
export type CohortDeleteActor=Readonly<{userId:string;actorId:string;actorType:'user'|'agent';actorSessionId:string|null}>;
export type CohortDeleteRoot=Readonly<{stepKey:string;physical:PreparedWorkspacePathTrashOriginal}>;
export type CohortDeleteTarget=Readonly<{path:string;rootStep:string;native:NativeFileArchiveExpected|null;
  physicalRegistry:OriginalPhysicalDeleteRegistryFactsV1|null;publicShare:OriginalDeletePublicShare|null}>;
export type CohortDeleteIntent=Readonly<{version:1;kind:'cohort-delete-original';batchId:string;planId:string;requestHash:string;
  actor:CohortDeleteActor;jobScope:WorkspaceOperationJobScope;currentWitness:WorkspaceOperationMixedSourceEvidenceV5;
  roots:readonly CohortDeleteRoot[];targets:readonly CohortDeleteTarget[];
  nativeLinks:readonly OriginalDeleteNativeLinkIntentV4[];admission:OriginalDeleteAdmissionBinding}>;
export type CohortDeleteCompletion=Readonly<{version:1;kind:'cohort-delete-completion';batchId:string;intentDigest:string;
  physical:readonly Readonly<{stepKey:string;receipt:PreparedWorkspacePathTrashReceipt}>[];
  targets:readonly Readonly<{path:string;rootStep:string;native:NativeFileArchiveTransition|null;
    physicalRegistry:OriginalPhysicalDeleteRegistryReceiptV1|null;publicShare:OriginalDeletePublicShareResult}>[];
  nativeLinks:readonly OriginalDeleteNativeLinkReceiptV4[];trashReceiptDigest:string}>;
export type CohortDeleteResult=CohortDeleteCompletion&Readonly<{receiptDigest:string}>;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export function cohortDeleteActor(binding:CohortDeleteEvidenceBinding):CohortDeleteActor{
  const auth=binding.authorization;if(auth.mode!=='direct'&&auth.mode!=='direct-mcp')return failCohortDelete();
  return freezeCohortDelete({userId:auth.actorUserId,actorId:auth.actorId,actorType:auth.actorType,actorSessionId:auth.actorSessionId??null});
}
export function cohortDeleteLinkContext(binding:CohortDeleteEvidenceBinding){
  const auth=binding.authorization;if(auth.mode!=='direct'&&auth.mode!=='direct-mcp')return failCohortDelete();
  return {batchId:binding.batchId,workspaceId:binding.workspaceId,sourcePath:binding.plan.pathSteps[0].sourcePath,
    requestHash:auth.requestHash,actor:cohortDeleteActor(binding)};
}
export function assertCohortDeleteRootEvidence(plan:WorkspaceOperationCohortDeletePlan,roots:readonly CohortDeleteRoot[],dataRoot:string,witness:WorkspaceOperationMixedSourceEvidenceV5=plan.sourceEvidence):void{
  if(!Array.isArray(roots)||roots.length!==plan.pathSteps.length)return failCohortDelete('COHORT_DELETE_UNPROVEN');
  const ids=new Set<string>();
  for(const [index,item]of roots.entries()){
    const physical=decodePreparedWorkspacePathTrashOriginal(item.physical),step=plan.pathSteps[index],scope=plan.sourceEvidence.workspaceScope;
    if(item.stepKey!==`path:${String(index).padStart(4,'0')}`||physical.canonicalPath!==step.sourcePath
      ||physical.workspace.workspaceId!==scope.workspaceId||physical.workspace.workspaceType!==scope.workspaceType
      ||physical.workspace.organizationId!==scope.organizationId||physical.workspace.rootPath!==scope.rootPath||physical.workspace.dataRoot!==dataRoot
      ||ids.has(physical.trashEntryId))return failCohortDelete('COHORT_DELETE_UNPROVEN');
    ids.add(physical.trashEntryId);
    const targets=witness.namespace.filter(target=>cohortWithin(target.path,physical.canonicalPath));
    const fingerprints=preparedWorkspacePathTrashNamespaceFingerprints(physical);
    if(!Array.isArray(fingerprints)||new Set(fingerprints.map(item=>item.relativePath)).size!==fingerprints.length)return failCohortDelete();
    for(const entry of fingerprints){const literal=entry.relativePath?physical.canonicalPath+'/'+entry.relativePath:physical.canonicalPath;
      const target=targets.find(target=>target.path===literal);
      if(!target||target.filesystemIdentity!==entry.filesystemFingerprint)return failCohortDelete('COHORT_DELETE_CHANGED');}
    for(const target of targets){const relativePath=target.path===physical.canonicalPath?'':target.path.slice(physical.canonicalPath.length+1);
      if(target.filesystemIdentity!==null&&!fingerprints.some(entry=>entry.relativePath===relativePath&&entry.filesystemFingerprint===target.filesystemIdentity))return failCohortDelete('COHORT_DELETE_CHANGED');
      if(target.kind==='file'&&target.documentId===null&&target.filesystemIdentity===null)return failCohortDelete();}
    if(physical.source.kind==='projection_absent'&&targets.some(target=>target.filesystemIdentity!==null))return failCohortDelete();
  }
}
export function assertCohortDeleteIntentPlan(intent:CohortDeleteIntent,plan:WorkspaceOperationCohortDeletePlan,dataRoot:string):void{
  const original=decodeWorkspaceOperationCohortDeletePlan(plan),witness=decodeWorkspaceOperationMixedOriginalSourceWitness(original.sourceEvidence,intent.currentWitness);
  if(intent.version!==1||intent.kind!=='cohort-delete-original'||intent.batchId.length<16||intent.planId!==plan.planId
    ||!equal(intent.jobScope,witness.workspaceScope))return failCohortDelete('COHORT_DELETE_UNPROVEN');
  assertCohortDeleteRootEvidence(original,intent.roots,dataRoot,witness);
  const files=original.targets.filter(target=>target.kind==='file');
  if(intent.targets.length!==files.length||new Set(intent.targets.map(target=>target.path)).size!==files.length)return failCohortDelete();
  for(const file of files){const target=intent.targets.find(target=>target.path===file.path),root=intent.roots.find(root=>cohortWithin(file.path,root.physical.canonicalPath));
    const native=witness.nativeComponent.nativeBindings.find(binding=>binding.expected.path===file.path)?.expected??null;
    if(!target||!root||target.rootStep!==root.stepKey||!equal(target.native,native))return failCohortDelete();
    if(native){if(target.physicalRegistry!==null)return failCohortDelete();}
    else{if(!target.physicalRegistry)return failCohortDelete();const facts=captureOriginalPhysicalDeleteRegistryFactsV1(target.physicalRegistry);
      if(facts.sourcePath!==file.path||!equal(facts.workspaceScope,intent.jobScope))return failCohortDelete();}}
  const recipes=getWorkspaceOperationCohortDeleteRecipes(original);
  assertOriginalDeleteNativeLinkRecipeIntents(recipes,intent.nativeLinks);
  if(intent.nativeLinks.some(item=>original.targets.some(target=>target.path===item.prepared.source.path)))return failCohortDelete();
}
export function parseCohortDeleteIntent(row:WorkspaceOperationOriginalDeleteIntent,binding:CohortDeleteEvidenceBinding,
  workspace:WorkspaceContext,dataRoot:string):CohortDeleteIntent{
  if(binding.plan.version!==6||binding.actionMode!=='apply')return failCohortDelete();
  const value=captureCohortDeleteData<CohortDeleteIntent>(JSON.parse(row.intentText),1048576),auth=binding.authorization;
  if(auth.mode!=='direct'&&auth.mode!=='direct-mcp')return failCohortDelete();
  const expected=['version','kind','batchId','planId','requestHash','actor','jobScope','currentWitness','roots','targets','nativeLinks','admission'];
  if(!equal(Object.keys(value).sort(),expected.sort())||row.batchId!==binding.batchId||row.planId!==binding.planId||row.workspaceId!==binding.workspaceId
    ||row.requestHash!==auth.requestHash||sha(row.intentText)!==row.intentDigest||value.batchId!==binding.batchId||value.planId!==binding.planId
    ||value.requestHash!==auth.requestHash||!equal(value.actor,cohortDeleteActor(binding))||!equal(value.jobScope,auth.jobScope)
    ||!workspaceOperationJobScopeMatches(value.jobScope,workspace))return failCohortDelete('COHORT_DELETE_UNPROVEN');
  captureOriginalDeleteAdmissionBinding(value.admission);
  decodeOriginalDeleteNativeHtmlLinkIntentsV4(value.nativeLinks,cohortDeleteLinkContext(binding));
  assertCohortDeleteIntentPlan(value,binding.plan,dataRoot);
  return freezeCohortDelete(value);
}
export function completeCohortDeleteEvidence(row:WorkspaceOperationOriginalDeleteReceipt,trash:WorkspaceOperationOriginalDeleteReceipt|null,
  durable:WorkspaceOperationOriginalDeleteIntent,intent:CohortDeleteIntent):CohortDeleteResult{
  const value=captureCohortDeleteData<CohortDeleteCompletion>(JSON.parse(row.receiptText),2097152);
  const expected=['version','kind','batchId','intentDigest','physical','targets','nativeLinks','trashReceiptDigest'];
  if(!equal(Object.keys(value).sort(),expected.sort())||!Array.isArray(value.physical)||!Array.isArray(value.targets))return failCohortDelete('COHORT_DELETE_UNPROVEN');
  if(!trash||row.batchId!==durable.batchId||row.intentDigest!==durable.intentDigest||trash.batchId!==durable.batchId||trash.intentDigest!==durable.intentDigest
    ||sha(row.receiptText)!==row.receiptDigest||sha(trash.receiptText)!==trash.receiptDigest||value.version!==1||value.kind!=='cohort-delete-completion'
    ||value.batchId!==durable.batchId||value.intentDigest!==durable.intentDigest||value.trashReceiptDigest!==trash.receiptDigest
    ||trash.receiptText!==JSON.stringify(value.physical)||value.physical.length!==intent.roots.length||value.targets.length!==intent.targets.length)return failCohortDelete('COHORT_DELETE_UNPROVEN');
  for(const [index,root]of intent.roots.entries()){const physical=value.physical[index];
    if(!physical||physical.stepKey!==root.stepKey||!equal(decodePreparedWorkspacePathTrashReceipt(physical.receipt).original,root.physical))return failCohortDelete();}
  for(const [index,target]of intent.targets.entries()){const actual=value.targets[index],root=intent.roots.find(root=>root.stepKey===target.rootStep)!;
    if(!actual||!equal(Object.keys(actual).sort(),['path','rootStep','native','physicalRegistry','publicShare'].sort())||actual.path!==target.path||actual.rootStep!==target.rootStep)return failCohortDelete();
    if(target.native){const transition=actual.native;
      if(!transition||actual.physicalRegistry!==null||!equal({...transition.before.identity,...transition.before.clock,registryStateVersion:transition.before.registryStateVersion},target.native)
        ||!equal(transition.after.identity,{...transition.before.identity,lifecycleGeneration:target.native.lifecycleGeneration+1})
        ||!equal(transition.after.clock,transition.before.clock)||transition.after.registryStateVersion!==0||transition.after.status!=='archived'
        ||transition.writes.lineage.trashEntryId!==root.physical.trashEntryId||transition.writes.lineage.archivedAt!==root.physical.deletedAtMs)return failCohortDelete();
    }else{if(actual.native!==null||!target.physicalRegistry)return failCohortDelete();
      assertOriginalPhysicalDeleteRegistryReceiptV1(actual.physicalRegistry,target.physicalRegistry,root.physical.trashEntryId,root.physical.deletedAtMs);}}
  assertOriginalDeleteNativeHtmlLinkReceiptsV4(value.nativeLinks,intent.nativeLinks);
  return freezeCohortDelete({...value,receiptDigest:row.receiptDigest});
}
