import 'server-only';

import { createHash } from 'node:crypto';

import type { SqlConnection } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import type { TeamLicenseLifecycleResult } from './team-license-lifecycle';
import {
  enqueueTeamSeatOutboxOperation,
  getTeamMembershipSyncState,
  type TeamMembershipSyncState,
} from './team-seat-outbox';
import type { LicenseStatus } from './types';

export const TEAM_SEAT_RECONCILIATION_STATUSES = [
  'in_sync',
  'approval_required',
  'refresh_required',
  'restriction_required',
  'support_required',
] as const;

export type TeamSeatReconciliationStatus =
  typeof TEAM_SEAT_RECONCILIATION_STATUSES[number];

export const TEAM_SEAT_RECONCILIATION_ACTIONS = [
  'none',
  'await_owner_approval',
  'refresh_license',
  'restrict_access',
  'refresh_and_restrict',
  'contact_support',
] as const;

export type TeamSeatReconciliationAction =
  typeof TEAM_SEAT_RECONCILIATION_ACTIONS[number];

export type TeamSeatReconciliationDecision = {
  status: TeamSeatReconciliationStatus;
  action: TeamSeatReconciliationAction;
  reason: string;
  reasons: string[];
  refreshRequired: boolean;
  restrictionSeatLimit: number | null;
  supportRequired: boolean;
};

export type TeamSeatReconciliationResult = {
  decision: TeamSeatReconciliationDecision;
  refreshOperationId: string | null;
  refreshReplayed: boolean;
  lifecycle: TeamLicenseLifecycleResult | null;
};

type ReconciliationDatabase = Pick<
  SqlConnection,
  'all' | 'get' | 'run' | 'close'
>;

type TeamSeatReconciliationOptions = {
  database?: ReconciliationDatabase;
  databaseProvider?: DatabaseProvider;
  licenseStatus?: LicenseStatus;
  loadLicenseStatus?: () => Promise<LicenseStatus>;
  applyRestriction?: (
    status: LicenseStatus,
    input: {
      database: ReconciliationDatabase;
      databaseProvider: DatabaseProvider;
      now: number;
    },
  ) => Promise<TeamLicenseLifecycleResult>;
  now?: number;
};

const KNOWN_DRIFT_STATUSES = new Set([
  'pending',
  'in_sync',
  'observed_below_approved',
  'observed_above_approved',
  'licensed_above_approved',
  'licensed_below_approved',
  'stale',
  'error',
]);

const HEALTHY_BILLING_STATUSES = new Set(['active', 'trialing']);

function validQuantity(value: number | null): value is number {
  return Number.isSafeInteger(value) && value !== null && value >= 0;
}

function pushReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function signedSeatLimit(status: LicenseStatus | undefined): number | null {
  return status?.licensed === true
    && status.edition === 'team'
    && (status.licenseState === 'active' || status.licenseState === 'grace')
    && Number.isSafeInteger(status.seatLimit)
    && (status.seatLimit ?? 0) >= 1
    ? status.seatLimit
    : null;
}

export function classifyTeamSeatReconciliation(input: {
  state: TeamMembershipSyncState;
  licenseStatus?: LicenseStatus;
}): TeamSeatReconciliationDecision {
  const { state, licenseStatus } = input;
  const reasons: string[] = [];
  const observed = state.controlPlaneObservedQuantity;
  const approved = state.approvedQuantity;
  const billed = state.billedQuantity;
  const licensed = state.licensedQuantity;
  const expectedLicensed = state.expectedLicensedQuantity;
  const signedLimit = signedSeatLimit(licenseStatus);
  const localObserved = state.currentObservedQuantity;

  if (
    !validQuantity(observed)
    || !validQuantity(approved)
    || !validQuantity(billed)
    || !validQuantity(licensed)
    || !validQuantity(expectedLicensed)
  ) {
    return {
      status: 'support_required',
      action: 'contact_support',
      reason: 'incomplete_control_plane_quantities',
      reasons: ['incomplete_control_plane_quantities'],
      refreshRequired: false,
      restrictionSeatLimit: state.reconciliationSeatLimit,
      supportRequired: true,
    };
  }

  let refreshRequired = false;
  let supportRequired = false;
  let approvalRequired = false;
  let restrictionSeatLimit: number | null = null;
  const restrictTo = (quantity: number, reason: string): void => {
    const safeQuantity = Math.max(1, quantity);
    restrictionSeatLimit = restrictionSeatLimit === null
      ? safeQuantity
      : Math.min(restrictionSeatLimit, safeQuantity);
    pushReason(reasons, reason);
  };
  const requireRefresh = (reason: string, support = true): void => {
    refreshRequired = true;
    supportRequired ||= support;
    pushReason(reasons, reason);
  };

  if (state.currentObservedQuantity !== observed) {
    supportRequired = true;
    pushReason(reasons, 'local_observed_quantity_mismatch');
  }
  if (!state.driftStatus || !KNOWN_DRIFT_STATUSES.has(state.driftStatus)) {
    supportRequired = true;
    pushReason(reasons, 'unknown_control_plane_drift_status');
  } else if (state.driftStatus === 'stale' || state.driftStatus === 'error') {
    supportRequired = true;
    pushReason(reasons, `control_plane_drift_${state.driftStatus}`);
  }

  if (observed > approved) {
    approvalRequired = true;
    restrictTo(Math.min(approved, licensed), 'observed_above_approved');
  }
  if (localObserved !== observed && localObserved > approved) {
    approvalRequired = true;
    restrictTo(Math.min(approved, licensed), 'local_observed_above_approved');
  }
  if (observed > licensed) {
    supportRequired = true;
    restrictTo(licensed, 'licensed_below_observed');
  }
  if (localObserved !== observed && localObserved > licensed) {
    supportRequired = true;
    restrictTo(licensed, 'licensed_below_local_observed');
  }
  if (licensed > approved) {
    supportRequired = true;
    requireRefresh('licensed_above_approved');
    restrictTo(approved, 'licensed_above_approved');
  }
  if (observed < licensed) {
    supportRequired = true;
    pushReason(reasons, 'observed_below_licensed');
  }
  if (expectedLicensed !== licensed) {
    requireRefresh('expected_licensed_mismatch');
  }

  const commercial = licenseStatus?.licenseClass === 'commercial';
  if (commercial && licensed > billed) {
    requireRefresh('commercial_licensed_above_billed');
  }

  if (signedLimit !== null && signedLimit !== licensed) {
    requireRefresh(
      signedLimit > licensed
        ? 'signed_limit_above_control_plane'
        : 'signed_limit_below_control_plane',
    );
    if (signedLimit > licensed) restrictTo(licensed, 'signed_limit_above_control_plane');
  }

  if (
    state.billingStatus
    && !HEALTHY_BILLING_STATUSES.has(state.billingStatus)
  ) {
    requireRefresh(`billing_${state.billingStatus}`);
  }

  const restrictRequired = restrictionSeatLimit !== null
    && Math.max(observed, localObserved) > restrictionSeatLimit;
  if (restrictionSeatLimit !== null && !restrictRequired) {
    // Keep the cap persisted even if current access is already below it.
    pushReason(reasons, 'activation_cap_required');
  }

  let status: TeamSeatReconciliationStatus;
  if (approvalRequired) status = 'approval_required';
  else if (restrictRequired) status = 'restriction_required';
  else if (refreshRequired) status = 'refresh_required';
  else if (supportRequired) status = 'support_required';
  else status = 'in_sync';

  let action: TeamSeatReconciliationAction;
  if (refreshRequired && restrictionSeatLimit !== null) action = 'refresh_and_restrict';
  else if (restrictRequired) action = 'restrict_access';
  else if (refreshRequired) action = 'refresh_license';
  else if (approvalRequired) action = 'await_owner_approval';
  else if (supportRequired) action = 'contact_support';
  else action = 'none';

  return {
    status,
    action,
    reason: reasons.join(',') || 'quantities_in_sync',
    reasons,
    refreshRequired,
    restrictionSeatLimit,
    supportRequired,
  };
}

function reconciliationAuditId(input: {
  organizationId: string;
  revision: number;
  snapshotHash: string | null;
  decision: TeamSeatReconciliationDecision;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return `team-seat-reconciliation-${digest}`;
}

async function rollbackQuietly(
  database: Pick<SqlConnection, 'run'>,
): Promise<void> {
  try {
    await database.run('ROLLBACK');
  } catch {
    // Preserve the original reconciliation error.
  }
}

async function withTransaction<T>(
  database: Pick<SqlConnection, 'run'>,
  provider: DatabaseProvider,
  operation: () => Promise<T>,
): Promise<T> {
  await database.run(provider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = await operation();
    await database.run('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(database);
    throw error;
  }
}

function changesFromRunResult(result: unknown): number {
  if (result && typeof result === 'object' && 'changes' in result) {
    return Number((result as { changes?: unknown }).changes || 0);
  }
  return 0;
}

export async function reconcileAcknowledgedTeamSeatSnapshot(
  organizationId: string,
  options: TeamSeatReconciliationOptions = {},
): Promise<TeamSeatReconciliationResult> {
  const database = options.database ?? await (await import('@/app/lib/db')).openDb();
  const ownsDatabase = options.database === undefined;
  const databaseProvider = options.databaseProvider ?? getDatabaseProvider();
  const now = options.now ?? Date.now();
  try {
    const state = await getTeamMembershipSyncState(database, organizationId);
    if (!state || state.acknowledgedRevision < 1) {
      throw new Error('An acknowledged Team membership snapshot is required for reconciliation.');
    }
    const licenseStatus = options.licenseStatus
      ?? await (options.loadLicenseStatus
        ? options.loadLicenseStatus()
        : (await import('./index')).getLicenseStatus());
    const decision = classifyTeamSeatReconciliation({ state, licenseStatus });

    const refresh = await withTransaction(database, databaseProvider, async () => {
      const updated = await database.run(`
        UPDATE team_membership_sync_state
        SET
          reconciliation_status = ?,
          reconciliation_action = ?,
          reconciliation_reason = ?,
          reconciliation_seat_limit = ?,
          reconciliation_support_required = ?,
          reconciled_at = ?,
          updated_at = ?
        WHERE organization_id = ?
          AND acknowledged_revision = ?
          AND acknowledged_snapshot_hash = ?
      `, [
        decision.status,
        decision.action,
        decision.reason,
        decision.restrictionSeatLimit,
        decision.supportRequired ? 1 : 0,
        now,
        now,
        organizationId,
        state.acknowledgedRevision,
        state.acknowledgedSnapshotHash,
      ]);
      if (changesFromRunResult(updated) !== 1) {
        throw new Error('The Team membership snapshot changed during reconciliation.');
      }

      await database.run(`
        INSERT INTO audit_events (
          id,
          organization_id,
          source,
          event_type,
          entity_type,
          entity_id,
          action,
          status,
          summary,
          metadata_json,
          created_at
        ) VALUES (?, ?, 'license', 'team_seat_reconciliation', 'organization', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `, [
        reconciliationAuditId({
          organizationId,
          revision: state.acknowledgedRevision,
          snapshotHash: state.acknowledgedSnapshotHash,
          decision,
        }),
        organizationId,
        organizationId,
        `team.seat_reconciliation.${decision.action}`,
        decision.status === 'in_sync' ? 'success' : 'attention_required',
        decision.status === 'in_sync'
          ? 'Team Seat quantities are synchronized.'
          : 'Team Seat drift requires a safe local reconciliation action.',
        JSON.stringify({
          protocolVersion: state.controlPlaneProtocolVersion,
          revision: state.acknowledgedRevision,
          snapshotId: state.acknowledgedSnapshotId,
          snapshotHash: state.acknowledgedSnapshotHash,
          observedQuantity: state.controlPlaneObservedQuantity,
          localObservedQuantity: state.currentObservedQuantity,
          approvedQuantity: state.approvedQuantity,
          billedQuantity: state.billedQuantity,
          licensedQuantity: state.licensedQuantity,
          expectedLicensedQuantity: state.expectedLicensedQuantity,
          signedSeatLimit: signedSeatLimit(licenseStatus),
          billingStatus: state.billingStatus,
          controlPlaneDriftStatus: state.driftStatus,
          reconciliationStatus: decision.status,
          reconciliationAction: decision.action,
          reconciliationReasons: decision.reasons,
          restrictionSeatLimit: decision.restrictionSeatLimit,
          supportRequired: decision.supportRequired,
          automaticPurchaseAttempted: false,
        }),
        now,
      ]);

      if (!decision.refreshRequired) return null;
      return enqueueTeamSeatOutboxOperation(database, {
        organizationId,
        dedupeKey: [
          'team-seat',
          'license-refresh',
          'reconciliation',
          organizationId,
          state.acknowledgedRevision,
          state.acknowledgedSnapshotHash,
        ].join(':'),
        operationKind: 'license_refresh',
        operationType: 'reconcile',
        membershipRevision: state.acknowledgedRevision,
        request: {
          protocolVersion: state.controlPlaneProtocolVersion,
          reason: 'team_seat_reconciliation',
          snapshotRevision: state.acknowledgedRevision,
          snapshotHash: state.acknowledgedSnapshotHash,
          driftStatus: state.driftStatus,
        },
        now,
      });
    });

    let lifecycle: TeamLicenseLifecycleResult | null = null;
    if (
      decision.restrictionSeatLimit !== null
      && Math.max(
        state.controlPlaneObservedQuantity ?? 0,
        state.currentObservedQuantity,
      ) > decision.restrictionSeatLimit
    ) {
      lifecycle = options.applyRestriction
        ? await options.applyRestriction(licenseStatus, {
            database,
            databaseProvider,
            now,
          })
        : await (await import('./team-license-lifecycle'))
            .reconcileTeamLicenseLifecycle(licenseStatus, {
              database,
              databaseProvider,
              now: new Date(now),
            });
    }

    return {
      decision,
      refreshOperationId: refresh?.operation.operationId ?? null,
      refreshReplayed: refresh?.replayed ?? false,
      lifecycle,
    };
  } finally {
    if (ownsDatabase) await database.close();
  }
}
