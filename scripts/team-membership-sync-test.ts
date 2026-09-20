import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { LicenseControlPlaneError } from '../app/lib/license/control-plane';
import {
  getLatestTeamMembershipSnapshotOperation,
  getTeamMembershipSyncState,
  getTeamSeatOutboxOperation,
  teamSeatSnapshotHash,
} from '../app/lib/license/team-seat-outbox';
import { runTeamMembershipSnapshotSyncCycle } from '../app/lib/license/team-membership-sync';
import type {
  TeamSeatSnapshotRequest,
  TeamSeatSnapshotResponse,
} from '../app/lib/license/team-seat-contract';
import type { LicenseStatus } from '../app/lib/license/types';
import { adoptActiveTeamMembership } from '../app/lib/organization/team-membership';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function connectionFor(postgres: PGlite): SqlConnection {
  const postgresSql = (sql: string) => {
    let parameterIndex = 0;
    return sql.replaceAll('?', () => `$${++parameterIndex}`);
  };

  return {
    get: async (sql, params = []) => (await postgres.query(postgresSql(sql), params)).rows[0],
    run: async (sql, params = []) => {
      const result = await postgres.query(postgresSql(sql), params);
      return { changes: result.affectedRows ?? 0 };
    },
    all: async (sql, params = []) => (await postgres.query(postgresSql(sql), params)).rows,
    close: () => undefined,
  };
}

function teamLicenseStatus(seatLimit: number): LicenseStatus {
  return {
    plan: 'community',
    licensed: true,
    instanceId: 'self_team_membership_sync_test',
    licenseState: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    databaseProvider: 'postgres',
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    seatLimit,
    deploymentMode: 'community',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: { multiUser: true, teamWorkspace: true },
    organizationId: 'organization-1',
    entitlementsVersion: seatLimit,
    expiresAt: '2035-01-01T00:00:00.000Z',
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

async function insertUser(
  postgres: PGlite,
  id: string,
  email: string,
  role = 'user',
): Promise<void> {
  await postgres.query(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, created_at, updated_at
    ) VALUES ($1, $1, $2, 1, $3, $4, $4)
  `, [id, email, role, Date.parse('2030-01-01T00:00:00.000Z')]);
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
  const postgres = new PGlite();
  const database = connectionFor(postgres);
  const baseTime = Date.parse('2030-01-01T00:00:00.000Z');

  try {
    await runPostgresMigrations(postgres as unknown as PgQueryable);

    const stableBase = {
      protocolVersion: 'canvas-team-seat-protocol-v1' as const,
      revision: 1,
      observedQuantity: 1,
      roleSummary: { owner: 1, admin: 0, member: 0, external: 0 },
      memberHashes: ['a'.repeat(64)],
      generatedAt: '2030-01-01T00:00:00.000Z',
      notebookVersion: '2030.1.1.0',
    };
    assert.equal(
      teamSeatSnapshotHash(stableBase),
      teamSeatSnapshotHash({
        ...stableBase,
        revision: 99,
        generatedAt: '2030-01-02T00:00:00.000Z',
        notebookVersion: '2030.1.2.0',
      }),
      'the same membership state must keep a stable content hash across reports',
    );

    await insertUser(postgres, 'owner-user', 'owner@example.test', 'admin');
    await postgres.query(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled,
        created_at, updated_at
      ) VALUES ($1, $2, 'team', 1, $3, $3)
    `, ['organization-1', 'owner-user', baseTime]);
    await adoptActiveTeamMembership(database, {
      organizationId: 'organization-1',
      userId: 'owner-user',
      role: 'owner',
      source: 'first_owner',
      seatOperationType: 'reconcile',
      now: baseTime + 100,
    });

    const initialPending = await getLatestTeamMembershipSnapshotOperation(
      database,
      'organization-1',
    );
    assert.ok(initialPending);

    const inactive = await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: async () => {
        throw new Error('Solo licenses must not send Team membership snapshots.');
      },
      licenseStatus: soloLicenseStatus(),
      now: baseTime + 500,
      forceReport: true,
    });
    assert.equal(inactive.organizations, 0);
    assert.equal(inactive.attempted, 0);
    assert.equal(
      (await getLatestTeamMembershipSnapshotOperation(database, 'organization-1'))?.operationId,
      initialPending.operationId,
    );

    const sent: Array<{ request: TeamSeatSnapshotRequest; operationId: string }> = [];
    const sender = async (
      request: TeamSeatSnapshotRequest,
      operationId: string,
    ): Promise<TeamSeatSnapshotResponse> => {
      sent.push({ request, operationId });
      return snapshotResponse(request, operationId, baseTime + 2_000 + sent.length);
    };

    const initial = await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: sender,
      licenseStatus: teamLicenseStatus(1),
      entitlementsVersion: 1,
      now: baseTime + 2_000,
      forceReport: true,
    });
    assert.equal(initial.attempted, 1);
    assert.equal(initial.acknowledged, 1);
    assert.equal(initial.reconciled, 1);
    assert.equal(sent[0].request.revision, 1);
    assert.equal(sent[0].request.observedQuantity, 1);
    assert.doesNotMatch(JSON.stringify(sent[0].request), /owner@example|owner-user/u);

    const firstState = await getTeamMembershipSyncState(database, 'organization-1');
    assert.equal(firstState?.acknowledgedRevision, 1);
    const firstOperation = await getLatestTeamMembershipSnapshotOperation(
      database,
      'organization-1',
    );
    assert.equal(firstOperation?.status, 'succeeded');

    const freshReport = await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: sender,
      licenseStatus: teamLicenseStatus(1),
      entitlementsVersion: 1,
      now: baseTime + 3_000,
      forceReport: true,
    });
    assert.equal(freshReport.generated, 1);
    assert.equal(freshReport.requeued, 0);
    assert.equal(freshReport.acknowledged, 1);
    assert.notEqual(sent[1].operationId, sent[0].operationId);
    assert.equal(sent[1].request.revision, 2);
    assert.equal(sent[1].request.snapshotHash, sent[0].request.snapshotHash);
    assert.notEqual(sent[1].request.generatedAt, sent[0].request.generatedAt);

    await insertUser(postgres, 'member-user', 'member@example.test');
    await adoptActiveTeamMembership(database, {
      organizationId: 'organization-1',
      userId: 'member-user',
      role: 'member',
      source: 'migration',
      seatOperationType: 'reconcile',
      now: baseTime + 4_000,
    });
    const afterChange = await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: sender,
      licenseStatus: teamLicenseStatus(2),
      entitlementsVersion: 2,
      now: baseTime + 4_100,
    });
    assert.equal(afterChange.acknowledged, 1);
    assert.equal(sent[2].request.revision, 3);
    assert.equal(sent[2].request.observedQuantity, 2);
    assert.notEqual(sent[2].request.snapshotHash, sent[1].request.snapshotHash);
    assert.doesNotMatch(
      JSON.stringify(sent[2].request),
      /owner@example|member@example|owner-user|member-user/u,
    );

    let failedOperationId: string | null = null;
    let failedRevision: number | null = null;
    const deferred = await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: async (request, operationId) => {
        failedOperationId = operationId;
        failedRevision = request.revision;
        throw new Error('temporary network failure');
      },
      licenseStatus: teamLicenseStatus(2),
      now: baseTime + 5_000,
      forceReport: true,
    });
    assert.equal(deferred.generated, 1);
    assert.equal(deferred.deferred, 1);
    assert.ok(failedOperationId);
    const retryWait = await getTeamSeatOutboxOperation(database, failedOperationId);
    assert.equal(retryWait?.status, 'retry_wait');
    assert.equal(retryWait?.attemptCount, 1);

    const retry = await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: sender,
      licenseStatus: teamLicenseStatus(2),
      entitlementsVersion: 2,
      now: retryWait?.nextAttemptAt ?? baseTime + 20_000,
    });
    assert.equal(retry.acknowledged, 1);
    assert.equal(sent.at(-1)?.operationId, failedOperationId);
    assert.equal(sent.at(-1)?.request.revision, failedRevision);

    const terminal = await runTeamMembershipSnapshotSyncCycle({
      database,
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
      now: baseTime + 30_000,
      forceReport: true,
    });
    assert.equal(terminal.failed, 1);
    const terminalOperation = await getLatestTeamMembershipSnapshotOperation(
      database,
      'organization-1',
    );
    assert.equal(terminalOperation?.status, 'failed');
    assert.equal((await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: async () => {
        throw new Error('A terminal snapshot must stay dormant without recovery.');
      },
      licenseStatus: teamLicenseStatus(2),
      now: baseTime + 90_000,
    })).attempted, 0);

    const recovered = await runTeamMembershipSnapshotSyncCycle({
      database,
      sendSnapshot: sender,
      licenseStatus: teamLicenseStatus(2),
      entitlementsVersion: 3,
      now: baseTime + 90_001,
      forceReport: true,
    });
    assert.equal(recovered.generated, 1);
    assert.equal(recovered.acknowledged, 1);
    assert.notEqual(sent.at(-1)?.operationId, terminalOperation?.operationId);
    assert.ok(
      (sent.at(-1)?.request.revision ?? 0) > (terminalOperation?.membershipRevision ?? 0),
    );

    console.log('team-membership-sync-test: ok');
  } finally {
    await postgres.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
