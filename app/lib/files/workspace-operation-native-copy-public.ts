import { workspaceOperationNativeCopyRawHtmlPublicPreview, type WorkspaceOperationNativeCopyPreviewPublicV6 } from './workspace-operation-native-copy-raw-html-public';
import type { WorkspaceOperationManagedCopyPlanV7 } from './workspace-operation-managed-copy-plan-v7';
import 'server-only';
import { workspaceOperationNativeCopyHtmlPublicPreview, type WorkspaceOperationNativeCopyPreviewPublicV5 } from './workspace-operation-native-copy-html-public';
import type { WorkspaceOperationManagedCopyPlanV6 } from './workspace-operation-managed-copy-plan-v6';

import { types } from 'node:util';
import type { WorkspaceFileOperationPreview } from '../markdown/workspace-file-operation-planner';
import { buildWorkspaceNativeLinkGraph, buildWorkspaceMixedReadLinkGraphV3 } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationNativeCopyPlan, WorkspaceOperationNativeCopyPlanError,
  type WorkspaceOperationNativeCopyPlan } from './workspace-operation-native-copy-plan';
import { decodeWorkspaceOperationAnyManagedCopyPlan, type WorkspaceOperationAnyManagedCopyPlan } from './workspace-operation-managed-copy-plan-v4';
import { decodeWorkspaceOperationManagedCopyPlanV5, type WorkspaceOperationManagedCopyPlanV5 } from './workspace-operation-managed-copy-plan-v5';
import { workspaceOperationMixedCopySourceSnapshot } from './workspace-operation-copy-source-evidence-v4';

/** Display data only. The fixed Copy owner performs fresh clone rebinding;
 * this summary never exposes a native identity, recipe or mutation capability. */
export type WorkspaceOperationNativeCopyPreviewPublicV4 = {
  version: 4;
  kind: 'native-copy';
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  planId: string;
  readiness: 'ready';
  pathMappings: Array<{
    sourceWorkspaceId: string; sourcePath: string;
    destinationWorkspaceId: string; destinationPath: string;
    sourceKind: 'file' | 'directory';
    /** UI deduplication only; never an original namespace identity. */
    sourceIdentity: string;
  }>;
  linkEdits: Array<{
    sourcePathBefore: string; sourcePathAfter: string;
    previousTargetLiteral: string; nextTargetLiteral: string;
  }>;
  /** Semantic import targets only. Concrete native spelling/anchors exist
   * after the actual target import and are not predicted by a Raw rehearsal. */
  importLinkBindings?: {
    status: 'requires-native-import-rebinding';
    targets: Array<{ sourcePathBefore: string; sourcePathAfter: string; previousTargetLiteral: string;
      targetPathAfter: string; fragment: string | null; alias: string | null; embed: boolean }>;
  };
  coverage: WorkspaceFileOperationPreview['coverage'];
  linkAssessment: WorkspaceFileOperationPreview['linkAssessment'];
  issues: [];
};

export type WorkspaceOperationNativeCopyPreviewPublic = WorkspaceOperationNativeCopyPreviewPublicV4 | WorkspaceOperationNativeCopyPreviewPublicV5 | WorkspaceOperationNativeCopyPreviewPublicV6;

export function workspaceOperationNativeCopyPublicPreview(input: WorkspaceOperationNativeCopyPlan | WorkspaceOperationAnyManagedCopyPlan | WorkspaceOperationManagedCopyPlanV5 | WorkspaceOperationManagedCopyPlanV6 | WorkspaceOperationManagedCopyPlanV7): WorkspaceOperationNativeCopyPreviewPublic {
  if (input !== null && typeof input === 'object' && !types.isProxy(input) && Object.getPrototypeOf(input) === Object.prototype
    && Object.getOwnPropertyDescriptor(input, 'version')?.value === 7) return workspaceOperationNativeCopyRawHtmlPublicPreview(input as WorkspaceOperationManagedCopyPlanV7);
  if (input !== null && typeof input === 'object' && !types.isProxy(input) && Object.getPrototypeOf(input) === Object.prototype
    && Object.getOwnPropertyDescriptor(input, 'version')?.value === 6) return workspaceOperationNativeCopyHtmlPublicPreview(input as WorkspaceOperationManagedCopyPlanV6);
  const managed = input !== null && typeof input === 'object' && !types.isProxy(input)
    && Object.getPrototypeOf(input) === Object.prototype
    && [3, 4].includes(Object.getOwnPropertyDescriptor(input, 'version')?.value);
  const raw = input !== null && typeof input === 'object' && !types.isProxy(input)
    && Object.getPrototypeOf(input) === Object.prototype
    && Object.getOwnPropertyDescriptor(input, 'version')?.value === 5;
  const plan = raw ? decodeWorkspaceOperationManagedCopyPlanV5(input)
    : managed ? decodeWorkspaceOperationAnyManagedCopyPlan(input) : decodeWorkspaceOperationNativeCopyPlan(input);
  const evidence = plan.sourceScope.workspaceId === plan.destinationScope.workspaceId
    ? [plan.sourceEvidence] : [plan.sourceEvidence, plan.destinationEvidence];
  const graphs = evidence.map(original => original.evidenceVersion === 4
    ? buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedCopySourceSnapshot(original)) : buildWorkspaceNativeLinkGraph(workspaceOperationNativePlanSnapshot(original,
    () => { throw new WorkspaceOperationNativeCopyPlanError('NATIVE_COPY_PLAN_INVALID'); })));
  const unresolved = graphs.flatMap(graph => graph.edges.filter(edge => ('classification' in edge && edge.classification === 'local')
    && edge.resolution.status !== 'resolved').map(edge => ({ workspaceId: graph.workspaceId, sourcePath: edge.source.path,
    targetLiteral: edge.literal, status: edge.resolution.status as Exclude<typeof edge.resolution.status, 'resolved'> })));
  const complete = graphs.every(graph => graph.coverage.complete && graph.coverage.gaps.length === 0);
  const importLinkBindings = plan.version === 5 ? {
    status: 'requires-native-import-rebinding' as const,
    targets: plan.nativePathPlan.physicalLinkIntents.map(intent => {
      const requirement = plan.rawImportRequirements.find(value => value.entityKey === intent.entityKey);
      if (!requirement) throw new WorkspaceOperationNativeCopyPlanError('NATIVE_COPY_PLAN_INVALID');
      return { sourcePathBefore: requirement.sourcePath, sourcePathAfter: requirement.destinationPath,
        previousTargetLiteral: intent.expectedSourceLiteral, targetPathAfter: intent.targetPathAfter,
        fragment: intent.fragment, alias: intent.alias, embed: intent.embed };
    }),
  } : undefined;
  return {
    version: 4, kind: 'native-copy', sourceWorkspaceId: plan.sourceScope.workspaceId,
    destinationWorkspaceId: plan.destinationScope.workspaceId, planId: plan.planId,
    // Private C1 plan data is supported by the fixed owner. Its private
    // executionReady:false remains an integrity/authority boundary, not a UI blocker.
    readiness: 'ready',
    pathMappings: plan.nativePathPlan.pathMappings.map(mapping => ({
      sourceWorkspaceId: plan.sourceScope.workspaceId, sourcePath: mapping.source.path,
      destinationWorkspaceId: mapping.destinationWorkspaceId, destinationPath: mapping.destinationPath,
      sourceKind: mapping.source.kind,
      sourceIdentity: `native-copy-preview:${nativeLinkJsonProof([plan.planId, mapping.source.workspaceId, mapping.source.path])}`,
    })),
    linkEdits: plan.nativePathPlan.mutations.flatMap(recipe => {
      const previous = recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected;
      if (typeof previous !== 'string' || typeof recipe.nextValue !== 'string') throw new WorkspaceOperationNativeCopyPlanError('NATIVE_COPY_PLAN_INVALID');
      // The real clone writer also discards cross-workspace equal-spelling
      // recipes after validating their fresh clone binding.
      return previous === recipe.nextValue ? [] : [{ sourcePathBefore: recipe.source.path, sourcePathAfter: recipe.sourcePathAfter,
        previousTargetLiteral: previous, nextTargetLiteral: recipe.nextValue }];
    }),
    ...(importLinkBindings === undefined ? {} : { importLinkBindings }),
    coverage: { complete: complete && unresolved.length === 0, omittedSources: [],
      unresolvedLinks: unresolved.map(({ workspaceId: _workspaceId, ...entry }) => entry) },
    linkAssessment: { version: 1, complete, warnings: unresolved.map(entry => ({ ...entry, reason: 'unaffected-existing-link' })), blockers: [] },
    issues: [],
  };
}
