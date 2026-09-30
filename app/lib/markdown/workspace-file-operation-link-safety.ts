import type { WorkspaceFileOperationPlanV1 } from './workspace-link-contract-v1';

/** Accept only the current, fully evaluated assessment; keep legacy plans strict. */
export function isWorkspaceFileOperationLinkSafe(
  plan: Pick<WorkspaceFileOperationPlanV1, 'coverage' | 'linkAssessment'>,
): boolean {
  if (!plan?.coverage || !Array.isArray(plan.coverage.omittedSources)
    || !Array.isArray(plan.coverage.unresolvedLinks)) return false;
  const assessment = plan.linkAssessment;
  if (assessment === undefined) return plan.coverage.complete === true
    && plan.coverage.omittedSources.length === 0 && plan.coverage.unresolvedLinks.length === 0;
  if (!assessment || assessment.version !== 1 || assessment.complete !== true
    || !Array.isArray(assessment.warnings) || !Array.isArray(assessment.blockers)
    || assessment.blockers.length !== 0 || plan.coverage.omittedSources.length !== 0) return false;

  // Every unresolved source must have an explicit, nonblocking classification.
  const warningStatuses = new Set(['missing', 'ambiguous', 'outside-workspace']);
  if (assessment.warnings.some((warning) => !warning || warning.reason !== 'unaffected-existing-link'
    || typeof warning.sourcePath !== 'string' || typeof warning.targetLiteral !== 'string'
    || !warningStatuses.has(warning.status))) return false;
  const warningKeys = new Set(assessment.warnings.map((warning) => JSON.stringify([
    warning.sourcePath, warning.targetLiteral, warning.status,
  ])));
  return plan.coverage.unresolvedLinks.every((link) => link
    && typeof link.sourcePath === 'string' && typeof link.targetLiteral === 'string'
    && warningStatuses.has(link.status) && warningKeys.has(JSON.stringify([
    link.sourcePath, link.targetLiteral, link.status,
  ])));
}
