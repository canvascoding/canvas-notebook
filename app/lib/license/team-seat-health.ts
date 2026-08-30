import 'server-only';

import type {
  CommunityLicenseClaimPublicStatus,
} from './control-plane';
import type {
  TeamSeatSyncDiagnostics,
} from './team-seat-outbox';
import type { TeamSeatHealth, TeamSeatHealthState } from './team-seat-health-types';
import type { LicenseStatus } from './types';

const DEFAULT_STALE_TOLERANCE_MS = 60_000;
const DEFAULT_STALE_WITHOUT_SCHEDULE_MS = 10 * 60_000;

function isoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function positiveEnvironmentMs(
  name: string,
  fallback: number,
): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function claimSummary(claim: CommunityLicenseClaimPublicStatus): TeamSeatHealth['claim'] {
  if (claim.state === 'connected') {
    return {
      state: claim.state,
      connectionExpiresAt: claim.token.expiresAt,
      reconnectReason: null,
    };
  }
  if (claim.state === 'reconnect_required') {
    return {
      state: claim.state,
      connectionExpiresAt: null,
      reconnectReason: claim.reason,
    };
  }
  return {
    state: claim.state,
    connectionExpiresAt: claim.state === 'authorization_pending'
      ? claim.expiresAt
      : null,
    reconnectReason: null,
  };
}

function licenseSummary(status: LicenseStatus): TeamSeatHealth['license'] {
  const licenseClass = status.licenseClass;
  const nonBillable = licenseClass === 'manual' || licenseClass === 'test';
  return {
    class: licenseClass,
    environment: status.licenseEnvironment,
    seatLimit: status.seatLimit,
    expiresAt: status.expiresAt,
    nonBillable,
    billingMode: licenseClass === 'manual'
      ? 'manual_grant'
      : licenseClass === 'test'
        ? 'test_grant'
        : licenseClass === 'commercial'
          ? 'commercial'
          : 'unlicensed',
  };
}

function syncHealthState(input: {
  diagnostics: TeamSeatSyncDiagnostics;
  staleAfterAt: number | null;
  now: number;
}): TeamSeatHealthState {
  const { state, outbox } = input.diagnostics;
  if (!state?.lastSyncAt) return 'never';
  if (
    state.reconciliationSupportRequired
    || (
      state.reconciliationStatus !== null
      && state.reconciliationStatus !== 'in_sync'
    )
    || outbox.failed > 0
  ) {
    return 'attention';
  }
  if (input.staleAfterAt !== null && input.staleAfterAt <= input.now) {
    return 'stale';
  }
  return 'healthy';
}

export function buildTeamSeatHealth(input: {
  organizationId: string;
  diagnostics: TeamSeatSyncDiagnostics;
  claim: CommunityLicenseClaimPublicStatus;
  licenseStatus: LicenseStatus;
  now?: number;
}): TeamSeatHealth {
  const now = input.now ?? Date.now();
  const state = input.diagnostics.state;
  const scheduledStaleAt = state?.nextReportAt === null || state?.nextReportAt === undefined
    ? null
    : state.nextReportAt + positiveEnvironmentMs(
        'CANVAS_TEAM_MEMBERSHIP_SYNC_STALE_TOLERANCE_MS',
        DEFAULT_STALE_TOLERANCE_MS,
      );
  const fallbackStaleAt = state?.lastSyncAt === null || state?.lastSyncAt === undefined
    ? null
    : state.lastSyncAt + positiveEnvironmentMs(
        'CANVAS_TEAM_MEMBERSHIP_SYNC_STALE_WITHOUT_SCHEDULE_MS',
        DEFAULT_STALE_WITHOUT_SCHEDULE_MS,
      );
  const staleAfterAt = scheduledStaleAt ?? fallbackStaleAt;
  const graceExpiry = input.licenseStatus.graceExpiresAt
    ? Date.parse(input.licenseStatus.graceExpiresAt)
    : Number.NaN;
  const graceRemainingSeconds = Number.isFinite(graceExpiry)
    ? Math.max(0, Math.ceil((graceExpiry - now) / 1_000))
    : null;
  const claim = claimSummary(input.claim);

  return {
    organizationId: input.organizationId,
    generatedAt: new Date(now).toISOString(),
    license: licenseSummary(input.licenseStatus),
    claim,
    sync: {
      state: syncHealthState({
        diagnostics: input.diagnostics,
        staleAfterAt,
        now,
      }),
      observedQuantity: state?.currentObservedQuantity
        ?? state?.controlPlaneObservedQuantity
        ?? null,
      approvedQuantity: state?.approvedQuantity ?? null,
      billedQuantity: state?.billedQuantity ?? null,
      licensedQuantity: input.licenseStatus.seatLimit
        ?? state?.licensedQuantity
        ?? null,
      lastSyncAt: isoTimestamp(state?.lastSyncAt ?? null),
      nextReportAt: isoTimestamp(state?.nextReportAt ?? null),
      staleAfterAt: isoTimestamp(staleAfterAt),
      driftStatus: state?.driftStatus ?? null,
      reconciliationStatus: state?.reconciliationStatus ?? null,
      reconciliationAction: state?.reconciliationAction ?? null,
      reconciliationReason: state?.reconciliationReason ?? null,
      reconciliationSeatLimit: state?.reconciliationSeatLimit ?? null,
      supportRequired: state?.reconciliationSupportRequired ?? false,
      pendingOperations: input.diagnostics.outbox.pending
        + input.diagnostics.outbox.processing
        + input.diagnostics.outbox.retryWait,
      failedOperations: input.diagnostics.outbox.failed,
      oldestPendingAt: isoTimestamp(input.diagnostics.outbox.oldestPendingAt),
    },
    grace: {
      licenseState: input.licenseStatus.licenseState,
      startedAt: input.licenseStatus.graceStartedAt,
      expiresAt: input.licenseStatus.graceExpiresAt,
      remainingSeconds: graceRemainingSeconds,
      refreshPhase: input.licenseStatus.refresh?.phase ?? null,
      nextRefreshAt: input.licenseStatus.refresh?.nextAttemptAt ?? null,
      lastRefreshErrorCode: input.licenseStatus.refresh?.lastErrorCode ?? null,
    },
    recovery: {
      canSyncSnapshot: claim.state === 'connected',
      canRefreshLicense: claim.state === 'connected'
        && input.licenseStatus.hostingMode === 'community',
      reconnectRequired: claim.state === 'reconnect_required',
      costConfirmationRequired: false,
    },
  };
}
