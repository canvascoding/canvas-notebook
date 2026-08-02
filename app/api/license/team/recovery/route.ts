import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import {
  getCommunityLicenseClaimStatus,
} from '@/app/lib/license/control-plane';
import {
  enqueueTeamSeatOutboxOperation,
  getTeamMembershipSyncState,
} from '@/app/lib/license/team-seat-outbox';
import {
  signalTeamMembershipSnapshotSync,
} from '@/app/lib/license/team-membership-sync-signal';
import {
  isOrganizationBillingApprover,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const RECOVERY_ACTIONS = ['sync_snapshot', 'refresh_license'] as const;
type RecoveryAction = typeof RECOVERY_ACTIONS[number];

function isRecoveryAction(value: unknown): value is RecoveryAction {
  return typeof value === 'string'
    && (RECOVERY_ACTIONS as readonly string[]).includes(value);
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }
  let organization: Awaited<ReturnType<typeof readOrganizationPermissionForUser>>;
  try {
    organization = await readOrganizationPermissionForUser(session.user.id);
  } catch (error) {
    console.error('[license/team/recovery] owner authorization unavailable', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      {
        success: false,
        code: 'TEAM_SEAT_RECOVERY_UNAVAILABLE',
        error: 'Team Seat recovery authorization is temporarily unavailable.',
        retryable: true,
      },
      { status: 503 },
    );
  }
  if (
    !organization.organizationId
    || !isOrganizationBillingApprover(organization.permission)
  ) {
    return NextResponse.json(
      {
        success: false,
        code: 'ORGANIZATION_OWNER_REQUIRED',
        error: 'Only the active organization owner can run Team Seat recovery actions.',
      },
      { status: 403 },
    );
  }

  const limited = rateLimit(request, {
    limit: 12,
    windowMs: 60_000,
    keyPrefix: 'license-team-seat-recovery',
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => ({})) as {
    action?: unknown;
  };
  if (!isRecoveryAction(payload.action)) {
    return NextResponse.json(
      {
        success: false,
        code: 'TEAM_SEAT_RECOVERY_ACTION_INVALID',
        error: 'A supported Team Seat recovery action is required.',
      },
      { status: 400 },
    );
  }

  const now = Date.now();
  const database = await openDb().catch((error) => {
    console.error('[license/team/recovery] database unavailable', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  });
  if (!database) {
    return NextResponse.json(
      {
        success: false,
        code: 'TEAM_SEAT_RECOVERY_UNAVAILABLE',
        error: 'Team Seat recovery is temporarily unavailable.',
        retryable: true,
      },
      { status: 503 },
    );
  }
  try {
    if (payload.action === 'sync_snapshot') {
      const scheduled = signalTeamMembershipSnapshotSync({ forceReport: true });
      if (!scheduled) {
        return NextResponse.json(
          {
            success: false,
            code: 'TEAM_SEAT_SYNC_RUNTIME_UNAVAILABLE',
            error: 'The Team membership sync runtime is not ready.',
            retryable: true,
          },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      await database.run(`
        INSERT INTO audit_events (
          id,
          organization_id,
          user_id,
          source,
          event_type,
          entity_type,
          entity_id,
          action,
          status,
          summary,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, 'license', 'team_seat_recovery', 'organization', ?, ?, 'accepted', ?, ?, ?)
      `, [
        `audit-${randomUUID()}`,
        organization.organizationId,
        session.user.id,
        organization.organizationId,
        'team.seat_recovery.sync_snapshot',
        'A privacy-safe Team membership snapshot sync was requested.',
        JSON.stringify({
          automaticPurchaseAttempted: false,
          costConfirmationRequired: false,
        }),
        now,
      ]);
      return NextResponse.json(
        {
          success: true,
          action: payload.action,
          scheduled: true,
          costConfirmationRequired: false,
        },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const [state, claim] = await Promise.all([
      getTeamMembershipSyncState(database, organization.organizationId),
      getCommunityLicenseClaimStatus(),
    ]);
    if (claim.state !== 'connected') {
      return NextResponse.json(
        {
          success: false,
          code: 'TEAM_SEAT_RECONNECT_REQUIRED',
          error: 'Reconnect this Community instance before refreshing its signed license.',
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (!state?.acknowledgedSnapshotHash || state.acknowledgedRevision < 1) {
      return NextResponse.json(
        {
          success: false,
          code: 'TEAM_SEAT_SNAPSHOT_REQUIRED',
          error: 'A confirmed Team membership snapshot is required before license recovery.',
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const bucket = Math.floor(now / (5 * 60_000));
    const refresh = await enqueueTeamSeatOutboxOperation(database, {
      organizationId: organization.organizationId,
      dedupeKey: [
        'team-seat',
        'license-refresh',
        'owner-recovery',
        organization.organizationId,
        state.acknowledgedRevision,
        bucket,
      ].join(':'),
      operationKind: 'license_refresh',
      operationType: 'reconcile',
      membershipRevision: state.acknowledgedRevision,
      request: {
        protocolVersion: state.controlPlaneProtocolVersion,
        reason: 'owner_recovery',
        snapshotRevision: state.acknowledgedRevision,
        snapshotHash: state.acknowledgedSnapshotHash,
      },
      now,
    });
    await database.run(`
      INSERT INTO audit_events (
        id,
        organization_id,
        user_id,
        source,
        event_type,
        entity_type,
        entity_id,
        action,
        status,
        summary,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, 'license', 'team_seat_recovery', 'organization', ?, ?, 'accepted', ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `, [
      `team-seat-recovery-${refresh.operation.operationId}`,
      organization.organizationId,
      session.user.id,
      organization.organizationId,
      'team.seat_recovery.refresh_license',
      'A signed Team license refresh was queued without changing Seat quantity.',
      JSON.stringify({
        operationId: refresh.operation.operationId,
        replayed: refresh.replayed,
        automaticPurchaseAttempted: false,
        costConfirmationRequired: false,
      }),
      now,
    ]);
    return NextResponse.json(
      {
        success: true,
        action: payload.action,
        scheduled: true,
        replayed: refresh.replayed,
        operationId: refresh.operation.operationId,
        costConfirmationRequired: false,
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[license/team/recovery] recovery action failed', {
      action: payload.action,
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      {
        success: false,
        code: 'TEAM_SEAT_RECOVERY_FAILED',
        error: 'The Team Seat recovery action could not be scheduled.',
        retryable: true,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  } finally {
    await database.close();
  }
}
