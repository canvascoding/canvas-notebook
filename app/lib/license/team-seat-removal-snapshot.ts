import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { getActiveTeamMembershipProjection } from '@/app/lib/organization/team-membership';
import { LicenseControlPlaneError } from './control-plane';
import { TEAM_SEAT_PROTOCOL_VERSION } from './team-seat-contract';
import { signalTeamMembershipSnapshotSync } from './team-membership-sync-signal';
import {
  getTeamMembershipSyncState,
  TeamSeatOutboxError,
  type TeamSeatOutboxOperation,
} from './team-seat-outbox';

const MAX_REMOVAL_SNAPSHOT_ACK_AGE_MS = 15 * 60_000;

/** Waits for the current persisted snapshot; it never generates a new revision. */
export async function assertMemberSeatRemovalSnapshotReady(
  database: Pick<SqlConnection, 'get' | 'all'>,
  operation: TeamSeatOutboxOperation,
  now = Date.now(),
): Promise<void> {
  if (operation.operationType !== 'member_remove'
    || operation.operationKind !== 'seat_prepare'
    || !operation.membershipId) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'The removal snapshot barrier requires a persisted member removal preparation.',
    );
  }
  let request: unknown;
  try {
    request = JSON.parse(operation.requestJson);
  } catch {
    throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_CONFLICT', 'The removal preparation request is invalid.');
  }
  const value = request && typeof request === 'object' && !Array.isArray(request)
    ? request as Record<string, unknown>
    : null;
  const desiredQuantity = value?.desiredQuantity;
  if (!value
    || value.protocolVersion !== TEAM_SEAT_PROTOCOL_VERSION
    || value.triggerType !== 'member_remove'
    || value.externalReference !== operation.membershipId
    || typeof desiredQuantity !== 'number'
    || !Number.isSafeInteger(desiredQuantity)
    || desiredQuantity < 1
    || !Number.isSafeInteger(now)) {
    throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_CONFLICT', 'The removal preparation request is invalid.');
  }

  const [state, projection] = await Promise.all([
    getTeamMembershipSyncState(database, operation.organizationId),
    getActiveTeamMembershipProjection(database, operation.organizationId),
  ]);
  if (desiredQuantity < projection.observedQuantity) {
    throw new TeamSeatOutboxError(
      'TEAM_SEAT_OUTBOX_CONFLICT',
      'A Seat reduction must not fall below the current active membership count.',
    );
  }

  if (state
    && Number.isSafeInteger(state.currentRevision) && state.currentRevision >= 1
    && state.acknowledgedRevision === state.currentRevision
    && Boolean(state.latestSnapshotHash)
    && state.acknowledgedSnapshotHash === state.latestSnapshotHash
    && state.controlPlaneProtocolVersion === TEAM_SEAT_PROTOCOL_VERSION
    && state.currentObservedQuantity === projection.observedQuantity
    && state.controlPlaneObservedQuantity === projection.observedQuantity
    && projection.observedQuantity >= 1
    && state.acknowledgedAt !== null && Number.isSafeInteger(state.acknowledgedAt)
    && state.acknowledgedAt <= now
    && now - state.acknowledgedAt < MAX_REMOVAL_SNAPSHOT_ACK_AGE_MS
    && state.nextReportAt !== null && Number.isSafeInteger(state.nextReportAt)
    && now < state.nextReportAt) {
    return;
  }

  // The lightweight signal invokes the normal runtime with forceReport=false.
  // Importing the runtime itself would also pull in reconciliation and workers.
  signalTeamMembershipSnapshotSync();
  throw new LicenseControlPlaneError(
    'The current Team membership snapshot must be acknowledged before preparing a Seat reduction.',
    503,
    'TEAM_SEAT_MEMBERSHIP_SYNC_PENDING',
    true,
    2,
    'temporary',
  );
}
