import assert from 'node:assert/strict';
import type { TeamSeatHealth } from '../app/lib/license/team-seat-health-types';
import { isTeamLicenseApplicable, teamHealthAttentionReason } from '../app/lib/license/ui-policy';

const now = Date.parse('2030-01-01T12:00:00.000Z');
const day = 86_400_000;

const applicabilityCases: Array<[string, Parameters<typeof isTeamLicenseApplicable>[0], boolean]> = [
  ['missing status', null, false],
  ['unknown status', {}, false],
  ['Solo edition', { edition: 'solo' }, false],
  ['Team edition', { edition: 'team' }, true],
  ['capability pair', { capabilities: { multiUser: true, teamWorkspace: true } }, true],
  ['legacy feature pair', { features: { multiUser: true, teamWorkspace: true } }, true],
  ['incomplete capabilities', { capabilities: { multiUser: true, teamWorkspace: false } }, false],
  ['incomplete features', { features: { multiUser: false, teamWorkspace: true } }, false],
  ['no cross-pair inference', { capabilities: { multiUser: true }, features: { teamWorkspace: true } }, false],
  ['legacy feature pair with empty capabilities', { capabilities: {}, features: { multiUser: true, teamWorkspace: true } }, true],
  ['configured Managed Team', { runtimeDeploymentMode: 'managed-team' }, true],
  ['normalized Managed Team alias', { runtimeDeploymentMode: '  MANAGED_TEAM  ', edition: 'solo' }, true],
  ['Managed Solo', { runtimeDeploymentMode: 'managed-single', edition: 'solo' }, false],
  ['self-hosted runtime without Team evidence', { runtimeDeploymentMode: 'enterprise-onprem' }, false],
];
for (const [label, status, expected] of applicabilityCases) {
  assert.equal(isTeamLicenseApplicable(status), expected, label);
}

function healthy(): TeamSeatHealth {
  return {
    mode: 'managed-team', organizationId: 'policy-organization', generatedAt: new Date(now).toISOString(),
    managedAccessPolicy: { state: 'active', reason: null, graceEndsAt: null },
    historicalCommunity: { pendingOperations: 4, failedOperations: 8 },
    license: { class: 'manual', environment: 'production', seatLimit: 10,
      expiresAt: new Date(now + 60_000).toISOString(), termEndsAt: new Date(now + 180 * day).toISOString(),
      nonBillable: true, billingMode: 'manual_grant' },
    claim: { state: 'connected', connectionExpiresAt: null, reconnectReason: null },
    sync: { state: 'healthy', managedState: 'current', lastAttemptAt: new Date(now).toISOString(), lastError: null,
      membershipRevision: 5, entitlementsVersion: 7, blocker: null, observedQuantity: 2,
      approvedQuantity: 2, billedQuantity: null, licensedQuantity: 10,
      lastSyncAt: new Date(now).toISOString(), nextReportAt: new Date(now + 60_000).toISOString(),
      staleAfterAt: new Date(now + 180_000).toISOString(), driftStatus: null,
      reconciliationStatus: 'in_sync', reconciliationAction: null, reconciliationReason: null,
      reconciliationSeatLimit: 10, supportRequired: false, pendingOperations: 0,
      failedOperations: 0, oldestPendingAt: null },
    grace: { licenseState: 'active', startedAt: null, expiresAt: null, remainingSeconds: null,
      refreshPhase: null, nextRefreshAt: null, lastRefreshErrorCode: null },
    recovery: { canSyncSnapshot: true, canRefreshLicense: false, reconnectRequired: false, costConfirmationRequired: false },
    emailDelivery: { manualReview: 0, retryPending: 0 },
  };
}

type AttentionReason = ReturnType<typeof teamHealthAttentionReason>;
function check(label: string, expected: AttentionReason, change: (health: TeamSeatHealth) => void = () => {}) {
  const health = healthy();
  change(health);
  assert.equal(teamHealthAttentionReason(health, now), expected, label);
}

check('healthy Managed Team; short certificate lifetime and historical Community failures are irrelevant', null);
check('healthy self-hosted Team', null, (health) => {
  health.mode = 'community';
  health.sync.managedState = undefined;
  health.managedAccessPolicy = null;
  health.license.termEndsAt = null;
});
check('remaining seat capacity is healthy', null, (health) => { health.sync.observedQuantity = 9; });
check('capacity reached', 'capacity', (health) => { health.sync.observedQuantity = 10; });
check('over capacity', 'capacity', (health) => { health.sync.observedQuantity = 11; });
check('unknown observed quantity is not capacity reached', null, (health) => { health.sync.observedQuantity = null; });
check('unknown capacity is not zero capacity', null, (health) => {
  health.sync.licensedQuantity = null;
  health.license.seatLimit = null;
});
check('invalid zero capacity is not a capacity warning', null, (health) => {
  health.sync.licensedQuantity = 0;
  health.license.seatLimit = 0;
});

check('restricted access', 'restricted', (health) => {
  health.managedAccessPolicy = { state: 'restricted', reason: 'grant_revoked', graceEndsAt: null };
});
for (const licenseState of ['restricted', 'expired', 'revoked']) {
  check(`license access ${licenseState}`, 'restricted', (health) => { health.grace.licenseState = licenseState; });
}
check('Managed grant grace', 'grace', (health) => {
  health.managedAccessPolicy = { state: 'grace', reason: 'grant_expired', graceEndsAt: new Date(now + day).toISOString() };
});
for (const licenseState of ['grace', 'grace_required']) {
  check(`offline license ${licenseState}`, 'grace', (health) => { health.grace.licenseState = licenseState; });
}

for (const [label, offset, expected] of [
  ['just beyond warning window', 30 * day + 1, null],
  ['warning window boundary', 30 * day, 'expiring'],
  ['grant ends tomorrow', day, 'expiring'],
  ['grant expires now', 0, 'expiring'],
  ['already expired grant', -day, 'expiring'],
] as const) {
  check(label, expected, (health) => { health.license.termEndsAt = new Date(now + offset).toISOString(); });
}
check('missing grant term is not guessed from certificate expiry', null, (health) => { health.license.termEndsAt = null; });
check('malformed grant term does not create a warning', null, (health) => { health.license.termEndsAt = 'invalid-date'; });

for (const managedState of ['adoption_required', 'pending', 'error', 'stale', 'never'] as const) {
  check(`Managed sync ${managedState}`, 'sync', (health) => { health.sync.managedState = managedState; });
}
check('Managed sync has never been confirmed', 'sync', (health) => { health.sync.managedState = undefined; });
for (const state of ['stale', 'attention', 'never'] as const) {
  check(`generic sync state ${state}`, 'sync', (health) => { health.sync.state = state; });
}
check('organization scope blocker', 'sync', (health) => { health.sync.blocker = 'TEAM_SEAT_SUBJECT_CONFLICT'; });
check('failed operation', 'sync', (health) => { health.sync.failedOperations = 1; });
check('support required', 'sync', (health) => { health.sync.supportRequired = true; });
check('connection requires recovery', 'sync', (health) => { health.recovery.reconnectRequired = true; });
check('sync error despite old healthy state', 'sync', (health) => { health.sync.lastError = { code: 'SYNC_FAILED', endpoint: '/ack', httpStatus: 503 }; });
check('Community does not use historical Managed sync state', null, (health) => {
  health.mode = 'community';
  health.sync.managedState = 'error';
});
check('queued operations without a fault stay unobtrusive', null, (health) => { health.sync.pendingOperations = 2; });
check('email needs human review', 'email', (health) => { health.emailDelivery!.manualReview = 1; });
check('email retry without manual review stays unobtrusive', null, (health) => { health.emailDelivery!.retryPending = 4; });
check('absent email diagnostics are not an email error', null, (health) => { delete health.emailDelivery; });

check('restricted outranks all other issues', 'restricted', (health) => {
  health.managedAccessPolicy = { state: 'restricted', reason: 'grant_expired', graceEndsAt: null };
  health.grace.licenseState = 'grace';
  health.sync.observedQuantity = 10;
  health.license.termEndsAt = new Date(now + day).toISOString();
  health.sync.state = 'attention';
  health.emailDelivery!.manualReview = 1;
});
check('grace outranks capacity and expiry', 'grace', (health) => {
  health.grace.licenseState = 'grace';
  health.sync.observedQuantity = 10;
  health.license.termEndsAt = new Date(now + day).toISOString();
});
check('capacity outranks expiry and sync', 'capacity', (health) => {
  health.sync.observedQuantity = 10;
  health.license.termEndsAt = new Date(now + day).toISOString();
  health.sync.state = 'attention';
});
check('expiry outranks sync and email', 'expiring', (health) => {
  health.license.termEndsAt = new Date(now + day).toISOString();
  health.sync.state = 'attention';
  health.emailDelivery!.manualReview = 1;
});
check('sync outranks email', 'sync', (health) => {
  health.sync.state = 'attention';
  health.emailDelivery!.manualReview = 1;
});

console.info('Team license UI policy: applicability, healthy states, actionable reasons, date boundaries, capacity, and reason precedence passed');
