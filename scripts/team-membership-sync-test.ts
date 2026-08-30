import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { LicenseControlPlaneError } from '../app/lib/license/control-plane';
import {
  getLatestTeamMembershipSnapshotOperation,
  getTeamMembershipSyncState,
  getTeamSeatOutboxOperation,
  teamSeatSnapshotHash,
} from '../app/lib/license/team-seat-outbox';
import {
  runTeamMembershipSnapshotSyncCycle,
} from '../app/lib/license/team-membership-sync';
import type {
  TeamSeatSnapshotRequest,
  TeamSeatSnapshotResponse,
} from '../app/lib/license/team-seat-contract';
import type { LicenseStatus } from '../app/lib/license/types';
import {
  adoptActiveTeamMembership,
} from '../app/lib/organization/team-membership';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-membership-sync-'));
const sqlitePath = path.join(tempRoot, 'sync.db');
const sqlite = new Database(sqlitePath);
sqlite.pragma('foreign_keys = ON');
runMigrations(sqlite);

function sqliteSql(sql: string): string {
  return sql.replace(/::[a-zA-Z_][a-zA-Z0-9_]*/g, '');
}

const connection = {
  get: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sqliteSql(sql)).get(...params) : sqlite.prepare(sqliteSql(sql)).get()
  ),
  run: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sqliteSql(sql)).run(...params) : sqlite.prepare(sqliteSql(sql)).run()
  ),
  all: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sqliteSql(sql)).all(...params) : sqlite.prepare(sqliteSql(sql)).all()
  ),
  close: () => undefined,
};

function teamLicenseStatus(seatLimit: number): LicenseStatus {
  return {
    plan: 'community',
    licensed: true,
    instanceId: 'self_team_membership_sync_test',
    licenseState: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    seatLimit,
    deploymentMode: 'community',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: { multiUser: true, teamWorkspace: true },
    organizationId: 'organization-1',
    entitlementsVersion: seatLimit,
    expiresAt: '2030-01-01T00:00:00.000Z',
    features: { multiUser: true, teamWorkspace: true },
    quotas: { users: seatLimit },
    source: 'stored',
    refresh: null,
    graceStartedAt: null,
    graceExpiresAt: null,
  };
}

function soloLicenseStatus(): LicenseStatus {
  return {
    ...teamLicenseStatus(1),
    edition: 'solo',
    capabilities: { multiUser: false, teamWorkspace: false },
    features: { multiUser: false, teamWorkspace: false },
  };
}

function insertUser(id: string, email: string, role = 'user'): void {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 1000, 1000)
  `).run(id, id, email, role);
}

function snapshotResponse(
  request: TeamSeatSnapshotRequest,
  operationId: string,
  now: number,
): TeamSeatSnapshotResponse {
  return {
    snapshot: {
      ...request,
      snapshotId: `control-plane-${operationId}`,
      receivedAt: new Date(now).toISOString(),
      reconciledAt: new Date(now).toISOString(),
      driftStatus: 'in_sync',
    },
    observedQuantity: request.observedQuantity,
    approvedQuantity: request.observedQuantity,
    billedQuantity: request.observedQuantity,
    licensedQuantity: request.observedQuantity,
    expectedLicensedQuantity: request.observedQuantity,
    billingStatus: 'active',
    nextReportAt: new Date(now + 60_000).toISOString(),
    replayed: false,
  };
}

async function main(): Promise<void> {
  const stableBase = {
    protocolVersion: 'canvas-team-seat-protocol-v1' as const,
    revision: 1,
    observedQuantity: 1,
    roleSummary: { owner: 1, admin: 0, member: 0, external: 0 },
    memberHashes: ['a'.repeat(64)],
    generatedAt: '2026-08-01T10:00:00.000Z',
    notebookVersion: '2026.8.1.2',
  };
  assert.equal(
    teamSeatSnapshotHash(stableBase),
    teamSeatSnapshotHash({
      ...stableBase,
      revision: 99,
      generatedAt: '2026-08-02T10:00:00.000Z',
      notebookVersion: '2026.8.2.0',
    }),
    'the same membership state must keep a stable content hash across reports',
  );

  insertUser('owner-user', 'owner@example.test', 'admin');
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('organization-1', 'owner-user', 'team', 1, 1000, 1000)
  `).run();
  await adoptActiveTeamMembership(connection, {
    organizationId: 'organization-1',
    userId: 'owner-user',
    role: 'owner',
    source: 'first_owner',
    seatOperationType: 'reconcile',
    databaseProvider: 'sqlite',
    now: 1_100,
  });
  const snapshotBeforeInactive = await getLatestTeamMembershipSnapshotOperation(
    connection,
    'organization-1',
  );
  assert.ok(snapshotBeforeInactive);

  const inactive = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: async () => {
      throw new Error('Solo licenses must not send Team membership snapshots.');
    },
    licenseStatus: soloLicenseStatus(),
    now: 1_500,
    forceReport: true,
  });
  assert.deepEqual(inactive, {
    organizations: 0,
    generated: 0,
    requeued: 0,
    attempted: 0,
    acknowledged: 0,
    reconciled: 0,
    reconciliationFailed: 0,
    deferred: 0,
    failed: 0,
  });
  const snapshotAfterInactive = await getLatestTeamMembershipSnapshotOperation(
    connection,
    'organization-1',
  );
  assert.equal(snapshotAfterInactive?.operationId, snapshotBeforeInactive.operationId);
  assert.equal(snapshotAfterInactive?.status, 'pending');
  assert.equal(snapshotAfterInactive?.attemptCount, 0);

  const sent: Array<{
    request: TeamSeatSnapshotRequest;
    operationId: string;
  }> = [];
  const sender = async (
    request: TeamSeatSnapshotRequest,
    operationId: string,
  ): Promise<TeamSeatSnapshotResponse> => {
    sent.push({ request, operationId });
    return snapshotResponse(request, operationId, 2_000 + sent.length);
  };

  const initial = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: sender,
    licenseStatus: teamLicenseStatus(1),
    entitlementsVersion: 1,
    now: 2_000,
    forceReport: true,
  });
  assert.equal(initial.organizations, 1);
  assert.equal(initial.attempted, 1);
  assert.equal(initial.acknowledged, 1);
  assert.equal(initial.reconciled, 1);
  assert.equal(initial.reconciliationFailed, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.revision, 1);
  assert.equal(sent[0].request.observedQuantity, 1);
  assert.doesNotMatch(
    JSON.stringify(sent[0].request),
    /owner@example|owner-user/u,
  );
  assert.ok(sent[0].request.memberHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)));

  const firstState = await getTeamMembershipSyncState(connection, 'organization-1');
  assert.equal(firstState?.acknowledgedRevision, 1);
  assert.equal(firstState?.entitlementsVersion, 1);
  const firstOperation = await getLatestTeamMembershipSnapshotOperation(
    connection,
    'organization-1',
  );
  assert.ok(firstOperation);
  assert.equal(firstOperation.status, 'succeeded');

  const startupReplay = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: sender,
    licenseStatus: teamLicenseStatus(1),
    entitlementsVersion: 1,
    now: 3_000,
    forceReport: true,
  });
  assert.equal(startupReplay.requeued, 1);
  assert.equal(startupReplay.acknowledged, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].operationId, sent[0].operationId);
  assert.equal(sent[1].request.revision, sent[0].request.revision);
  assert.equal(sent[1].request.snapshotHash, sent[0].request.snapshotHash);

  insertUser('member-user', 'member@example.test');
  await adoptActiveTeamMembership(connection, {
    organizationId: 'organization-1',
    userId: 'member-user',
    role: 'member',
    source: 'migration',
    seatOperationType: 'reconcile',
    databaseProvider: 'sqlite',
    now: 4_000,
  });
  const afterChange = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: sender,
    licenseStatus: teamLicenseStatus(2),
    entitlementsVersion: 2,
    now: 4_100,
  });
  assert.equal(afterChange.attempted, 1);
  assert.equal(afterChange.acknowledged, 1);
  assert.equal(afterChange.reconciled, 1);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].request.revision, 2);
  assert.equal(sent[2].request.observedQuantity, 2);
  assert.notEqual(sent[2].request.snapshotHash, sent[1].request.snapshotHash);
  assert.doesNotMatch(
    JSON.stringify(sent[2].request),
    /owner@example|member@example|owner-user|member-user/u,
  );

  let failedOperationId: string | null = null;
  const deferred = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: async (_request, operationId) => {
      failedOperationId = operationId;
      throw new Error('temporary network failure');
    },
    licenseStatus: teamLicenseStatus(2),
    now: 5_000,
    forceReport: true,
  });
  assert.equal(deferred.requeued, 1);
  assert.equal(deferred.deferred, 1);
  assert.ok(failedOperationId);
  const retryWait = await getTeamSeatOutboxOperation(connection, failedOperationId);
  assert.equal(retryWait?.status, 'retry_wait');
  assert.equal(retryWait?.attemptCount, 1);
  assert.equal(retryWait?.nextAttemptAt, 20_000);

  const retry = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: sender,
    licenseStatus: teamLicenseStatus(2),
    entitlementsVersion: 2,
    now: 20_000,
  });
  assert.equal(retry.attempted, 1);
  assert.equal(retry.acknowledged, 1);
  assert.equal(sent.at(-1)?.operationId, failedOperationId);

  const terminal = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: async () => {
      throw new LicenseControlPlaneError(
        'The instance token is no longer valid.',
        401,
        'TEAM_SEAT_TOKEN_INVALID',
        false,
        null,
        'authentication',
      );
    },
    licenseStatus: teamLicenseStatus(2),
    now: 30_000,
    forceReport: true,
  });
  assert.equal(terminal.failed, 1);
  const terminalOperation = await getLatestTeamMembershipSnapshotOperation(
    connection,
    'organization-1',
  );
  assert.equal(terminalOperation?.status, 'failed');
  assert.equal((await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: async () => {
      throw new Error('A terminal snapshot must stay dormant without an explicit recovery signal.');
    },
    licenseStatus: teamLicenseStatus(2),
    now: 90_000,
  })).attempted, 0);

  const connectionRecovered = await runTeamMembershipSnapshotSyncCycle({
    database: connection,
    databaseProvider: 'sqlite',
    sendSnapshot: sender,
    licenseStatus: teamLicenseStatus(2),
    entitlementsVersion: 3,
    now: 90_001,
    forceReport: true,
  });
  assert.equal(connectionRecovered.requeued, 1);
  assert.equal(connectionRecovered.acknowledged, 1);
  assert.equal(sent.at(-1)?.operationId, terminalOperation?.operationId);

  const instrumentationSource = readFileSync(
    path.join(process.cwd(), 'instrumentation.ts'),
    'utf8',
  );
  assert.match(
    instrumentationSource,
    /initializeTeamMembershipSnapshotSyncRuntime/u,
  );

  console.log('team-membership-sync-test: ok');
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
