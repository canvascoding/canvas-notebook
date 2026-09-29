import assert from 'node:assert/strict';

import { classifyTeamSeatOutboxFailure } from '../app/lib/license/team-seat-outbox-errors';
import { TEAM_SEAT_ERROR_CODES } from '../app/lib/license/team-seat-contract';
import { TeamSeatRolloutError, type TeamSeatRolloutStatus } from '../app/lib/license/team-seat-rollout';

const rollout = new TeamSeatRolloutError(
  'Team Seat snapshot reporting is disabled.',
  TEAM_SEAT_ERROR_CODES.featureDisabled,
  503,
  'community_claim',
  {} as TeamSeatRolloutStatus,
);
assert.deepEqual(classifyTeamSeatOutboxFailure(rollout), {
  code: TEAM_SEAT_ERROR_CODES.featureDisabled,
  message: 'Team Seat snapshot reporting is disabled.',
  terminal: true,
  retryAfterMs: null,
});

const blocked = Object.assign(new Error('Snapshot cannot be sent until rollout is enabled.'), {
  code: TEAM_SEAT_ERROR_CODES.featureDisabled,
  statusCode: 503,
});
assert.equal(classifyTeamSeatOutboxFailure(blocked).terminal, true);

const clientError = Object.assign(new Error('Unsupported protocol version.'), {
  code: 'PROTOCOL_UNSUPPORTED',
  statusCode: 409,
});
assert.equal(classifyTeamSeatOutboxFailure(clientError).terminal, true);

const outage = Object.assign(new Error('Temporary gateway outage.'), {
  code: 'GATEWAY_TIMEOUT',
  statusCode: 503,
});
assert.equal(classifyTeamSeatOutboxFailure(outage).terminal, false);
console.info('Team Seat rollout block is terminal; unrelated outages remain retryable');
