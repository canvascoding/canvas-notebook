import 'server-only';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceOperationMixedSourceEvidenceV5, type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { cohortDeleteSelectionIssues, cohortDeletePathPlan, freezeCohortDelete, failCohortDelete } from './workspace-operation-cohort-delete-plan';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
export type WorkspacePathCohortDeletePreparation=Readonly<{version:6;kind:'native-path-import-preparation';executionReady:false;
  readiness:'native-ready'|'blocked';scope:WorkspaceOperationMixedSourceEvidenceV5['workspaceScope'];
  request:Readonly<{kind:'delete';selections:readonly Readonly<{sourcePath:string}>[]}>;sourceEvidence:WorkspaceOperationMixedSourceEvidenceV5;
  pathMappings:[];issues:Array<{code:string;workspaceId:string;path:string}>;coverage:WorkspaceOperationMixedSourceEvidenceV5['coverage'];
  linkAssessment:ReturnType<typeof cohortDeletePathPlan>['htmlAssessment'];requiredRawImports:readonly Readonly<{path:string;reasons:readonly ('selected'|'link-change')[]}>[];
  planId:string;integrityProof:string}>;
export function isWorkspaceCohortDeleteRequest(observation:WorkspaceLinkSourceAuthorityObservation,selections:readonly Readonly<{sourcePath:string}>[]):boolean{
  return selections.length>1||selections.some(selection=>observation.stage.namespace.find(entry=>entry.path===selection.sourcePath)?.kind==='directory');
}
export function createWorkspacePathCohortDeletePreparation(input:Readonly<{workspace:WorkspaceContext;selections:readonly Readonly<{sourcePath:string}>[];
  observation:WorkspaceLinkSourceAuthorityObservation}>):WorkspacePathCohortDeletePreparation{
  if(!isWorkspaceCohortDeleteRequest(input.observation,input.selections))return failCohortDelete();
  const scope=captureWorkspaceOperationJobScope(input.workspace),sourceEvidence=captureWorkspaceOperationMixedSourceEvidenceV5(scope,input.observation),
    request={kind:'delete' as const,selections:input.selections.map(selection=>({sourcePath:selection.sourcePath}))},
    action={reviewId:'cohort-delete-preparation',kind:'delete' as const,selections:request.selections},facts=cohortDeleteSelectionIssues(sourceEvidence,action),planned=cohortDeletePathPlan(sourceEvidence,action);
  const issues=[...facts.issues,...planned.issues],ready=!issues.length&&planned.readiness==='ready'&&planned.htmlAssessment.complete&&!planned.htmlAssessment.blockers.length;
  // Direct request action IDs differ from this display rehearsal. The final
  // shared batch builder supplies the actual action ID in native-ready cases.
  const body={version:6 as const,kind:'native-path-import-preparation' as const,executionReady:false as const,
    readiness:ready?'native-ready' as const:'blocked' as const,scope,request,sourceEvidence,pathMappings:[] as [],issues,
    coverage:sourceEvidence.coverage,linkAssessment:planned.htmlAssessment,requiredRawImports:sourceEvidence.physicalSources4.filter(source=>issues.some(issue=>issue.path===source.path))
      .map(source=>({path:source.path,reasons:['selected'] as const})),
    planId:proof({kind:'cohort-delete-preparation',scope,request,sourceSemanticProof:sourceEvidence.semanticProof,issues,htmlAssessmentProof:planned.htmlAssessmentProof})};
  return freezeCohortDelete({...body,integrityProof:proof(body)});
}
