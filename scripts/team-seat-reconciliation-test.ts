import assert from 'node:assert/strict';
import {
  classifyTeamSeatReconciliation,
} from '../app/lib/license/team-seat-reconciliation';
import type { TeamMembershipSyncState } from '../app/lib/license/team-seat-outbox';
import type { LicenseStatus } from '../app/lib/license/types';

function state(overrides: Partial<TeamMembershipSyncState> = {}): TeamMembershipSyncState {
  return {
    organizationId: 'reconciliation-test',
    currentObservedQuantity: 2,
    controlPlaneObservedQuantity: 2,
    approvedQuantity: 2,
    billedQuantity: 2,
    licensedQuantity: 2,
    expectedLicensedQuantity: 2,
    driftStatus: 'in_sync',
    billingStatus: 'active',
    reconciliationSeatLimit: null,
    ...overrides,
  } as TeamMembershipSyncState;
}

function license(seatLimit: number): LicenseStatus {
  return {
    licensed: true,
    edition: 'team',
    licenseState: 'active',
    licenseClass: 'commercial',
    seatLimit,
  } as LicenseStatus;
}

const healthy = classifyTeamSeatReconciliation({ state: state(), licenseStatus: license(2) });
assert.equal(healthy.status, 'in_sync');
assert.equal(healthy.action, 'none');
assert.equal(healthy.reason, 'quantities_in_sync');

const overApproved = classifyTeamSeatReconciliation({
  state: state({ currentObservedQuantity: 3, controlPlaneObservedQuantity: 3 }),
  licenseStatus: license(2),
});
assert.equal(overApproved.status, 'approval_required');
assert.equal(overApproved.restrictionSeatLimit, 2);
assert.ok(overApproved.reasons.includes('observed_above_approved'));
assert.ok(overApproved.reasons.includes('licensed_below_observed'));

const staleCertificate = classifyTeamSeatReconciliation({
  state: state({ licensedQuantity: 2, expectedLicensedQuantity: 2 }),
  licenseStatus: license(4),
});
assert.equal(staleCertificate.refreshRequired, true);
assert.equal(staleCertificate.restrictionSeatLimit, 2);
assert.equal(staleCertificate.action, 'refresh_and_restrict');
assert.ok(staleCertificate.reasons.includes('signed_limit_above_control_plane'));

const incomplete = classifyTeamSeatReconciliation({
  state: state({ billedQuantity: null }),
  licenseStatus: license(2),
});
assert.equal(incomplete.status, 'support_required');
assert.equal(incomplete.action, 'contact_support');
assert.deepEqual(incomplete.reasons, ['incomplete_control_plane_quantities']);

const unknownDrift = classifyTeamSeatReconciliation({
  state: state({ driftStatus: 'new-unknown-status' }),
  licenseStatus: license(2),
});
assert.equal(unknownDrift.status, 'support_required');
assert.ok(unknownDrift.reasons.includes('unknown_control_plane_drift_status'));

console.log('team-seat-reconciliation-test: ok');
