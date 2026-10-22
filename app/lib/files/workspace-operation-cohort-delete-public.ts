import 'server-only';
import type { WorkspaceOperationBatchExecutionResult } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchExecutionPublicInput } from './workspace-operation-batch-execution-public';
import type { WorkspaceOperationBatchExecutionPublic } from './workspace-operation-batch-public';
import type { CohortDeleteObservation } from './workspace-operation-cohort-delete-domain';
import type { WorkspacePathCohortDeletePreparation } from './workspace-path-cohort-delete-preparation';
import type { WorkspaceOperationNativeDeletePreviewPublic } from './workspace-path-operation-preview';
import { decodeWorkspaceOperationCohortDeletePlan, getWorkspaceOperationCohortDeleteRecipes, failCohortDelete,
  type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';
import { assertOriginalDeleteNativeHtmlLinkReceiptsV4 } from './workspace-operation-original-delete-html-links';
import { encodeDirectMcpWorkspacePathResultV1, type DirectMcpWorkspacePathHtmlDeletePreviewV3 } from '../mcp/server/workspace-path-tool-contract';
export function workspaceOperationCohortDeleteEffects(input:WorkspaceOperationCohortDeletePlan){
  const plan=decodeWorkspaceOperationCohortDeletePlan(input),effects=new Map<string,{documentId:string;path:string;updatedLinks:number}>();
  for(const recipe of getWorkspaceOperationCohortDeleteRecipes(plan)){const previous=effects.get(recipe.source.documentId);
    if(previous&&previous.path!==recipe.source.path)return failCohortDelete();
    effects.set(recipe.source.documentId,{documentId:recipe.source.documentId,path:recipe.source.path,updatedLinks:(previous?.updatedLinks??0)+1});}
  return Object.freeze([...effects.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0));
}
export function workspaceOperationCohortDeleteExecutionResult(plan:WorkspaceOperationCohortDeletePlan,observation:CohortDeleteObservation):WorkspaceOperationBatchExecutionResult|null{
  if(observation.apply==='absent')return null;
  const effects=workspaceOperationCohortDeleteEffects(plan),complete=observation.apply==='complete',result=observation.result,totalActions=plan.pathSteps.length+effects.length;
  if(complete){if(!result||!observation.intent)return failCohortDelete('COHORT_DELETE_UNPROVEN');assertOriginalDeleteNativeHtmlLinkReceiptsV4(result.nativeLinks,observation.intent.nativeLinks);}
  return {status:complete?'applied':'needs_recovery',completedActions:complete?totalActions:0,totalActions,errorCode:complete?null:'BATCH_RECOVERY_REQUIRED',
    trashEntryIds:result?.physical.map(item=>item.receipt.original.trashEntryId)??[],stepResults:[...plan.pathSteps.map((step,index)=>({key:`path:${index}`,phase:'path' as const,
      state:complete?'applied' as const:'intent' as const,path:step.sourcePath,reviewId:step.reviewId,...(result?{trashEntryId:result.physical[index].receipt.original.trashEntryId}:{})})),
    ...effects.map((effect,index)=>({key:`link:${index}`,phase:'link' as const,state:complete?'applied' as const:'intent' as const,path:effect.path,...(complete?{updatedLinks:effect.updatedLinks}:{})}))]};
}
export function projectWorkspaceOperationCohortDeleteExecution(input:WorkspaceOperationBatchExecutionPublicInput&{plan:WorkspaceOperationCohortDeletePlan},
  observation:CohortDeleteObservation|null):WorkspaceOperationBatchExecutionPublic{
  const mode=input.actionMode;
  const rows=()=>[...input.plan.pathSteps.map((step,index)=>({key:`path:${index}`,phase:'path' as const,kind:'delete' as const,path:step.sourcePath,reviewId:step.reviewId})),
    ...workspaceOperationCohortDeleteEffects(input.plan).map((effect,index)=>({key:`link:${index}`,phase:'link' as const,kind:'link_update' as const,path:effect.path}))];
  const unavailable=():WorkspaceOperationBatchExecutionPublic=>({mode,receiptStatus:'unavailable',finalization:'pending',steps:rows().map(row=>({...row,state:'needs_check'}))});
  if(mode==='undo'||!observation)return unavailable();
  try{const execution=workspaceOperationCohortDeleteExecutionResult(input.plan,observation);
    if(execution?.status==='applied')return {mode,receiptStatus:'available',finalization:'complete',steps:rows().map(row=>({...row,state:'applied',...(row.phase==='link'?{openPath:row.path}:{})}))};
    if(input.status==='applied'||input.phase==='complete'||input.completedActions>0)return unavailable();
    return {mode,receiptStatus:observation.apply==='absent'?'not_started':'available',finalization:'pending',steps:rows().map(row=>({...row,state:observation.apply==='absent'?'pending':'needs_check'}))};
  }catch{return unavailable();}
}
export function workspaceOperationCohortDeleteWebPreview(input:WorkspaceOperationCohortDeletePlan):WorkspaceOperationNativeDeletePreviewPublic{
  const plan=decodeWorkspaceOperationCohortDeletePlan(input);
  return {version:2,kind:'native-original-delete',workspaceId:plan.workspaceId,planId:plan.planId,readiness:'ready',pathMappings:[],coverage:plan.coverage,
    linkAssessment:plan.linkAssessment,issues:[],linkEdits:getWorkspaceOperationCohortDeleteRecipes(plan).map(recipe=>({sourcePathBefore:recipe.source.path,sourcePathAfter:recipe.source.path,
      previousTargetLiteral:String(recipe.reference.kind==='link-mark'?recipe.reference.expected.href:recipe.reference.expected),nextTargetLiteral:''}))};
}
export function workspaceOperationMcpCohortDeletePreview(input:WorkspaceOperationCohortDeletePlan|WorkspacePathCohortDeletePreparation):DirectMcpWorkspacePathHtmlDeletePreviewV3{
  const early=input.kind==='native-path-import-preparation'?input:null,plan=early?null:decodeWorkspaceOperationCohortDeletePlan(input),
    selections=early?early.request.selections:plan!.actions[0].selections,assessment=input.linkAssessment,effects=plan?workspaceOperationCohortDeleteEffects(plan):[];
  // The public MCP Delete request intentionally retains its existing one-path
  // form. A folder expands internally; Web multi-selection uses the same owner.
  if(selections.length!==1)return failCohortDelete('COHORT_DELETE_UNSUPPORTED');
  const diagnostics=(items:typeof assessment.warnings|typeof assessment.blockers)=>items.map(item=>({code:item.reason,path:item.sourcePath,
    ...('line'in item&&item.line!==undefined?{line:item.line}:{}),targets:[...(item.htmlTargets??[])]}));
  const preview:DirectMcpWorkspacePathHtmlDeletePreviewV3={version:3,kind:'native-path-html-assessment',operationKind:'delete',executionReady:false,
    readiness:early?'blocked':'ready',workspaceId:early?early.scope.workspaceId:plan!.workspaceId,planId:input.planId,paths:selections.map(item=>({sourcePath:item.sourcePath})),
    linkChanges:{rewrites:0,unlinks:effects.reduce((count,item)=>count+item.updatedLinks,0),affectedDocuments:effects.length},coverage:{complete:early?early.coverage.complete:plan!.sourceEvidence.coverage.complete},
    linkAssessment:{complete:assessment.complete,warnings:diagnostics(assessment.warnings),blockers:diagnostics(assessment.blockers)},
    issues:input.issues.map(item=>({code:item.code,path:item.path})),imports:early?early.requiredRawImports.map(item=>({path:item.path,reasons:[...item.reasons]})):[]};
  const encoded=encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'preview',preview});
  if(encoded.action!=='preview'||encoded.preview.kind!=='native-path-html-assessment'||encoded.preview.version!==3)return failCohortDelete();return encoded.preview;
}
