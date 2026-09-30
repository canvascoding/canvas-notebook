import 'server-only';

import type {
  CommunityLicenseClaimPublicStatus,
} from './control-plane';
import type {
  TeamSeatSyncDiagnostics,
} from './team-seat-outbox';
import type { TeamSeatHealth, TeamSeatHealthState } from './team-seat-health-types';
import type { LicenseStatus } from './types';
import type { ManagedTeamSyncStatus } from './managed-team-sync-status';

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
  organizationReady: boolean;
}): TeamSeatHealthState {
  const { state, outbox } = input.diagnostics;
  if (!input.organizationReady) return 'attention';
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
  organizationReady?: boolean;
  diagnostics: TeamSeatSyncDiagnostics;
  claim: CommunityLicenseClaimPublicStatus;
  licenseStatus: LicenseStatus;
  now?: number;
  mode?: 'community' | 'managed-team';
  managedStatus?: ManagedTeamSyncStatus | null;
  managedConfigured?: boolean;
}): TeamSeatHealth {
  const now = input.now ?? Date.now();
  const organizationReady = input.organizationReady !== false;
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

  const health: TeamSeatHealth = {
    mode: input.mode ?? 'community',
    organizationId: input.organizationId,
    generatedAt: new Date(now).toISOString(),
    license: licenseSummary(input.licenseStatus),
    claim,
    sync: {
      state: syncHealthState({
        diagnostics: input.diagnostics,
        staleAfterAt,
        now,
        organizationReady,
      }),
      blocker: organizationReady ? null : 'TEAM_SEAT_SUBJECT_CONFLICT',
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
      canSyncSnapshot: claim.state === 'connected' && organizationReady,
      canRefreshLicense: claim.state === 'connected' && organizationReady
        && input.licenseStatus.hostingMode === 'community',
      reconnectRequired: claim.state === 'reconnect_required',
      costConfirmationRequired: false,
    },
  };
  if (input.mode !== 'managed-team') return health;
  const managed = input.managedStatus?.organizationId === input.organizationId
    ? input.managedStatus : null;
  const managedStaleAt = managed?.lastSuccessAt
    ? Math.min(managed.lastSuccessAt + DEFAULT_STALE_WITHOUT_SCHEDULE_MS,
      (managed.nextAttemptAt ?? managed.lastSuccessAt + 60_000) + DEFAULT_STALE_TOLERANCE_MS)
    : null;
  const stale = managedStaleAt !== null && managedStaleAt <= now;
  const managedState = managed?.state === 'current' && stale ? 'stale' : managed?.state ?? 'never';
  health.license.termEndsAt = managed?.termEndsAt ?? null;
  health.managedAccessPolicy = managed?.accessPolicyState ? {
    state: managed.accessPolicyState, reason: managed.accessPolicyReason ?? null,
    graceEndsAt: managed.graceEndsAt ?? null,
  } : null;
  health.claim = {
    state: managedState === 'current' && organizationReady && input.managedConfigured === true
      && input.licenseStatus.licensed ? 'connected' : 'idle',
    connectionExpiresAt: null, reconnectReason: null,
  };
  health.historicalCommunity = {
    pendingOperations: health.sync.pendingOperations,
    failedOperations: health.sync.failedOperations,
  };
  health.sync = {
    ...health.sync,
    state: !organizationReady || input.managedConfigured !== true || !input.licenseStatus.licensed
      || (managed?.accessPolicyState != null && managed.accessPolicyState !== 'active')
      || managedState === 'error' || managedState === 'pending'
      || managedState === 'adoption_required' ? 'attention'
      : managedState === 'stale' ? 'stale' : managedState === 'never' ? 'never' : 'healthy',
    managedState,
    lastAttemptAt: isoTimestamp(managed?.lastAttemptAt ?? null),
    lastError: managed?.lastError ?? null,
    membershipRevision: managed?.membershipRevision ?? null,
    entitlementsVersion: managed?.entitlementsVersion ?? null,
    lastSyncAt: isoTimestamp(managed?.lastSuccessAt ?? null),
    nextReportAt: isoTimestamp(managed?.nextAttemptAt ?? null),
    staleAfterAt: isoTimestamp(managedStaleAt),
    observedQuantity: managed?.observedMemberCount ?? null,
    approvedQuantity: managed?.approvedMemberCount ?? null,
    billedQuantity: null,
    licensedQuantity: input.licenseStatus.seatLimit ?? managed?.seatLimit ?? null,
    reconciliationStatus: managedState === 'current' ? 'in_sync' : managedState,
    reconciliationAction: null, reconciliationReason: managed?.lastError?.code ?? null,
    reconciliationSeatLimit: managed?.seatLimit ?? null,
    supportRequired: managedState === 'error',
    driftStatus: null, pendingOperations: 0, failedOperations: 0, oldestPendingAt: null,
  };
  health.grace.refreshPhase = null;
  health.grace.nextRefreshAt = isoTimestamp(managed?.nextAttemptAt ?? null);
  health.grace.lastRefreshErrorCode = managed?.lastError?.code ?? null;
  health.recovery = {
    canSyncSnapshot: input.managedConfigured === true && organizationReady,
    canRefreshLicense: false, reconnectRequired: false, costConfirmationRequired: false,
  };
  return health;
}
