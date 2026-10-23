import 'server-only';

import { types } from 'node:util';
import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, type WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import { decodeWorkspacePathPhysicalDeletePreparationPlanV5 } from './workspace-path-physical-delete-preparation-v5';
import { workspaceOperationPhysicalDeleteEffectsV5 } from './workspace-operation-physical-delete-effects-v5';
import type { WorkspaceOperationNativeDeletePreviewPublic } from './workspace-path-operation-preview';
import { encodeDirectMcpWorkspacePathResultV1, WorkspacePathToolError,
  type DirectMcpWorkspacePathHtmlDeletePreviewV3 } from '../mcp/server/workspace-path-tool-contract';

/** The public Delete3 DTO is identical. A private version5 never masquerades
 * as a native archive: the DTO contains paths and checked link counts only. */
export function workspaceOperationMcpPhysicalHtmlDeletePreviewV3(input: unknown): DirectMcpWorkspacePathHtmlDeletePreviewV3 {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  const kind = Object.getOwnPropertyDescriptor(input, 'kind');
  if (!kind?.enumerable || !Object.hasOwn(kind, 'value')) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  const early = kind.value === 'native-path-import-preparation' ? decodeWorkspacePathPhysicalDeletePreparationPlanV5(input) : null;
  const plan = early ? null : decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input);
  if (early ? early.readiness !== 'blocked' : !plan || plan.readiness !== 'ready' || !plan.linkAssessment.complete
    || plan.linkAssessment.blockers.length || plan.issues.length) throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED');
  const assessment = early ? early.linkAssessment : plan!.linkAssessment, issues = early ? early.issues : plan!.issues;
  const selections = early ? early.request.selections : plan!.actions[0].selections, imports = early ? early.requiredRawImports : [];
  if (selections.length !== 1 || assessment.warnings.length > 10000 || assessment.blockers.length > 10000
    || issues.length > 10000 || imports.length > 10000) throw new WorkspacePathToolError('PATH_OUTPUT_TOO_LARGE');
  const diagnostics = (items: typeof assessment.warnings | typeof assessment.blockers) => items.map(item => ({
    code: item.reason, path: item.sourcePath, ...('line' in item && item.line !== undefined ? { line: item.line } : {}),
    targets: [...(item.htmlTargets ?? [])],
  }));
  const effects = plan ? workspaceOperationPhysicalDeleteEffectsV5(plan) : [];
  const result: DirectMcpWorkspacePathHtmlDeletePreviewV3 = {
    version: 3, kind: 'native-path-html-assessment', operationKind: 'delete', executionReady: false,
    readiness: early ? 'blocked' : 'ready', workspaceId: early ? early.scope.workspaceId : plan!.workspaceId,
    planId: early ? early.planId : plan!.planId, paths: selections.map(selection => ({sourcePath:selection.sourcePath})),
    linkChanges: {rewrites:0,unlinks:effects.reduce((count,effect)=>count+effect.updatedLinks,0),affectedDocuments:effects.length},
    coverage: {complete: early ? early.coverage.complete : plan!.sourceEvidence.coverage.complete},
    linkAssessment: {complete:assessment.complete,warnings:diagnostics(assessment.warnings),blockers:diagnostics(assessment.blockers)},
    issues:[...new Map(issues.map(item=>{const issue={code:/^[a-z][a-z0-9-]{0,99}$/u.test(item.code)?item.code:'unknown',path:item.path};return [JSON.stringify(issue),issue] as const;})).values()],
    imports: imports.map(item=>({path:item.path,reasons:[...item.reasons]})),
  };
  const encoded=encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'preview',preview:result});
  if(encoded.action!=='preview'||encoded.preview.kind!=='native-path-html-assessment'||encoded.preview.version!==3)throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  return encoded.preview;
}
export function workspaceOperationPhysicalDeleteWebPreviewV5(input: WorkspaceOperationPhysicalDeleteBatchPlanV5): WorkspaceOperationNativeDeletePreviewPublic {
  const plan=decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input);
  return {version:2,kind:'native-original-delete',workspaceId:plan.workspaceId,planId:plan.planId,readiness:plan.readiness,
    pathMappings:[],coverage:plan.coverage,linkAssessment:plan.linkAssessment,issues:[],
    linkEdits:plan.nativeGraphPlan.steps.flatMap(step=>step.linkIntents.map(intent=>{
      const source=plan.nativeGraphPlan.finalNamespace.find(entry=>entry.entityKey===intent.entityKey);
      if(!source||intent.action!=='unlink'||intent.nextValue!==null)throw new WorkspacePathToolError('PATH_UNAVAILABLE');
      return {sourcePathBefore:source.path,sourcePathAfter:source.path,previousTargetLiteral:intent.expectedValue,nextTargetLiteral:''};
    }))};
}
