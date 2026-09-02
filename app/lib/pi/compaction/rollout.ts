/**
 * Rollout controls for Hermes V2 session compaction.
 *
 * The legacy mode is intentionally retained as an operational rollback for
 * summary generation. Deterministic history-unit selection remains shared by
 * every mode because it prevents split tool transactions.
 */

export const PI_COMPACTION_ROLLOUT_ENV = 'CANVAS_PI_COMPACTION_ROLLOUT';

export type PiCompactionRolloutMode = 'legacy' | 'shadow' | 'v2';

export type PiCompactionRolloutDecision = Readonly<{
  mode: PiCompactionRolloutMode;
  summaryMode: 'legacy' | 'hermes_v2';
  pruningEnabled: boolean;
  shadowEvaluationEnabled: boolean;
  microCompactionEnabled: false;
}>;

export const DEFAULT_PI_COMPACTION_ROLLOUT_MODE: PiCompactionRolloutMode = 'v2';

export function resolvePiCompactionRolloutMode(value: unknown): PiCompactionRolloutMode {
  if (typeof value !== 'string') return DEFAULT_PI_COMPACTION_ROLLOUT_MODE;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'shadow' || normalized === 'v2') {
    return normalized;
  }
  return DEFAULT_PI_COMPACTION_ROLLOUT_MODE;
}

export function getPiCompactionRolloutDecision(
  value: unknown = process.env[PI_COMPACTION_ROLLOUT_ENV],
): PiCompactionRolloutDecision {
  const mode = resolvePiCompactionRolloutMode(value);
  return Object.freeze({
    mode,
    summaryMode: mode === 'v2' ? 'hermes_v2' : 'legacy',
    pruningEnabled: mode === 'v2',
    shadowEvaluationEnabled: mode === 'shadow',
    // Hermes leaves cache-breaking per-turn rewrites disabled by default.
    // Canvas V2 does not implement or expose a micro-compaction switch.
    microCompactionEnabled: false,
  });
}
