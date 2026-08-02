import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  assertSeatActivationCapacity,
  SeatLimitGuardError,
} from '../app/lib/license/seat-limit';
import {
  classifyTeamSeatReconciliation,
  reconcileAcknowledgedTeamSeatSnapshot,
} from '../app/lib/license/team-seat-reconciliation';
import {
  getTeamMembershipSyncState,
} from '../app/lib/license/team-seat-outbox';
import type { LicenseStatus } from '../app/lib/license/types';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-seat-reconciliation-'));
const sqlite = new Database(path.join(tempRoot, 'reconciliation.db'));
sqlite.pragma('foreign_keys = ON');
runMigrations(sqlite);

const connection = {
  get: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).get(...params) : sqlite.prepare(sql).get()
  ),
  run: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).run(...params) : sqlite.prepare(sql).run()
  ),
  all: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).all(...params) : sqlite.prepare(sql).all()
  ),
  close: () => undefined,
};

function teamLicense(seatLimit: number, licenseClass: 'commercial' | 'manual' | 'test' = 'commercial'): LicenseStatus {
  return {
    plan: 'community',
    licensed: true,
    instanceId: 'self_team_seat_reconciliation_test',
    licenseState: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    hostingMode: 'community',
    edition: 'team',
    licenseClass,
    licenseEnvironment: licenseClass === 'test' ? 'test' : 'production',
    seatLimit,
    deploymentMode: 'community',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: {
      multiUser: true,
      teamWorkspace: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    organizationId: 'organization-reconciliation',
    entitlementsVersion: seatLimit + 10,
    expiresAt: '2030-01-01T00:00:00.000Z',
    features: { multiUser: true, teamWorkspace: true },
    quotas: { users: seatLimit },
    source: 'stored',
    refresh: null,
    graceStartedAt: null,
    graceExpiresAt: null,
  };
}

function setAcknowledgedState(input: {
  revision: number;
  observed: number;
  approved: number;
  billed: number;
  licensed: number;
  expectedLicensed?: number;
  driftStatus: string;
  billingStatus?: string;
}): void {
  const now = 10_000 + input.revision;
  sqlite.prepare(`
    INSERT INTO team_membership_sync_state (
      organization_id,
      current_revision,
      current_observed_quantity,
      latest_snapshot_hash,
      latest_snapshot_generated_at,
      acknowledged_revision,
      acknowledged_snapshot_id,
      acknowledged_snapshot_hash,
      acknowledged_at,
      control_plane_protocol_version,
      control_plane_observed_quantity,
      approved_quantity,
      billed_quantity,
      licensed_quantity,
      expected_licensed_quantity,
      entitlements_version,
      billing_status,
      drift_status,
      created_at,
      updated_at
    ) VALUES (
      'organization-reconciliation', ?, ?, ?, ?, ?, ?, ?, ?,
      'canvas-team-seat-protocol-v1', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
    )
    ON CONFLICT(organization_id) DO UPDATE SET
      current_revision = excluded.current_revision,
      current_observed_quantity = excluded.current_observed_quantity,
      latest_snapshot_hash = excluded.latest_snapshot_hash,
      latest_snapshot_generated_at = excluded.latest_snapshot_generated_at,
      acknowledged_revision = excluded.acknowledged_revision,
      acknowledged_snapshot_id = excluded.acknowledged_snapshot_id,
      acknowledged_snapshot_hash = excluded.acknowledged_snapshot_hash,
      acknowledged_at = excluded.acknowledged_at,
      control_plane_protocol_version = excluded.control_plane_protocol_version,
      control_plane_observed_quantity = excluded.control_plane_observed_quantity,
      approved_quantity = excluded.approved_quantity,
      billed_quantity = excluded.billed_quantity,
      licensed_quantity = excluded.licensed_quantity,
      expected_licensed_quantity = excluded.expected_licensed_quantity,
      billing_status = excluded.billing_status,
      drift_status = excluded.drift_status,
      updated_at = excluded.updated_at
  `).run(
    input.revision,
    input.observed,
    `snapshot-hash-${input.revision}`,
    now,
    input.revision,
    `snapshot-${input.revision}`,
    `snapshot-hash-${input.revision}`,
    now,
    input.observed,
    input.approved,
    input.billed,
    input.licensed,
    input.expectedLicensed ?? input.licensed,
    input.billingStatus ?? 'active',
    input.driftStatus,
    now,
    now,
  );
}

function activeMembershipCount(): number {
  return Number((sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM team_memberships
    WHERE organization_id = 'organization-reconciliation'
      AND status = 'active'
  `).get() as { count: number }).count);
}

async function main(): Promise<void> {
  const now = Date.parse('2026-08-01T12:00:00.000Z');
  const users = [
    { id: 'owner-user', role: 'owner', email: 'owner@example.test' },
    { id: 'admin-user', role: 'admin', email: 'admin@example.test' },
    { id: 'member-user', role: 'member', email: 'member@example.test' },
  ];
  for (const [index, user] of users.entries()) {
    sqlite.prepare(`
      INSERT INTO "user" (
        id, name, email, email_verified, role, banned, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 0, ?, ?)
    `).run(user.id, user.id, user.email, user.role === 'owner' ? 'admin' : 'user', now + index, now + index);
  }
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('organization-reconciliation', 'owner-user', 'community-team', 1, ?, ?)
  `).run(now, now);
  for (const [index, user] of users.entries()) {
    sqlite.prepare(`
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role, status,
        can_write_team_workspace, can_create_public_links,
        can_create_team_automations, can_share_plugins_and_skills,
        can_export, can_delete_team_files, can_delete_studio_assets,
        can_manage_backups, can_migrate_database, can_enable_knowledge,
        can_recover_workspaces, created_at, updated_at
      ) VALUES (
        'organization-reconciliation', ?, ?, 'active',
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, ?, ?
      )
    `).run(user.id, user.role, now + index, now + index);
    sqlite.prepare(`
      INSERT INTO team_memberships (
        id, organization_id, candidate_email, user_id, role, status,
        invited_at, accepted_at, activated_at, created_at, updated_at
      ) VALUES (?, 'organization-reconciliation', ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      `membership-${user.id}`,
      user.email,
      user.id,
      user.role,
      now + index,
      now + index,
      now + index,
      now + index,
      now + index,
    );
  }

  setAcknowledgedState({
    revision: 1,
    observed: 3,
    approved: 3,
    billed: 2,
    licensed: 2,
    driftStatus: 'licensed_below_approved',
  });
  const restricted = await reconcileAcknowledgedTeamSeatSnapshot(
    'organization-reconciliation',
    {
      database: connection,
      databaseProvider: 'sqlite',
      licenseStatus: teamLicense(2),
      now: now + 100,
    },
  );
  assert.equal(restricted.decision.status, 'restriction_required');
  assert.equal(restricted.decision.restrictionSeatLimit, 2);
  assert.equal(restricted.refreshOperationId, null);
  assert.equal(restricted.lifecycle?.suspendedMemberships, 1);
  assert.equal(activeMembershipCount(), 2);
  await assert.rejects(
    () => assertSeatActivationCapacity(connection, {
      organizationId: 'organization-reconciliation',
      desiredQuantity: 3,
      signedSeatLimit: 3,
    }),
    (error: unknown) => (
      error instanceof SeatLimitGuardError
      && error.code === 'SEAT_LIMIT_EXCEEDED'
      && error.details.reconciliationSeatLimit === 2
    ),
  );
  assert.equal(
    (sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM team_seat_outbox
      WHERE operation_kind IN ('seat_prepare', 'seat_execute')
    `).get() as { count: number }).count,
    0,
    'drift reconciliation must never prepare or execute an automatic Seat purchase',
  );

  setAcknowledgedState({
    revision: 10,
    observed: 2,
    approved: 3,
    billed: 2,
    licensed: 3,
    driftStatus: 'observed_below_approved',
  });
  const refresh = await reconcileAcknowledgedTeamSeatSnapshot(
    'organization-reconciliation',
    {
      database: connection,
      databaseProvider: 'sqlite',
      licenseStatus: teamLicense(3),
      now: now + 200,
    },
  );
  assert.equal(refresh.decision.status, 'refresh_required');
  assert.equal(refresh.decision.action, 'refresh_license');
  assert.ok(refresh.refreshOperationId);
  assert.equal(
    (sqlite.prepare(`
      SELECT operation_kind
      FROM team_seat_outbox
      WHERE operation_id = ?
    `).get(refresh.refreshOperationId) as { operation_kind: string }).operation_kind,
    'license_refresh',
  );
  const replay = await reconcileAcknowledgedTeamSeatSnapshot(
    'organization-reconciliation',
    {
      database: connection,
      databaseProvider: 'sqlite',
      licenseStatus: teamLicense(3),
      now: now + 201,
    },
  );
  assert.equal(replay.refreshOperationId, refresh.refreshOperationId);
  assert.equal(replay.refreshReplayed, true);

  setAcknowledgedState({
    revision: 11,
    observed: 2,
    approved: 1,
    billed: 1,
    licensed: 2,
    driftStatus: 'licensed_above_approved',
  });
  const unauthorized = await reconcileAcknowledgedTeamSeatSnapshot(
    'organization-reconciliation',
    {
      database: connection,
      databaseProvider: 'sqlite',
      licenseStatus: teamLicense(2),
      now: now + 300,
    },
  );
  assert.equal(unauthorized.decision.status, 'approval_required');
  assert.equal(unauthorized.decision.restrictionSeatLimit, 1);
  assert.ok(unauthorized.refreshOperationId);
  assert.equal(activeMembershipCount(), 1);
  assert.equal(
    (sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM team_seat_outbox
      WHERE operation_kind IN ('seat_prepare', 'seat_execute')
    `).get() as { count: number }).count,
    0,
  );

  const state = await getTeamMembershipSyncState(
    connection,
    'organization-reconciliation',
  );
  assert.equal(state?.reconciliationStatus, 'approval_required');
  assert.equal(state?.reconciliationSupportRequired, true);
  assert.equal(state?.reconciliationSeatLimit, 1);
  const auditRows = sqlite.prepare(`
    SELECT metadata_json
    FROM audit_events
    WHERE source = 'license'
      AND event_type = 'team_seat_reconciliation'
    ORDER BY created_at ASC
  `).all() as Array<{ metadata_json: string }>;
  assert.ok(auditRows.length >= 3);
  assert.ok(auditRows.every((row) => (
    (JSON.parse(row.metadata_json) as { automaticPurchaseAttempted?: boolean })
      .automaticPurchaseAttempted === false
  )));
  assert.doesNotMatch(JSON.stringify(auditRows), /owner@example|admin@example|member@example/u);

  const manualDecision = classifyTeamSeatReconciliation({
    state: {
      ...state!,
      currentObservedQuantity: 2,
      controlPlaneObservedQuantity: 2,
      approvedQuantity: 2,
      billedQuantity: 0,
      licensedQuantity: 2,
      expectedLicensedQuantity: 2,
      billingStatus: 'active',
      driftStatus: 'in_sync',
    },
    licenseStatus: teamLicense(2, 'manual'),
  });
  assert.equal(manualDecision.status, 'in_sync');
  assert.equal(manualDecision.refreshRequired, false);

  const concurrentLocalIncrease = classifyTeamSeatReconciliation({
    state: {
      ...state!,
      currentObservedQuantity: 4,
      controlPlaneObservedQuantity: 2,
      approvedQuantity: 3,
      billedQuantity: 3,
      licensedQuantity: 3,
      expectedLicensedQuantity: 3,
      billingStatus: 'active',
      driftStatus: 'observed_below_approved',
    },
    licenseStatus: teamLicense(3),
  });
  assert.equal(concurrentLocalIncrease.status, 'approval_required');
  assert.equal(concurrentLocalIncrease.restrictionSeatLimit, 3);
  assert.ok(concurrentLocalIncrease.reasons.includes('local_observed_above_approved'));

  const staleSnapshot = classifyTeamSeatReconciliation({
    state: {
      ...state!,
      currentObservedQuantity: 2,
      controlPlaneObservedQuantity: 2,
      approvedQuantity: 2,
      billedQuantity: 2,
      licensedQuantity: 2,
      expectedLicensedQuantity: 2,
      billingStatus: 'active',
      driftStatus: 'stale',
    },
    licenseStatus: teamLicense(2),
  });
  assert.equal(staleSnapshot.status, 'support_required');
  assert.equal(staleSnapshot.action, 'contact_support');
  assert.ok(staleSnapshot.reasons.includes('control_plane_drift_stale'));

  for (const billingStatus of ['past_due', 'canceled']) {
    const nonpayment = classifyTeamSeatReconciliation({
      state: {
        ...state!,
        currentObservedQuantity: 2,
        controlPlaneObservedQuantity: 2,
        approvedQuantity: 2,
        billedQuantity: 2,
        licensedQuantity: 2,
        expectedLicensedQuantity: 2,
        billingStatus,
        driftStatus: 'in_sync',
      },
      licenseStatus: teamLicense(2),
    });
    assert.equal(nonpayment.status, 'refresh_required');
    assert.equal(nonpayment.action, 'refresh_license');
    assert.equal(nonpayment.refreshRequired, true);
    assert.ok(nonpayment.reasons.includes(`billing_${billingStatus}`));
    assert.equal(nonpayment.restrictionSeatLimit, null);
  }

  console.log('team-seat-reconciliation-test: ok');
}

void main()
  .finally(() => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
