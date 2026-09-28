import 'server-only';

import type { FileVersionCenterMetricAdapter } from '@/app/lib/file-version-center/observability';

export type WorkspaceOperationMetricKind = 'rename' | 'move' | 'copy' | 'delete';
export type WorkspaceOperationMetricScope = 'executor' | 'review';
export type WorkspaceOperationMetricPhase = 'preview' | 'apply' | 'recovery';
export type WorkspaceOperationMetricOutcome = 'incomplete_link_plan' | 'conflict' | 'needs_recovery' | 'failed';

export type WorkspaceOperationObservation = {
  scope: WorkspaceOperationMetricScope;
  kind: WorkspaceOperationMetricKind;
  phase: WorkspaceOperationMetricPhase;
  outcome: WorkspaceOperationMetricOutcome;
  omittedSourceCount?: number;
  unresolvedLinkCount?: number;
};

const KINDS = new Set<WorkspaceOperationMetricKind>(['rename', 'move', 'copy', 'delete']);
const SCOPES = new Set<WorkspaceOperationMetricScope>(['executor', 'review']);
const PHASES = new Set<WorkspaceOperationMetricPhase>(['preview', 'apply', 'recovery']);
const OUTCOMES = new Set<WorkspaceOperationMetricOutcome>([
  'incomplete_link_plan', 'conflict', 'needs_recovery', 'failed',
]);

const runtime = globalThis as typeof globalThis & {
  __canvasFileVersionCenterMetrics?: FileVersionCenterMetricAdapter;
};

function boundedCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

/** Emits bounded, content-free events through the shared metrics bridge and structured logs. */
export function observeWorkspaceOperation(input: WorkspaceOperationObservation): void {
  if (!SCOPES.has(input.scope) || !KINDS.has(input.kind)
    || !PHASES.has(input.phase) || !OUTCOMES.has(input.outcome)) return;
  const event = {
    component: 'workspace_file_operation', version: 1,
    scope: input.scope, kind: input.kind, phase: input.phase, outcome: input.outcome,
    ...(boundedCount(input.omittedSourceCount) === undefined
      ? {} : { omittedSourceCount: boundedCount(input.omittedSourceCount) }),
    ...(boundedCount(input.unresolvedLinkCount) === undefined
      ? {} : { unresolvedLinkCount: boundedCount(input.unresolvedLinkCount) }),
  };
  const labels = { scope: event.scope, kind: event.kind, phase: event.phase, outcome: event.outcome };
  try {
    runtime.__canvasFileVersionCenterMetrics?.increment('workspace_file_operation_events_total', labels);
    if (event.omittedSourceCount !== undefined) {
      runtime.__canvasFileVersionCenterMetrics?.observe(
        'workspace_file_operation_omitted_sources', event.omittedSourceCount, labels);
    }
    if (event.unresolvedLinkCount !== undefined) {
      runtime.__canvasFileVersionCenterMetrics?.observe(
        'workspace_file_operation_unresolved_links', event.unresolvedLinkCount, labels);
    }
  } catch {
    // Metrics must never change a file operation result.
  }
  try {
    console.info(JSON.stringify(event));
  } catch {
    // Logging is best-effort too.
  }
}
