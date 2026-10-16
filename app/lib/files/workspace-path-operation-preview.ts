import 'server-only';

import type { WorkspaceFileOperationPreview } from '../markdown/workspace-file-operation-planner';
import type { WorkspaceOperationBatchPlan } from './workspace-operation-batch-contract';
import { WorkspaceOperationBatchError } from './workspace-operation-batch-store';
import { workspaceOperationBatchPublicPreview } from './workspace-operation-batch-plan';

/** Native preview text is a display summary. No Markdown offsets, document
 * IDs, relative positions or native evidence are exposed or fabricated. */
export type WorkspaceOperationNativeMovePreviewPublic = {
  version: 3; kind: 'native-path-change'; workspaceId: string; planId: string; readiness: 'ready';
  pathMappings: ReturnType<typeof workspaceOperationBatchPublicPreview>['pathMappings'];
  linkEdits: Array<{ sourcePathBefore: string; sourcePathAfter: string; previousTargetLiteral: string; nextTargetLiteral: string }>;
  coverage: WorkspaceFileOperationPreview['coverage'];
  linkAssessment: WorkspaceFileOperationPreview['linkAssessment'];
  issues: [];
};
export type WorkspacePathOperationPreviewPublic = Omit<WorkspaceFileOperationPreview, 'previewContents'>
  | WorkspaceOperationNativeMovePreviewPublic;

export function workspacePathOperationPreview(plan: WorkspaceOperationBatchPlan): WorkspacePathOperationPreviewPublic {
  if (plan.version === 1) {
    const { previewContents: _privateContents, ...publicPlan } = plan.linkPlan;
    return { ...publicPlan, planId: plan.planId, readiness: plan.readiness };
  }
  if (plan.version !== 3) throw new WorkspaceOperationBatchError('BATCH_NATIVE_PREVIEW_UNSUPPORTED', 409,
    'This plan does not describe a path change.');
  const visible = workspaceOperationBatchPublicPreview(plan);
  return { version: 3, kind: plan.kind, workspaceId: plan.workspaceId, planId: plan.planId, readiness: plan.readiness,
    pathMappings: visible.pathMappings, coverage: plan.coverage, linkAssessment: plan.linkAssessment, issues: [],
    linkEdits: plan.nativePathPlan.mutations.map(recipe => {
      const previous = recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected;
      if (typeof previous !== 'string' || recipe.nextValue === null) throw new WorkspaceOperationBatchError('BATCH_INVALID_PLAN', 409,
        'The native link preview could not be verified.');
      return { sourcePathBefore: recipe.source.path, sourcePathAfter: recipe.sourcePathAfter,
        previousTargetLiteral: previous, nextTargetLiteral: recipe.nextValue };
    }) };
}
