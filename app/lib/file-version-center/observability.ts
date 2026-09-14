import 'server-only';

import type { FileVersionCenterErrorCode } from './contracts/v1';

export type FileVersionCenterOperation =
  | 'resolve'
  | 'timeline'
  | 'compare'
  | 'restore'
  | 'policy'
  | 'accept'
  | 'reject'
  | 'tool_app_refresh';

export type FileVersionCenterOutcome =
  | 'success'
  | 'denied'
  | 'invalid'
  | 'rate_limited'
  | 'conflict'
  | 'truncated'
  | 'failure';

export type FileVersionCenterObservation = {
  operation: FileVersionCenterOperation;
  outcome: FileVersionCenterOutcome;
  startedAt?: number;
  errorCode?: FileVersionCenterErrorCode;
  itemCount?: number;
  hunkCount?: number;
  truncated?: boolean;
};

export type FileVersionCenterMetricAdapter = {
  increment(name: string, labels: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, labels: Readonly<Record<string, string>>): void;
};

type FileVersionCenterLogEvent = {
  component: 'file_version_center';
  version: 1;
  operation: FileVersionCenterOperation;
  outcome: FileVersionCenterOutcome;
  durationMs?: number;
  errorCode?: FileVersionCenterErrorCode;
  itemCount?: number;
  hunkCount?: number;
  truncated?: boolean;
};

const runtime = globalThis as typeof globalThis & {
  __canvasFileVersionCenterMetrics?: FileVersionCenterMetricAdapter;
};

function boundedMeasurement(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

/** Installs the process-local metrics bridge used by the deployment runtime. */
export function setFileVersionCenterMetricAdapter(adapter: FileVersionCenterMetricAdapter | undefined): void {
  runtime.__canvasFileVersionCenterMetrics = adapter;
}

/**
 * Emits only fixed enums, booleans and bounded counters. Document content,
 * paths, user IDs, grants and object IDs are intentionally not accepted.
 */
export function observeFileVersionCenter(input: FileVersionCenterObservation): void {
  const durationMs = input.startedAt === undefined
    ? undefined
    : boundedMeasurement(Date.now() - input.startedAt);
  const event: FileVersionCenterLogEvent = {
    component: 'file_version_center',
    version: 1,
    operation: input.operation,
    outcome: input.outcome,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(boundedMeasurement(input.itemCount) === undefined
      ? {} : { itemCount: boundedMeasurement(input.itemCount) }),
    ...(boundedMeasurement(input.hunkCount) === undefined
      ? {} : { hunkCount: boundedMeasurement(input.hunkCount) }),
    ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
  };
  const labels = {
    operation: event.operation,
    outcome: event.outcome,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  };
  try {
    runtime.__canvasFileVersionCenterMetrics?.increment('file_version_center_requests_total', labels);
    if (event.durationMs !== undefined) {
      runtime.__canvasFileVersionCenterMetrics?.observe(
        'file_version_center_request_duration_ms',
        event.durationMs,
        labels,
      );
    }
  } catch {
    // Observability must never change the request result.
  }
  console.info(JSON.stringify(event));
}
