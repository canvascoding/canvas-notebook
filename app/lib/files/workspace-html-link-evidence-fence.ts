import 'server-only';

import { assertWorkspaceOperationBatchApprovalCurrent } from './workspace-operation-batch-approval-fence';
import { WorkspaceOperationBatchError } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';

/** An unchanged HTML source still needs the same durable content proof before a path write. */
export async function assertWorkspaceHtmlLinkEvidenceCurrent(
  plan: WorkspaceOperationBatchPlan,
  scope: WorkspaceOperationBatchScope,
  check = assertWorkspaceOperationBatchApprovalCurrent,
): Promise<void> {
  const paths = new Set(plan.linkAssessment.warnings
    .filter((warning) => warning.reason === 'unaffected-explicit-html-link').map((warning) => warning.sourcePath));
  if (!paths.size) return;
  const expectedPathState = plan.expectedPathState.filter((entry) => paths.has(entry.path));
  if (expectedPathState.length !== paths.size || expectedPathState.some((entry) => entry.identity === null || entry.contentHash === null)) {
    throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'The HTML link evidence changed. Check again.');
  }
  await check({ ...plan, expectedPathState, originalDocuments: [] }, scope);
}
