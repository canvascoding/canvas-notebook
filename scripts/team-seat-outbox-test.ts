import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  enqueueTeamSeatOutboxOperation,
  getTeamMembershipSyncState,
  getTeamSeatOutboxOperation,
  readTeamSeatSyncDiagnostics,
  recordTeamSeatSnapshotAcknowledgement,
  scheduleTeamSeatOutboxRetry,
  teamSeatSnapshotHash,
  TeamSeatOutboxError,
  type TeamSeatOutboxOperation,
} from '../app/lib/license/team-seat-outbox';
import {
  adoptActiveTeamMembership,
  createTeamMembershipCandidate,
  transitionTeamMembership,
} from '../app/lib/organization/team-membership';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-seat-outbox-'));
const sqlitePath = path.join(tempRoot, 'sqlite.db');
let sqlite = new Database(sqlitePath);
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
};

function insertUser(id: string, email: string, role = 'user'): void {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 1000, 1000)
  `).run(id, id, email, role);
}

function snapshotResponse(operation: TeamSeatOutboxOperation, input: {
  observedQuantity: number;
  billedQuantity: number;
  licensedQuantity: number;
  approvedQuantity: number;
}) {
  const request = JSON.parse(operation.requestJson) as Record<string, unknown>;
  return {
    snapshot: {
      ...request,
      snapshotId: `control-plane-${operation.membershipRevision}`,
      receivedAt: '2026-08-01T10:00:00.000Z',
      reconciledAt: '2026-08-01T10:00:00.000Z',
      driftStatus: 'in_sync',
    },
    observedQuantity: input.observedQuantity,
    billedQuantity: input.billedQuantity,
    licensedQuantity: input.licensedQuantity,
    expectedLicensedQuantity: input.licensedQuantity,
    approvedQuantity: input.approvedQuantity,
    billingStatus: 'active',
    nextReportAt: '2026-08-01T10:05:00.000Z',
    replayed: false,
  };
}

async function main(): Promise<void> {
  insertUser('owner-user', 'owner@example.test', 'admin');
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('organization-1', 'owner-user', 'team', 1, 1000, 1000)
  `).run();

  const owner = await adoptActiveTeamMembership(connection, {
    organizationId: 'organization-1',
    userId: 'owner-user',
    role: 'owner',
    source: 'first_owner',
    seatOperationType: 'reconcile',
    now: 1_100,
    databaseProvider: 'sqlite',
  });

  let state = await getTeamMembershipSyncState(connection, 'organization-1');
  assert.equal(state?.currentRevision, 1);
  assert.equal(state?.currentObservedQuantity, 1);

  const candidate = await createTeamMembershipCandidate(connection, {
    organizationId: 'organization-1',
    email: 'member@example.test',
    invitedByUserId: 'owner-user',
    externalInvitationId: 'invitation-1',
    source: 'invitation',
    now: 1_200,
    databaseProvider: 'sqlite',
  });
  await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'invited',
    toStatus: 'approval_required',
    acceptedAt: 1_300,
    actorUserId: 'owner-user',
    source: 'invitation',
    now: 1_300,
    databaseProvider: 'sqlite',
  });
  await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'approval_required',
    toStatus: 'billing_pending',
    actorUserId: 'owner-user',
    source: 'control_plane',
    now: 1_400,
    databaseProvider: 'sqlite',
  });

  state = await getTeamMembershipSyncState(connection, 'organization-1');
  assert.equal(state?.currentRevision, 1, 'pending-only transitions must not consume a billable revision');

  insertUser('member-user', 'member@example.test');
  await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'billing_pending',
    toStatus: 'active',
    userId: 'member-user',
    actorUserId: 'owner-user',
    source: 'control_plane',
    seatOperationType: 'invitation_accept',
    now: 1_500,
    databaseProvider: 'sqlite',
  });

  state = await getTeamMembershipSyncState(connection, 'organization-1');
  assert.equal(state?.currentRevision, 2);
  assert.equal(state?.currentObservedQuantity, 2);

  await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'active',
    toStatus: 'suspended',
    actorUserId: 'owner-user',
    source: 'local_admin',
    seatOperationType: 'member_remove',
    now: 1_600,
    databaseProvider: 'sqlite',
  });

  state = await getTeamMembershipSyncState(connection, 'organization-1');
  assert.equal(state?.currentRevision, 3);
  assert.equal(state?.currentObservedQuantity, 1);

  const pendingCandidate = await createTeamMembershipCandidate(connection, {
    organizationId: 'organization-1',
    email: 'pending@example.test',
    source: 'invitation',
    now: 1_700,
    databaseProvider: 'sqlite',
  });
  await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: pendingCandidate.id,
    expectedStatus: 'invited',
    toStatus: 'approval_required',
    acceptedAt: 1_750,
    source: 'invitation',
    now: 1_750,
    databaseProvider: 'sqlite',
  });
  assert.equal(
    (await getTeamMembershipSyncState(connection, 'organization-1'))?.currentRevision,
    3,
  );

  const transitionRevisions = sqlite.prepare(`
    SELECT membership_id, to_status, membership_revision
    FROM team_membership_transitions
    WHERE membership_revision IS NOT NULL
    ORDER BY membership_revision ASC
  `).all() as Array<{
    membership_id: string;
    to_status: string;
    membership_revision: number;
  }>;
  assert.deepEqual(
    transitionRevisions.map((transition) => transition.membership_revision),
    [1, 2, 3],
    'each active-seat projection change must allocate exactly one revision',
  );
  assert.deepEqual(
    transitionRevisions.map((transition) => transition.to_status),
    ['active', 'active', 'suspended'],
  );

  const outboxRows = sqlite.prepare(`
    SELECT operation_id
    FROM team_seat_outbox
    WHERE operation_kind = 'membership_snapshot'
    ORDER BY membership_revision ASC
  `).all() as Array<{ operation_id: string }>;
  assert.equal(outboxRows.length, 3);
  assert.equal(new Set(outboxRows.map((row) => row.operation_id)).size, 3);
  assert.ok(outboxRows.every((row) => /^[0-9a-f-]{36}$/u.test(row.operation_id)));

  const latestOperation = await getTeamSeatOutboxOperation(connection, outboxRows[2].operation_id);
  assert.ok(latestOperation);
  assert.equal(latestOperation.membershipRevision, 3);
  assert.doesNotMatch(latestOperation.requestJson, /owner@example|member@example|owner-user|member-user/u);
  const latestRequest = JSON.parse(latestOperation.requestJson) as {
    snapshotHash: string;
    protocolVersion: 'canvas-team-seat-protocol-v1';
    revision: number;
    observedQuantity: number;
    roleSummary: Record<string, number>;
    memberHashes: string[];
    generatedAt: string;
    notebookVersion?: string | null;
  };
  const { snapshotHash, ...snapshotWithoutHash } = latestRequest;
  assert.equal(teamSeatSnapshotHash(snapshotWithoutHash), snapshotHash);
  assert.equal(latestRequest.memberHashes.length, latestRequest.observedQuantity);
  assert.ok(latestRequest.memberHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)));

  const retry = await scheduleTeamSeatOutboxRetry(connection, {
    operationId: latestOperation.operationId,
    errorCode: 'CONTROL_PLANE_UNAVAILABLE',
    error: 'temporary network failure',
    retryAt: 3_000,
    now: 2_000,
  });
  assert.equal(retry.operationId, latestOperation.operationId);
  assert.equal(retry.status, 'retry_wait');
  assert.equal(retry.attemptCount, 1);

  sqlite.close();
  sqlite = new Database(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  runMigrations(sqlite);

  const afterRestart = await getTeamSeatOutboxOperation(connection, latestOperation.operationId);
  assert.ok(afterRestart);
  assert.equal(afterRestart.operationId, latestOperation.operationId);
  assert.equal(afterRestart.attemptCount, 1);
  assert.equal(afterRestart.status, 'retry_wait');

  const secondRetry = await scheduleTeamSeatOutboxRetry(connection, {
    operationId: latestOperation.operationId,
    errorCode: 'CONTROL_PLANE_UNAVAILABLE',
    error: 'second temporary failure',
    retryAt: 5_000,
    now: 4_000,
  });
  assert.equal(secondRetry.operationId, latestOperation.operationId);
  assert.equal(secondRetry.attemptCount, 2);

  const acknowledged = await recordTeamSeatSnapshotAcknowledgement(connection, {
    organizationId: 'organization-1',
    operationId: latestOperation.operationId,
    response: snapshotResponse(secondRetry, {
      observedQuantity: 1,
      approvedQuantity: 2,
      billedQuantity: 2,
      licensedQuantity: 2,
    }),
    entitlementsVersion: 9,
    now: 6_000,
    databaseProvider: 'sqlite',
  });
  assert.equal(acknowledged.currentRevision, 3);
  assert.equal(acknowledged.acknowledgedRevision, 3);
  assert.equal(acknowledged.controlPlaneObservedQuantity, 1);
  assert.equal(acknowledged.approvedQuantity, 2);
  assert.equal(acknowledged.billedQuantity, 2);
  assert.equal(acknowledged.licensedQuantity, 2);
  assert.equal(acknowledged.entitlementsVersion, 9);
  assert.equal(acknowledged.controlPlaneProtocolVersion, 'canvas-team-seat-protocol-v1');

  const completed = await getTeamSeatOutboxOperation(connection, latestOperation.operationId);
  assert.equal(completed?.status, 'succeeded');
  assert.equal(completed?.operationId, latestOperation.operationId);
  assert.equal(completed?.attemptCount, 2);

  const firstOperation = await getTeamSeatOutboxOperation(connection, outboxRows[0].operation_id);
  assert.ok(firstOperation);
  await recordTeamSeatSnapshotAcknowledgement(connection, {
    organizationId: 'organization-1',
    operationId: firstOperation.operationId,
    response: snapshotResponse(firstOperation, {
      observedQuantity: 1,
      approvedQuantity: 1,
      billedQuantity: 1,
      licensedQuantity: 1,
    }),
    entitlementsVersion: 1,
    now: 7_000,
    databaseProvider: 'sqlite',
  });
  state = await getTeamMembershipSyncState(connection, 'organization-1');
  assert.equal(state?.acknowledgedRevision, 3, 'a stale acknowledgement must not overwrite newer diagnostics');
  assert.equal(state?.billedQuantity, 2);
  assert.equal(state?.entitlementsVersion, 9);

  const fixedOperationId = '4c87c3c2-6180-4ca6-a797-7f23b0387c2f';
  const firstEnqueue = await enqueueTeamSeatOutboxOperation(connection, {
    organizationId: 'organization-1',
    operationId: fixedOperationId,
    dedupeKey: 'seat-prepare:organization-1:member-2',
    operationKind: 'seat_prepare',
    operationType: 'member_create',
    membershipId: owner.id,
    request: { desiredQuantity: 2 },
    now: 8_000,
  });
  assert.equal(firstEnqueue.replayed, false);
  const replay = await enqueueTeamSeatOutboxOperation(connection, {
    organizationId: 'organization-1',
    operationId: '20a108a3-dd6b-44a9-9ba6-b2e0c0698534',
    dedupeKey: 'seat-prepare:organization-1:member-2',
    operationKind: 'seat_prepare',
    operationType: 'member_create',
    membershipId: owner.id,
    request: { desiredQuantity: 2 },
    now: 8_100,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation.operationId, fixedOperationId);
  await assert.rejects(
    enqueueTeamSeatOutboxOperation(connection, {
      organizationId: 'organization-1',
      dedupeKey: 'seat-prepare:organization-1:member-2',
      operationKind: 'seat_prepare',
      operationType: 'member_create',
      membershipId: owner.id,
      request: { desiredQuantity: 3 },
      now: 8_200,
    }),
    (error: unknown) => (
      error instanceof TeamSeatOutboxError
      && error.code === 'TEAM_SEAT_OUTBOX_CONFLICT'
    ),
  );

  const diagnostics = await readTeamSeatSyncDiagnostics(connection, 'organization-1');
  assert.equal(diagnostics.state?.currentRevision, 3);
  assert.equal(diagnostics.state?.acknowledgedRevision, 3);
  assert.equal(diagnostics.state?.controlPlaneObservedQuantity, 1);
  assert.equal(diagnostics.state?.billedQuantity, 2);
  assert.equal(diagnostics.state?.licensedQuantity, 2);
  assert.equal(diagnostics.outbox.pending, 2);
  assert.equal(diagnostics.outbox.retryWait, 0);
  assert.equal(diagnostics.outbox.failed, 0);

  console.log('team-seat-outbox-test: ok');
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
