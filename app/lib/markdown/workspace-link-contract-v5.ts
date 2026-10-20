import type { WorkspaceOperationMixedSourceEvidenceV5, WorkspaceOperationMixedSourceSnapshotV5 } from '../files/workspace-operation-mixed-source-evidence-v5';
import type { WorkspaceFileOperationLinkAssessmentV1 } from './workspace-link-contract-v1';
import type { NativeWorkspaceFileOperationPlan } from './workspace-link-contract-v2';
import type { MixedReadResolvedLinkV3 } from './workspace-link-contract-v3';

/** Parser4 facts are explicit. Original Stage1 gaps remain on this snapshot;
 * operation-specific HTML safety never turns them into complete coverage. */
export type WorkspaceMixedHtmlLinkSnapshotV5 = WorkspaceOperationMixedSourceSnapshotV5;
export type WorkspaceMixedHtmlLinkGraphV5 = WorkspaceMixedHtmlLinkSnapshotV5 & { edges: MixedReadResolvedLinkV3[] };
export type WorkspaceMixedHtmlFileOperationRequestV5 = {
  kind: NativeWorkspaceFileOperationPlan['kind'];
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  destinationEvidence?: WorkspaceOperationMixedSourceEvidenceV5;
};
export type WorkspaceMixedHtmlAssessmentBindingV5 = {
  htmlAssessment: WorkspaceFileOperationLinkAssessmentV1;
  htmlAssessmentProof: string;
  sourceCoverage: Array<{ workspaceId: string; coverage: WorkspaceMixedHtmlLinkSnapshotV5['coverage'] }>;
};
export type FilePlanV5 = Omit<NativeWorkspaceFileOperationPlan, 'contractVersion'> & {
  contractVersion: 5;
} & WorkspaceMixedHtmlAssessmentBindingV5;
