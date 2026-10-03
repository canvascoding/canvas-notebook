import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchProgress } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchExecutionPublic } from './workspace-operation-batch-public';
import { groupWorkspaceLinkWrites } from '@/app/lib/markdown/workspace-link-write-groups';

type JournalStep = { key: string; state: 'intent' | 'applied'; receipt: Record<string, unknown> | null };
export type WorkspaceOperationBatchPublicJournal = {
  status: string; steps: JournalStep[]; undoSteps: JournalStep[];
  undoPlan: WorkspaceOperationBatchPlan['linkPlan'] | null;
};
export type WorkspaceOperationBatchExecutionPublicInput = {
  plan: WorkspaceOperationBatchPlan; actionMode: 'apply' | 'undo'; status: string;
  completedActions: number; phase: WorkspaceOperationBatchProgress['phase'];
};

/** No filesystem probes: states describe journal acknowledgments of the approved work. */
export function projectWorkspaceOperationBatchExecution(
  input: WorkspaceOperationBatchExecutionPublicInput,
  journal: WorkspaceOperationBatchPublicJournal | null,
  unreadable = false,
): WorkspaceOperationBatchExecutionPublic {
  const mode = journal?.status === 'applied' && !journal.undoSteps?.length && !journal.undoPlan ? 'apply'
    : journal?.undoPlan || journal?.undoSteps?.length || journal?.status === 'undone' ? 'undo' : input.actionMode;
  const pathRows = input.plan.pathSteps.map((step, index) => ({ key: `path:${index}`, phase: 'path' as const,
    kind: mode === 'undo' && step.kind === 'delete' ? 'restore' as const : step.kind,
    path: mode === 'undo' ? step.destinationPath ?? step.sourcePath : step.sourcePath,
    ...(mode === 'undo' && step.kind !== 'delete' ? { destinationPath: step.sourcePath }
      : mode === 'apply' && step.destinationPath ? { destinationPath: step.destinationPath } : {}),
    reviewId: step.reviewId, state: 'pending' as const }));
  if (input.plan.readiness !== 'ready' || input.plan.linkPlan.readiness !== 'ready') {
    // A blocked preview has displayable paths, but no executable write groups or receipts.
    const linkPaths = [...new Set(input.plan.previewContents.map((entry) => entry.path))];
    const rows = [...pathRows, ...linkPaths.map((path, index) => ({ key: `link:${index}`, phase: 'link' as const,
      kind: 'link_update' as const, path, state: 'pending' as const }))];
    const untouched = !journal && !unreadable && input.actionMode === 'apply' && input.completedActions === 0
      && input.phase === 'preparing' && ['preview', 'blocked', 'needs_review'].includes(input.status);
    return { mode, receiptStatus: untouched ? 'not_started' : 'unavailable', finalization: 'pending',
      steps: untouched ? rows : rows.map((row) => ({ ...row, state: 'needs_check' as const })) };
  }
  const groups = groupWorkspaceLinkWrites(mode === 'undo' && journal?.undoPlan ? journal.undoPlan : input.plan.linkPlan);
  const linkRows = groups.map((group, index) => ({ key: `link:${index}`, phase: 'link' as const,
    kind: 'link_update' as const, path: group.path, state: 'pending' as const }));
  const rows = mode === 'undo' ? [...linkRows, ...pathRows.reverse()] : [...pathRows, ...linkRows];
  const unavailable = (): WorkspaceOperationBatchExecutionPublic => ({ mode, receiptStatus: 'unavailable', finalization: 'pending',
    steps: rows.map((row) => ({ ...row, state: 'needs_check' })) });
  if (unreadable) return unavailable();
  if (!journal) {
    if (input.actionMode === 'undo' || input.completedActions > 0 || ['paths', 'links', 'recovery', 'complete'].includes(input.phase)
      || ['applied', 'undone', 'needs_recovery'].includes(input.status)) return unavailable();
    return { mode, receiptStatus: 'not_started', finalization: 'pending', steps: rows };
  }
  if (!['preparing', 'applying', 'applied', 'needs_review', 'needs_recovery', 'failed', 'undoing', 'undone'].includes(journal.status)) return unavailable();
  const steps = mode === 'undo' ? journal.undoSteps : journal.steps;
  if (!Array.isArray(steps) || !Array.isArray(journal.steps) || !Array.isArray(journal.undoSteps)) return unavailable();
  if (mode === 'undo') {
    // Reverse work requires the complete forward journal; do not hide a corrupt original receipt.
    const forward = projectWorkspaceOperationBatchExecution({ ...input, actionMode: 'apply', completedActions: 0 },
      { ...journal, status: 'applied', undoPlan: null, undoSteps: [] });
    if (forward.receiptStatus !== 'available' || forward.finalization !== 'complete') return unavailable();
  }
  const expected = new Map(rows.map((row) => [row.key, row]));
  if (expected.size !== rows.length) return unavailable();
  const acknowledged = new Map<string, JournalStep>();
  for (const step of steps) {
    if (!step || !expected.has(step.key) || acknowledged.has(step.key) || !['intent', 'applied'].includes(step.state)) return unavailable();
    if (step.state === 'applied') {
      if (!step.receipt || typeof step.receipt !== 'object' || Array.isArray(step.receipt)) return unavailable();
      const row = expected.get(step.key)!;
      if (row.phase === 'path' && (!Array.isArray(step.receipt.afterTree) || !step.receipt.afterTree.length
        || (row.kind === 'delete' || row.kind === 'restore'
          ? typeof step.receipt.trashEntryId !== 'string' || !step.receipt.trashEntryId
          : typeof step.receipt.mutationId !== 'string' || !step.receipt.mutationId))) return unavailable();
      if (row.phase === 'link') {
        const group = groups[Number(step.key.split(':')[1])];
        if (step.receipt.path !== row.path || step.receipt.workspaceId !== input.plan.workspaceId
          || !['applied', 'already-applied'].includes(String(step.receipt.status))
          || step.receipt.beforeSha256 !== group.beforeSha256 || step.receipt.afterSha256 !== group.afterSha256) return unavailable();
      }
    }
    acknowledged.set(step.key, step);
  }
  const applied = steps.filter((step) => step.state === 'applied').length;
  if (mode === 'apply' && input.completedActions > applied) return unavailable();
  const complete = mode === 'undo' ? journal.status === 'undone' : journal.status === 'applied';
  if (complete && (applied !== rows.length || steps.length !== rows.length)) return unavailable();
  return { mode, receiptStatus: 'available', finalization: complete ? 'complete' : 'pending', steps: rows.map((row) => {
    const state = acknowledged.get(row.key)?.state === 'applied' ? 'applied' : acknowledged.has(row.key) ? 'needs_check' : 'pending';
    let openPath = row.phase === 'link' ? mode === 'apply' ? groups[Number(row.key.split(':')[1])].sourcePathBefore : row.path : undefined;
    if (openPath) for (const pathRow of pathRows) {
      if (pathRow.kind === 'restore' || !pathRow.destinationPath
        || openPath !== pathRow.path && !openPath.startsWith(`${pathRow.path}/`)) continue;
      const reverse = acknowledged.get(pathRow.key);
      if (reverse?.state === 'intent') { openPath = undefined; break; }
      if (reverse?.state === 'applied') openPath = `${pathRow.destinationPath}${openPath.slice(pathRow.path.length)}`;
    }
    return { ...row, state, ...(openPath ? { openPath } : {}) };
  }) };
}
