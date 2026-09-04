import assert from 'node:assert/strict';

import {
  getSystemUpdatePhaseProgress,
  resolveSystemUpdateReadinessReasonKey,
  resolveSystemUpdateUserPhase,
  SYSTEM_UPDATE_USER_PHASE_ORDER,
} from '../app/lib/system-updates/presentation';
import { SYSTEM_UPDATE_STAGES, type SystemUpdateStage } from '../cli/src/core/systemUpdateContract';

const expectedPhaseByStage: Record<SystemUpdateStage, string> = {
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

assert.deepEqual(SYSTEM_UPDATE_USER_PHASE_ORDER, [
  'preparing',
  'safeguarding',
  'installing',
  'restarting',
  'completed',
]);

for (const stage of SYSTEM_UPDATE_STAGES) {
  assert.equal(
    resolveSystemUpdateUserPhase({ stage, status: stage === 'completed' ? 'succeeded' : 'running' }),
    expectedPhaseByStage[stage],
    `unexpected user phase for ${stage}`,
  );
}

assert.equal(resolveSystemUpdateUserPhase({ stage: 'health_verification', status: 'rolled_back', rolledBack: true }), 'restoring');
assert.equal(resolveSystemUpdateUserPhase({ stage: 'version_verification', status: 'succeeded' }), 'completed');
assert.equal(resolveSystemUpdateReadinessReasonKey('current_version_unknown'), 'currentVersionUnknown');
assert.equal(resolveSystemUpdateReadinessReasonKey('host_cli_version_unknown'), 'hostCliVersionUnknown');
assert.equal(resolveSystemUpdateReadinessReasonKey('minimum_version_not_met'), 'minimumVersionNotMet');
assert.equal(resolveSystemUpdateReadinessReasonKey('future_reason'), 'technicalReviewRequired');
assert.deepEqual(
  SYSTEM_UPDATE_USER_PHASE_ORDER.map(getSystemUpdatePhaseProgress),
  [16, 34, 62, 86, 100],
);

console.log('system-update-presentation-test: ok');
