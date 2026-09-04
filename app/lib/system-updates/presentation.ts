import type { SystemUpdateOperationStatus, SystemUpdateStage } from '@/cli/src/core/systemUpdateContract';

export const SYSTEM_UPDATE_USER_PHASE_ORDER = [
  'preparing',
  'safeguarding',
  'installing',
  'restarting',
  'completed',
] as const;

export type SystemUpdateUserPhase = typeof SYSTEM_UPDATE_USER_PHASE_ORDER[number] | 'restoring';

const STAGE_TO_USER_PHASE: Record<SystemUpdateStage, SystemUpdateUserPhase> = {
  request_validation: 'preparing',
  operation_lock: 'preparing',
  release_verification: 'preparing',
  host_cli_capabilities: 'preparing',
  config_preflight: 'preparing',
  database_preflight: 'preparing',
  backup: 'safeguarding',
  image_pull: 'installing',
  container_recreate: 'installing',
  health_verification: 'restarting',
  version_verification: 'restarting',
  rollback: 'restoring',
  completed: 'completed',
};

const READINESS_REASON_KEYS = {
  current_version_unknown: 'currentVersionUnknown',
  host_cli_version_unknown: 'hostCliVersionUnknown',
  minimum_version_not_met: 'minimumVersionNotMet',
} as const;

export type SystemUpdateReadinessReasonKey =
  | typeof READINESS_REASON_KEYS[keyof typeof READINESS_REASON_KEYS]
  | 'technicalReviewRequired';

export function resolveSystemUpdateUserPhase(input: {
  stage: SystemUpdateStage;
  status: SystemUpdateOperationStatus;
  rolledBack?: boolean;
}): SystemUpdateUserPhase {
  if (input.rolledBack || input.status === 'rolled_back' || input.stage === 'rollback') return 'restoring';
  if (input.status === 'succeeded') return 'completed';
  return STAGE_TO_USER_PHASE[input.stage];
}

export function resolveSystemUpdateReadinessReasonKey(reason: string): SystemUpdateReadinessReasonKey {
  return READINESS_REASON_KEYS[reason as keyof typeof READINESS_REASON_KEYS] || 'technicalReviewRequired';
}

export function getSystemUpdatePhaseProgress(phase: SystemUpdateUserPhase): number {
  switch (phase) {
    case 'preparing':
      return 16;
    case 'safeguarding':
      return 34;
    case 'installing':
      return 62;
    case 'restarting':
      return 86;
    case 'restoring':
      return 88;
    case 'completed':
      return 100;
  }
}
