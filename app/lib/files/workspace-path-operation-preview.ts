import type { WorkspacePathPhysicalDeletePreparationPlanV5 } from './workspace-path-physical-delete-preparation-v5';
import { workspaceOperationPhysicalDeleteWebPreviewV5 } from './workspace-operation-physical-delete-public-v5';
import 'server-only';

import type { WorkspaceFileOperationPreview } from '../markdown/workspace-file-operation-planner';
import type { WorkspaceOperationBatchPlan } from './workspace-operation-batch-contract';
import { WorkspaceOperationBatchError } from './workspace-operation-batch-store';
import { workspaceOperationBatchPublicPreview } from './workspace-operation-batch-plan';
import type { WorkspaceOperationNativeCopyPreviewPublic } from './workspace-operation-native-copy-public';
import type { WorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import type { WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import type { WorkspacePathHtmlNoImportPreparationPlanV2 } from './workspace-path-html-no-import-preparation';
import type { WorkspacePathHtmlNativeDeletePreparationPlanV3 } from './workspace-path-html-native-delete-preparation';

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
  | WorkspaceOperationNativeMovePreviewPublic | WorkspaceOperationNativeCopyPreviewPublic
  | WorkspacePathImportPreparationPreviewPublic | WorkspacePathHtmlNoImportPreviewPublic | WorkspacePathHtmlImportPreviewPublicV4 | WorkspaceOperationNativeDeletePreviewPublic;

export type WorkspaceOperationNativeDeletePreviewPublic = Omit<WorkspaceOperationNativeMovePreviewPublic,
  'version' | 'kind' | 'readiness'> & { version: 2; kind: 'native-original-delete'; readiness: 'ready' | 'blocked' };
export type WorkspacePathImportPreparationPreviewPublic = {
  version: 1; kind: 'native-path-import-preparation'; executionReady: false;
  workspaceId: string; planId: string; readiness: 'requires-import-rebinding' | 'blocked';
  pathMappings: Array<{ sourcePath: string; destinationPath: string }>;
  linkEdits: [];
  linkAssessment?: undefined;
  coverage: WorkspaceFileOperationPreview['coverage'];
  issues: Array<{ code: string; path: string }>;
  imports: Array<{ path: string; reasons: Array<'selected' | 'link-change'> }>;
  physicalLinkChanges: Array<{ sourcePathBefore: string; sourcePathAfter: string;
    previousTargetLiteral: string; targetPathAfter: string | null; action: 'rewrite' | 'unlink' }>;
};
export type WorkspacePathHtmlNoImportPreviewPublic = Omit<WorkspacePathImportPreparationPreviewPublic,
  'version' | 'readiness' | 'linkAssessment'> & {
  version: 2; readiness: 'blocked';
  linkAssessment: WorkspaceFileOperationPreview['linkAssessment'];
};

export type WorkspacePathHtmlImportPreviewPublicV4 = Omit<WorkspacePathImportPreparationPreviewPublic, 'version' | 'linkAssessment'> & {
  version: 4; linkAssessment: WorkspaceFileOperationPreview['linkAssessment'];
};

/** Display only: final native references and spellings do not exist before import. */
export function workspacePathImportPreparationPreview(plan: WorkspacePathImportPreparationPlanV1 | WorkspacePathHtmlNoImportPreparationPlanV2 | WorkspacePathHtmlNativeDeletePreparationPlanV3 | WorkspacePathHtmlImportPreparationPlanV4 | WorkspacePathPhysicalDeletePreparationPlanV5
): WorkspacePathImportPreparationPreviewPublic | WorkspacePathHtmlNoImportPreviewPublic | WorkspacePathHtmlImportPreviewPublicV4 {
  if (plan.readiness === 'native-ready') throw new WorkspaceOperationBatchError('BATCH_INVALID_PLAN', 409,
    'This file action uses its ordinary preview.');
  if (plan.version === 4) return { version: 4, kind: plan.kind, executionReady: false, workspaceId: plan.scope.workspaceId,
    planId: plan.planId, readiness: plan.readiness,
    pathMappings: plan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })),
    linkEdits: [], coverage: { complete: plan.coverage.complete, omittedSources: [], unresolvedLinks: [] },
    linkAssessment: structuredClone(plan.linkAssessment),
    issues: plan.issues.map(({ code, path }) => ({ code, path })),
    imports: plan.importRequirements.map(({ path, reasons }) => ({ path, reasons: [...reasons] })),
    physicalLinkChanges: plan.physicalLinkIntents.map(intent => ({ sourcePathBefore: intent.sourcePath,
      sourcePathAfter: intent.sourcePathAfter, previousTargetLiteral: intent.expectedSourceLiteral,
      targetPathAfter: intent.targetPathAfter, action: intent.action })) };
  if (plan.version === 2 || plan.version === 3 || plan.version === 5) return { version: 2, kind: plan.kind, executionReady: false,
    workspaceId: plan.scope.workspaceId, planId: plan.planId, readiness: 'blocked',
    pathMappings: plan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })),
    linkEdits: [], coverage: { complete: plan.coverage.complete, omittedSources: [], unresolvedLinks: [] },
    linkAssessment: structuredClone(plan.linkAssessment), issues: plan.issues.map(({ code, path }) => ({ code, path })),
    imports: plan.requiredRawImports.map(({ path, reasons }) => ({ path, reasons: [...reasons] })), physicalLinkChanges: [] };
  return { version: 1, kind: plan.kind, executionReady: false, workspaceId: plan.scope.workspaceId,
    planId: plan.planId, readiness: plan.readiness,
    pathMappings: plan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })),
    linkEdits: [], coverage: { complete: plan.coverage.complete, omittedSources: [], unresolvedLinks: [] },
    issues: plan.issues.map(({ code, path }) => ({ code, path })),
    imports: plan.importRequirements.map(({ path, reasons }) => ({ path, reasons: [...reasons] })),
    physicalLinkChanges: plan.physicalLinkIntents.map(intent => ({ sourcePathBefore: intent.sourcePath,
      sourcePathAfter: intent.sourcePathAfter, previousTargetLiteral: intent.expectedSourceLiteral,
      targetPathAfter: intent.targetPathAfter, action: intent.action })) };
}

export function workspacePathOperationPreview(plan: WorkspaceOperationBatchPlan): WorkspacePathOperationPreviewPublic {
  if (plan.version === 1) {
    const { previewContents: _privateContents, ...publicPlan } = plan.linkPlan;
    return { ...publicPlan, planId: plan.planId, readiness: plan.readiness };
  }
  if (plan.version === 5) return workspaceOperationPhysicalDeleteWebPreviewV5(plan);
  if (plan.version === 2) {
    return { version: 2, kind: 'native-original-delete', workspaceId: plan.workspaceId,
      planId: plan.planId, readiness: plan.readiness, pathMappings: [], coverage: plan.coverage,
      linkAssessment: plan.linkAssessment, issues: [],
      linkEdits: plan.nativeGraphPlan.steps.flatMap(step => step.linkIntents.map(intent => {
        const source = plan.nativeGraphPlan.finalNamespace.find(entry => entry.entityKey === intent.entityKey);
        if (!source || intent.action !== 'unlink' || intent.nextValue !== null) {
          throw new WorkspaceOperationBatchError('BATCH_INVALID_PLAN', 409, 'The deletion preview could not be verified.');
        }
        return { sourcePathBefore: source.path, sourcePathAfter: source.path,
          previousTargetLiteral: intent.expectedValue, nextTargetLiteral: '' };
      })) };
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
