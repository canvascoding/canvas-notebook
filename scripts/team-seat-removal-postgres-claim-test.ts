import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, types, type ClientConfig } from 'pg';

import type { SqlConnection } from '../app/lib/db';
import fixtures from '../app/lib/license/fixtures/team-seat-protocol-v1.json';
import type { TeamSeatPrepareResponse } from '../app/lib/license/team-seat-contract';
import type { TeamSeatOutboxOperation } from '../app/lib/license/team-seat-outbox';
import type { TeamMembership } from '../app/lib/organization/team-membership';

/**
 * Run explicitly with CANVAS_TEAM_SEAT_REAL_PG_URL and tsx --conditions react-server.
 * The managed local PostgreSQL server needs CREATE DATABASE permission. All
 * migration, membership and claim writes belong to a freshly created database.
 * No application server, worker, Control Plane or container is started here.
 */
const now = Date.parse('2030-01-01T00:00:00.000Z');

function localPostgresConfiguration(): { configuration: ClientConfig; url: URL } {
  const configured = process.env.CANVAS_TEAM_SEAT_REAL_PG_URL?.trim();
  assert.ok(configured, 'CANVAS_TEAM_SEAT_REAL_PG_URL must be set explicitly.');
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('The explicit local PostgreSQL URL is invalid.');
  }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'A PostgreSQL URL is required.');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Only local PostgreSQL is allowed.');
  assert.equal(url.port, '55433', 'Only the managed local PostgreSQL port is allowed.');
  assert.equal(url.search, '', 'Connection overrides are not allowed.');
  assert.equal(url.hash, '', 'URL fragments are not allowed.');
  assert.ok(url.username, 'The explicit PostgreSQL URL must identify a database user.');
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error('The explicit local PostgreSQL credentials have invalid encoding.');
  }
  return {
    url,
    configuration: {
      host: url.hostname,
      port: 55433,
      user,
      password,
      ssl: false,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      application_name: 'canvas-seat-removal-claim-test',
      // The application pool uses numeric INT8 values for membership revisions.
      types: {
        getTypeParser: (oid: number, format?: 'text' | 'binary') => {
          if (oid === types.builtins.INT8 && format !== 'binary') {
            return (value: string) => Number.parseInt(value, 10);
          }
          return types.getTypeParser(oid, format);
        },
      },
    },
  };
}

function postgresClaimTestConnection(client: Client): SqlConnection {
  return {
    get: async (sql, parameters = []) => (await client.query(sql, parameters)).rows[0],
    all: async (sql, parameters = []) => (await client.query(sql, parameters)).rows,
    run: async (sql, parameters = []) => ({ changes: (await client.query(sql, parameters)).rowCount ?? 0 }),
    // Only main owns the clients and closes them before dropping its database.
    close: () => undefined,
  };
}

function safePostgresClaimFailure(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown failure';
  const value = error as { name?: unknown; code?: unknown };
  const safe = (entry: unknown) => typeof entry === 'string' && /^[A-Za-z0-9_]+$/.test(entry)
    ? entry
    : undefined;
  return [safe(value.name), safe(value.code)].filter(Boolean).join(' / ') || 'unknown failure';
}

async function main(): Promise<void> {
  let stage = 'validate explicit local PostgreSQL configuration';
  let administrator: Client | undefined;
  const workerClients: Client[] = [];
  let createdDatabase = false;
  let ownedDataDirectory: string | undefined;
  let closeRuntimeDatabase: (() => Promise<void>) | undefined;
  let failure: unknown;
  const databaseName = `canvas_seat_claim_${randomUUID().replaceAll('-', '')}`;
  assert.match(databaseName, /^canvas_seat_claim_[0-9a-f]{32}$/);
  const environmentOverrides: Record<string, string | undefined> = {};
  const setIsolatedEnvironment = (key: string, value: string) => {
    environmentOverrides[key] = process.env[key];
    process.env[key] = value;
  };

  try {
    const { configuration, url } = localPostgresConfiguration();
    administrator = new Client({ ...configuration, database: 'postgres' });
    stage = 'connect database administrator';
    await administrator.connect();
    assert.equal((await administrator.query('SELECT current_database() AS name')).rows[0].name, 'postgres');
    stage = 'create owned temporary database';
    await administrator.query(`CREATE DATABASE "${databaseName}"`);
    createdDatabase = true;

    ownedDataDirectory = await mkdtemp(join(tmpdir(), 'canvas-seat-removal-claim-'));
    url.pathname = `/${databaseName}`;
    setIsolatedEnvironment('DATABASE_URL', url.toString());
    setIsolatedEnvironment('DATA', ownedDataDirectory);
    setIsolatedEnvironment('CANVAS_DATABASE_PROVIDER', 'postgres');
    setIsolatedEnvironment('CANVAS_POSTGRES_VECTOR_ENABLED', 'false');
    setIsolatedEnvironment('CANVAS_DEPLOYMENT_MODE', 'community');
    setIsolatedEnvironment('CANVAS_TEAM_FEATURES_ENABLED', 'true');

    // Import application modules only after DATABASE_URL and DATA are isolated.
    stage = 'load isolated application and fixture helpers';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const databaseModule = await import('../app/lib/db');
    closeRuntimeDatabase = databaseModule.closeDatabaseConnections;
    const { parseTeamSeatPrepareResponse } = await import('../app/lib/license/team-seat-contract');
    const {
      claimDueTeamSeatWorkOperations,
      getTeamSeatOutboxOperation,
      scheduleTeamSeatOutboxRetry,
    } = await import('../app/lib/license/team-seat-outbox');
    const { recordDirectMembershipSeatPreparation } = await import('../app/lib/organization/membership-orchestrator');
    const {
      adoptActiveTeamMembership,
      getActiveTeamMembershipProjection,
      transitionTeamMembership,
    } = await import('../app/lib/organization/team-membership');
    const { ensureOrganizationPermissionRow } = await import('../app/lib/organization/permission-provisioning');
    const { seedTeamSeatOrganization } = await import('./team-seat-test-db');

    stage = 'connect two independent PostgreSQL worker sessions';
    for (const index of [1, 2]) {
      const client = new Client({
        ...configuration,
        database: databaseName,
        application_name: `canvas-seat-removal-worker-${index}`,
      });
      workerClients.push(client);
      await client.connect();
    }
    const [firstClient, secondClient] = workerClients;
    const identities = await Promise.all(workerClients.map(async (client) => (
      await client.query<{ name: string; pid: number }>('SELECT current_database() AS name, pg_backend_pid() AS pid')
    ).rows[0]));
    assert.equal(identities[0].name, databaseName);
    assert.equal(identities[1].name, databaseName);
    assert.notEqual(identities[0].pid, identities[1].pid, 'Workers must use distinct PostgreSQL sessions.');
    stage = 'apply actual application PostgreSQL migrations';
    await runPostgresMigrations(firstClient as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const firstDatabase = postgresClaimTestConnection(firstClient);
    const secondDatabase = postgresClaimTestConnection(secondClient);

    async function seedRemovalOrganization(organizationId: string): Promise<TeamMembership[]> {
      await seedTeamSeatOrganization(firstDatabase, organizationId, now);
      await adoptActiveTeamMembership(firstDatabase, {
        organizationId,
        userId: `owner-${organizationId}`,
        role: 'owner',
        source: 'first_owner',
        now,
      });
      const members: TeamMembership[] = [];
      for (const index of [1, 2, 3]) {
        const userId = `${organizationId}-member-${index}`;
        await firstDatabase.run(`
          INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
          VALUES ($1, $1, $2, 1, 'user', $3, $3)
        `, [userId, `${userId}@example.test`, now]);
        members.push(await adoptActiveTeamMembership(firstDatabase, {
          organizationId,
          userId,
          role: 'member',
          source: 'migration',
          now,
        }));
      }
      assert.equal((await getActiveTeamMembershipProjection(firstDatabase, organizationId)).observedQuantity, 4);
      return members;
    }

    async function queueRemoval(membership: TeamMembership, removedAt: number): Promise<TeamSeatOutboxOperation> {
      await transitionTeamMembership(firstDatabase, {
        organizationId: membership.organizationId,
        membershipId: membership.id,
        expectedStatus: 'active',
        toStatus: 'removed',
        actorUserId: `owner-${membership.organizationId}`,
        source: 'local_admin',
        seatOperationType: 'member_remove',
        enqueueSeatReduction: true,
        now: removedAt,
      });
      const row = await firstDatabase.get(`
        SELECT operation_id FROM team_seat_outbox
        WHERE membership_id = $1 AND operation_type = 'member_remove' AND operation_kind = 'seat_prepare'
        ORDER BY created_at DESC, id DESC LIMIT 1
      `, [membership.id]) as { operation_id: string } | undefined;
      assert.ok(row, 'A membership removal must persist its preparation.');
      const operation = await getTeamSeatOutboxOperation(firstDatabase, row.operation_id);
      assert.ok(operation);
      return operation;
    }

    function removalPreparation(operation: TeamSeatOutboxOperation): TeamSeatPrepareResponse {
      const response = structuredClone(fixtures.positive.seatChange.prepare);
      const request = JSON.parse(operation.requestJson) as { desiredQuantity: number };
      response.quote.quoteId = randomUUID();
      response.quote.quoteHash = `postgres-removal-claim-${operation.operationId}`;
      response.quote.quantityBefore = 4;
      response.quote.quantityAfter = request.desiredQuantity;
      response.quote.quantityDelta = request.desiredQuantity - 4;
      response.quote.unitAmountCents = 0;
      response.authorization.authorizationId = randomUUID();
      response.authorization.quoteId = response.quote.quoteId;
      response.authorization.quoteHash = response.quote.quoteHash;
      response.authorization.quantityBefore = 4;
      response.authorization.quantityAfter = request.desiredQuantity;
      response.snapshot.revision = operation.membershipRevision!;
      response.snapshot.observedQuantity = 2;
      response.snapshot.licensedQuantity = 4;
      response.snapshot.approvedQuantity = 4;
      return parseTeamSeatPrepareResponse(response);
    }

    async function concurrentClaims(claimedAt: number): Promise<TeamSeatOutboxOperation[]> {
      const claims = await Promise.all([
        claimDueTeamSeatWorkOperations(firstDatabase, { now: claimedAt, pendingDelayMs: 0 }),
        claimDueTeamSeatWorkOperations(secondDatabase, { now: claimedAt, pendingDelayMs: 0 }),
      ]);
      return claims.flat();
    }

    stage = 'persist two overlapping membership removals in existing transactions';
    const organizationId = 'postgres-removal-primary';
    const members = await seedRemovalOrganization(organizationId);
    try {
      await firstClient.query('BEGIN');
      await secondClient.query('BEGIN');
      // These actual application writes acquire PostgreSQL's FK KEY SHARE
      // locks on the same organization before either membership transition.
      // The projection lock must serialize transitions without trying to
      // upgrade past another session's unrelated referential-integrity lock.
      await Promise.all([
        ensureOrganizationPermissionRow(firstDatabase, {
          organizationId, userId: members[0].userId!, role: 'member', activateExisting: false, now: now + 1,
        }),
        ensureOrganizationPermissionRow(secondDatabase, {
          organizationId, userId: members[1].userId!, role: 'member', activateExisting: false, now: now + 2,
        }),
      ]);
      await transitionTeamMembership(firstDatabase, {
        organizationId,
        membershipId: members[0].id,
        expectedStatus: 'active',
        toStatus: 'removed',
        actorUserId: `owner-${organizationId}`,
        source: 'local_admin',
        seatOperationType: 'member_remove',
        enqueueSeatReduction: true,
        transactionMode: 'existing',
        // Request time can precede lock acquisition in a different order.
        now: now + 2,
      });

      // Keep the first membership change uncommitted while the second actual
      // transition starts. The second session must wait before reading its
      // active membership projection, rather than calculating another 3.
      const secondTransition = transitionTeamMembership(secondDatabase, {
        organizationId,
        membershipId: members[1].id,
        expectedStatus: 'active',
        toStatus: 'removed',
        actorUserId: `owner-${organizationId}`,
        source: 'local_admin',
        seatOperationType: 'member_remove',
        enqueueSeatReduction: true,
        transactionMode: 'existing',
        now: now + 1,
      }).then(
        (membership) => ({ success: true as const, membership }),
        (error: unknown) => ({ success: false as const, error }),
      );

      stage = 'observe second removal waiting on the first organization row lock';
      const barrierDeadline = Date.now() + 10_000;
      let lockEvidence: { wait_event_type: string | null; query: string; blockers: number[] } | undefined;
      while (Date.now() < barrierDeadline) {
        const observed = (await administrator.query<{
          wait_event_type: string | null; query: string; blockers: number[];
        }>(`
          SELECT wait_event_type, query, pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity
          WHERE pid = $1 AND datname = $2
        `, [identities[1].pid, databaseName])).rows[0];
        if (observed?.wait_event_type === 'Lock' && observed.blockers.includes(identities[0].pid)) {
          lockEvidence = observed;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(lockEvidence, 'The second removal must actually wait for the first PostgreSQL session.');
      assert.match(lockEvidence.query, /canvas_organization_settings/i,
        'The second removal must wait on the organization before calculating its projection.');
      assert.match(lockEvidence.query, /FOR\s+NO\s+KEY\s+UPDATE/i,
        'The observed organization wait must be the transition row lock.');

      stage = 'commit first removal before completing the blocked second removal';
      await firstClient.query('COMMIT');
      const secondResult = await secondTransition;
      if (!secondResult.success) throw secondResult.error;
      assert.equal(secondResult.membership.status, 'removed');
      await secondClient.query('COMMIT');
    } finally {
      // Releasing the first session also unblocks any pending second query on
      // assertion failure; its queued ROLLBACK then closes that transaction.
      await Promise.allSettled([
        firstClient.query('ROLLBACK'),
        secondClient.query('ROLLBACK'),
      ]);
    }

    stage = 'verify committed overlap produces reductions and snapshots of 3 then 2';
    const removalRows = await firstDatabase.all(`
      SELECT operation_id, membership_id, membership_revision, request_json
      FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_type = 'member_remove'
        AND operation_kind = 'seat_prepare'
      ORDER BY membership_revision ASC
    `, [organizationId]) as Array<{
      operation_id: string; membership_id: string; membership_revision: number; request_json: string;
    }>;
    assert.deepEqual(removalRows.map((row) => row.membership_id), [members[0].id, members[1].id]);
    assert.deepEqual(removalRows.map((row) => JSON.parse(row.request_json).desiredQuantity), [3, 2],
      'Overlapping removals must calculate their target from preceding committed memberships.');
    assert.ok(removalRows[1].membership_revision > removalRows[0].membership_revision,
      'The committed removals must have strictly increasing membership revisions.');
    const snapshotRows = await firstDatabase.all(`
      SELECT membership_revision, request_json
      FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_type = 'member_remove'
        AND operation_kind = 'membership_snapshot'
      ORDER BY membership_revision ASC
    `, [organizationId]) as Array<{ membership_revision: number; request_json: string }>;
    assert.deepEqual(snapshotRows.map((row) => row.membership_revision),
      removalRows.map((row) => row.membership_revision));
    assert.deepEqual(snapshotRows.map((row) => JSON.parse(row.request_json).observedQuantity), [3, 2],
      'Persisted snapshots must describe the same committed counts as their removal targets.');
    const firstPrepare = await getTeamSeatOutboxOperation(firstDatabase, removalRows[0].operation_id);
    const secondPrepare = await getTeamSeatOutboxOperation(firstDatabase, removalRows[1].operation_id);
    assert.ok(firstPrepare);
    assert.ok(secondPrepare);
    assert.equal((await getActiveTeamMembershipProjection(firstDatabase, organizationId)).observedQuantity, 2);
    console.log('Overlapping PostgreSQL removals passed: real permission FK locks, compatible organization lock, targets 3/2, snapshots 3/2 and ascending revisions.');

    stage = 'verify deferred first preparation blocks a newer due preparation';
    await scheduleTeamSeatOutboxRetry(firstDatabase, {
      operationId: firstPrepare.operationId,
      errorCode: 'TEAM_SEAT_MEMBERSHIP_SYNC_PENDING',
      error: 'Simulated wait for the first removal snapshot acknowledgement.',
      retryAt: now + 100,
      now: now + 10,
    });
    assert.deepEqual(await concurrentClaims(now + 99), [],
      'A future retry of the earlier membership revision must block a newer due removal.');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, firstPrepare.operationId))?.status, 'retry_wait');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, secondPrepare.operationId))?.status, 'pending');

    stage = 'claim exactly one removal preparation across two workers';
    const claimedPreparations = await concurrentClaims(now + 100);
    assert.equal(claimedPreparations.length, 1, 'Concurrent workers must claim only one removal in the same organization.');
    assert.equal(claimedPreparations[0].operationId, firstPrepare.operationId);
    assert.equal(claimedPreparations[0].operationKind, 'seat_prepare');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, firstPrepare.operationId))?.status, 'processing');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, secondPrepare.operationId))?.status, 'pending');

    stage = 'persist complete approved removal preparation';
    const prepared = await recordDirectMembershipSeatPreparation({
      organizationId,
      membershipId: members[0].id,
      prepareOperationId: firstPrepare.operationId,
      response: removalPreparation(firstPrepare),
      database: firstDatabase,
      now: now + 110,
    });
    assert.ok(prepared.executeOperation);
    assert.equal(prepared.stage, 'seat_execute_pending');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, firstPrepare.operationId))?.status, 'succeeded');

    stage = 'claim exactly one removal execution before the next preparation';
    const claimedExecutions = await concurrentClaims(now + 120);
    assert.equal(claimedExecutions.length, 1, 'The approved removal execution must be claimed once across workers.');
    assert.equal(claimedExecutions[0].operationId, prepared.executeOperation.operationId);
    assert.equal(claimedExecutions[0].operationKind, 'seat_execute');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, secondPrepare.operationId))?.status, 'pending');

    stage = 'verify deferred execution blocks further preparation';
    const retryAt = now + 10_000;
    await scheduleTeamSeatOutboxRetry(firstDatabase, {
      operationId: prepared.executeOperation.operationId,
      errorCode: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
      error: 'Simulated retry in the isolated PostgreSQL claim test.',
      retryAt,
      now: now + 130,
    });
    assert.deepEqual(await concurrentClaims(now + 140), [], 'A removal retry that is not due must block both workers from preparing another removal.');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, secondPrepare.operationId))?.status, 'pending');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, prepared.executeOperation.operationId))?.status, 'retry_wait');

    stage = 'verify another organization can progress while the first is deferred';
    const otherMembers = await seedRemovalOrganization('postgres-removal-other');
    const otherPrepare = await queueRemoval(otherMembers[0], now + 150);
    const otherClaims = await concurrentClaims(now + 160);
    assert.equal(otherClaims.length, 1, 'A different organization must retain independent worker progress.');
    assert.equal(otherClaims[0].operationId, otherPrepare.operationId);
    assert.equal(otherClaims[0].operationKind, 'seat_prepare');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, secondPrepare.operationId))?.status, 'pending');

    stage = 'verify the due execution resumes once before another preparation';
    const resumed = await concurrentClaims(retryAt);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].operationId, prepared.executeOperation.operationId);
    assert.equal(resumed[0].operationKind, 'seat_execute');
    assert.equal((await getTeamSeatOutboxOperation(secondDatabase, secondPrepare.operationId))?.status, 'pending');
  } catch (error) {
    failure = error;
    console.error(`PostgreSQL removal claim test failed at ${stage}: ${safePostgresClaimFailure(error)}.`);
  } finally {
    // Even failures during connection setup close both owned sessions first.
    const connections = await Promise.allSettled(workerClients.map((client) => client.end()));
    const runtimeClosed = closeRuntimeDatabase
      ? await Promise.allSettled([closeRuntimeDatabase()])
      : [];
    for (const result of [...connections, ...runtimeClosed]) {
      if (result.status === 'rejected') {
        failure ??= result.reason;
        console.error(`PostgreSQL removal claim test connection cleanup failed: ${safePostgresClaimFailure(result.reason)}.`);
      }
    }
    if (createdDatabase && administrator) {
      try {
        // The generated identifier was validated before CREATE and is never
        // derived from any supplied database name. No FORCE termination occurs.
        await administrator.query(`DROP DATABASE "${databaseName}"`);
      } catch (error) {
        failure ??= error;
        console.error(`Owned PostgreSQL removal test database cleanup failed: ${safePostgresClaimFailure(error)}.`);
      }
    }
    if (administrator) {
      try {
        await administrator.end();
      } catch (error) {
        failure ??= error;
        console.error(`PostgreSQL removal test administrator cleanup failed: ${safePostgresClaimFailure(error)}.`);
      }
    }
    if (ownedDataDirectory) {
      try {
        await rm(ownedDataDirectory, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
        console.error(`Owned PostgreSQL removal test data cleanup failed: ${safePostgresClaimFailure(error)}.`);
      }
    }
    for (const [key, original] of Object.entries(environmentOverrides)) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
  if (failure) process.exitCode = 1;
  else console.log('Real PostgreSQL removal claims passed: two independent workers, serialized preparation/execution, deferred execution barrier and independent organizations.');
}

void main();
