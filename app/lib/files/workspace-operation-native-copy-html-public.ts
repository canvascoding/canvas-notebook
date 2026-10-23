import 'server-only';

import type { WorkspaceOperationNativeCopyPreviewPublicV4 } from './workspace-operation-native-copy-public';
import { decodeWorkspaceOperationManagedCopyPlanV6, type WorkspaceOperationManagedCopyPlanV6 } from './workspace-operation-managed-copy-plan-v6';
import { workspaceOperationMixedSourceSnapshotV5 } from './workspace-operation-mixed-source-evidence-v5';
import { buildWorkspaceMixedHtmlLinkGraphV5 } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';

export type WorkspaceOperationNativeCopyPreviewPublicV5 = Omit<WorkspaceOperationNativeCopyPreviewPublicV4, 'version' | 'importLinkBindings'> & {
  version: 5;
  /** Original gaps remain visible even when the exact operation is safe. */
  sourceCoverage: Array<{ workspaceId: string; coverage: { complete: boolean; gaps: Array<{ code: string; path: string }> } }>;
};
/** Display only: never native IDs, recipes, bytes, catalogue or current grants. */
export function workspaceOperationNativeCopyHtmlPublicPreview(input: WorkspaceOperationManagedCopyPlanV6): WorkspaceOperationNativeCopyPreviewPublicV5 {
  const plan = decodeWorkspaceOperationManagedCopyPlanV6(input);
  const evidence = plan.sourceScope.workspaceId === plan.destinationScope.workspaceId ? [plan.sourceEvidence] : [plan.sourceEvidence, plan.destinationEvidence];
  const graphs = evidence.map(value => buildWorkspaceMixedHtmlLinkGraphV5(workspaceOperationMixedSourceSnapshotV5(value)));
  const unresolved = graphs.flatMap(graph => graph.edges.filter(edge => edge.classification === 'local' && edge.resolution.status !== 'resolved')
    .map(edge => ({ workspaceId: graph.workspaceId, sourcePath: edge.source.path, targetLiteral: edge.literal,
      status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })));
  const sourceCoverage = graphs.map(graph => ({ workspaceId: graph.workspaceId, coverage: { complete: graph.coverage.complete,
    gaps: graph.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })) } }));
  return { version: 5, kind: 'native-copy', sourceWorkspaceId: plan.sourceScope.workspaceId,
    destinationWorkspaceId: plan.destinationScope.workspaceId, planId: plan.planId, readiness: 'ready',
    pathMappings: plan.nativePathPlan.pathMappings.map(mapping => ({ sourceWorkspaceId: plan.sourceScope.workspaceId,
      sourcePath: mapping.source.path, destinationWorkspaceId: mapping.destinationWorkspaceId, destinationPath: mapping.destinationPath,
      sourceKind: mapping.source.kind, sourceIdentity: `native-copy-preview:${proof([plan.planId, mapping.source.workspaceId, mapping.source.path])}` })),
    linkEdits: plan.nativePathPlan.mutations.flatMap(recipe => {
      const previous = recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected;
      if (typeof previous !== 'string' || typeof recipe.nextValue !== 'string') throw new Error('MANAGED_COPY_PLAN_INVALID');
      return previous === recipe.nextValue ? [] : [{ sourcePathBefore: recipe.source.path, sourcePathAfter: recipe.sourcePathAfter,
        previousTargetLiteral: previous, nextTargetLiteral: recipe.nextValue }];
    }),
    coverage: { complete: sourceCoverage.every(row => row.coverage.complete) && unresolved.length === 0,
      omittedSources: [], unresolvedLinks: unresolved.map(({ workspaceId: _workspace, ...link }) => link) },
    linkAssessment: { version: 1, complete: plan.nativePathPlan.htmlAssessment.complete,
      warnings: [...unresolved.map(link => ({ ...link, reason: 'unaffected-existing-link' as const })),
        ...plan.nativePathPlan.htmlAssessment.warnings], blockers: [] },
    sourceCoverage, issues: [] };
}
