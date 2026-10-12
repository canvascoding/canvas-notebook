import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, types, type ClientConfig } from 'pg';

import type { SqlConnection } from '../app/lib/db';
import fixtures from '../app/lib/license/fixtures/team-seat-protocol-v1.json';

/**
 * Run explicitly with CANVAS_TEAM_SEAT_REAL_PG_URL and tsx --conditions react-server.
 * Two actual PostgreSQL sessions use a freshly created, owned database. The
 * administrator only creates/drops that database and observes pg_stat_activity.
 * No existing application database, container, server or remote provider is used.
 */
const fixtureTime = Date.parse('2030-01-01T00:00:00.000Z');

function localRecoveryPostgresConfiguration(): { configuration: ClientConfig; url: URL } {
  const configured = process.env.CANVAS_TEAM_SEAT_REAL_PG_URL?.trim();
  assert.ok(configured, 'An explicit local PostgreSQL test URL is required.');
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('The explicit local PostgreSQL test URL is invalid.');
  }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Only local PostgreSQL is allowed.');
  assert.equal(url.port, '55433', 'Only the managed local PostgreSQL port is allowed.');
  assert.equal(url.search, '', 'Connection overrides are not allowed.');
  assert.equal(url.hash, '', 'URL fragments are not allowed.');
  assert.ok(url.username, 'The explicit URL must identify a database user.');
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
      host: url.hostname, port: 55433, user, password, ssl: false,
      connectionTimeoutMillis: 10_000, statement_timeout: 30_000,
      application_name: 'canvas-seat-recovery-test',
      types: {
        getTypeParser: (oid: number, format?: 'text' | 'binary') => oid === types.builtins.INT8 && format !== 'binary'
          ? (value: string) => Number.parseInt(value, 10)
          : types.getTypeParser(oid, format),
      },
    },
  };
}

function recoveryPostgresConnection(client: Client): SqlConnection {
  return {
    get: async (sql, parameters = []) => (await client.query(sql, parameters)).rows[0],
    all: async (sql, parameters = []) => (await client.query(sql, parameters)).rows,
    run: async (sql, parameters = []) => ({ changes: (await client.query(sql, parameters)).rowCount ?? 0 }),
    close: () => undefined,
  };
}

function safeRecoveryPostgresFailure(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown failure';
  const value = error as { name?: unknown; code?: unknown };
  const safe = (entry: unknown) => typeof entry === 'string' && /^[A-Za-z0-9_]+$/.test(entry) ? entry : undefined;
  return [safe(value.name), safe(value.code)].filter(Boolean).join(' / ') || 'unknown failure';
}

function recoveryPostgresBarrier() {
  let release!: () => void;
  let announce!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { announce = resolve; });
  return { release, announce, held, ready };
}

async function main(): Promise<void> {
  let stage = 'validate explicit local PostgreSQL configuration';
  let administrator: Client | undefined;
  const workers: Client[] = [];
  let createdDatabase = false;
  let ownedDataDirectory: string | undefined;
  let closeRuntimeDatabase: (() => Promise<void>) | undefined;
  let failure: unknown;
  const databaseName = `canvas_seat_recovery_${randomUUID().replaceAll('-', '')}`;
  assert.match(databaseName, /^canvas_seat_recovery_[0-9a-f]{32}$/);
  const originalEnvironment: Record<string, string | undefined> = {};
  const isolateEnvironment = (key: string, value: string) => {
    originalEnvironment[key] = process.env[key];
    process.env[key] = value;
  };
  const originalFetch = globalThis.fetch;
  let unexpectedHttpCalls = 0;

  try {
    const { configuration, url } = localRecoveryPostgresConfiguration();
    administrator = new Client({ ...configuration, database: 'postgres' });
    stage = 'connect database administrator';
    await administrator.connect();
    assert.equal((await administrator.query('SELECT current_database() AS name')).rows[0].name, 'postgres');
    stage = 'create owned temporary database';
    await administrator.query(`CREATE DATABASE "${databaseName}"`);
    createdDatabase = true;
    ownedDataDirectory = await mkdtemp(join(tmpdir(), 'canvas-seat-recovery-'));
    url.pathname = `/${databaseName}`;
    isolateEnvironment('DATABASE_URL', url.toString());
    isolateEnvironment('DATA', ownedDataDirectory);
    isolateEnvironment('CANVAS_DATABASE_PROVIDER', 'postgres');
    isolateEnvironment('CANVAS_POSTGRES_VECTOR_ENABLED', 'false');
    isolateEnvironment('CANVAS_DEPLOYMENT_MODE', 'community');
    isolateEnvironment('CANVAS_TEAM_FEATURES_ENABLED', 'true');
    globalThis.fetch = (async () => {
      unexpectedHttpCalls += 1;
      throw new Error('Remote HTTP is forbidden in the isolated PostgreSQL recovery test.');
    }) as typeof fetch;

    // Runtime imports occur only after DATABASE_URL and DATA are isolated.
    stage = 'load isolated application services';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    closeRuntimeDatabase = (await import('../app/lib/db')).closeDatabaseConnections;
    const { seedTeamSeatOrganization } = await import('./team-seat-test-db');
    const { parseTeamSeatPrepareResponse, parseTeamSeatQuoteStatusResponse } = await import('../app/lib/license/team-seat-contract');
    const { adoptActiveTeamMembership, getActiveTeamMembershipProjection } = await import('../app/lib/organization/team-membership');
    const {
      beginDirectMembershipSeatRequote, beginInvitationMembershipActivation, MembershipOrchestratorError,
      recordDirectMembershipSeatPreparation, recordDirectMembershipSeatAuthorizationStatus,
    } = await import('../app/lib/organization/membership-orchestrator');
    const { createTeamMembershipInvitation, acceptTeamMembershipInvitation, revokeTeamMembershipInvitation } = await import('../app/lib/organization/team-invitations');

    stage = 'connect two independent PostgreSQL sessions';
    for (const index of [1, 2]) {
      const worker = new Client({ ...configuration, database: databaseName, application_name: `canvas-seat-recovery-worker-${index}` });
      workers.push(worker);
      await worker.connect();
    }
    const [firstClient, secondClient] = workers;
    const identities = await Promise.all(workers.map(async (client) => (
      await client.query<{ name: string; pid: number }>('SELECT current_database() AS name, pg_backend_pid() AS pid')
    ).rows[0]));
    assert.equal(identities[0].name, databaseName);
    assert.equal(identities[1].name, databaseName);
    assert.notEqual(identities[0].pid, identities[1].pid, 'The workers must use distinct sessions.');
    stage = 'migrate owned temporary database';
    await runPostgresMigrations(firstClient as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const firstDatabase = recoveryPostgresConnection(firstClient);
    const secondDatabase = recoveryPostgresConnection(secondClient);

    async function snapshot(organizationId: string) {
      return {
        memberships: await firstDatabase.all('SELECT * FROM team_memberships WHERE organization_id = $1 ORDER BY id', [organizationId]),
        invitations: await firstDatabase.all('SELECT * FROM team_membership_invitations WHERE organization_id = $1 ORDER BY id', [organizationId]),
        outbox: await firstDatabase.all('SELECT * FROM team_seat_outbox WHERE organization_id = $1 ORDER BY id', [organizationId]),
        events: await firstDatabase.all('SELECT * FROM team_membership_transitions WHERE organization_id = $1 ORDER BY id', [organizationId]),
        sync: await firstDatabase.all('SELECT * FROM team_membership_sync_state WHERE organization_id = $1', [organizationId]),
        projection: await getActiveTeamMembershipProjection(firstDatabase, organizationId),
      };
    }

    for (const recovery of ['refresh', 'cancel'] as const) {
      for (const record of ['prepare', 'authorization_status'] as const) {
        stage = `seed ${recovery}/${record} fixture`;
        const organizationId = `native-recovery-${randomUUID()}`;
        const actorUserId = `owner-${organizationId}`;
        await seedTeamSeatOrganization(firstDatabase, organizationId, fixtureTime);
        await adoptActiveTeamMembership(firstDatabase, { organizationId, userId: actorUserId, role: 'owner', source: 'first_owner', now: fixtureTime });
        const created = await createTeamMembershipInvitation({
          organizationId, actorUserId, email: `native-candidate-${randomUUID()}@example.test`,
          displayName: 'Isolated native recovery candidate', role: 'member', database: firstDatabase, now: fixtureTime + 1,
        });
        const accepted = await acceptTeamMembershipInvitation({ token: created.token, requestId: randomUUID(), database: firstDatabase, now: fixtureTime + 2 });
        const activation = await beginInvitationMembershipActivation({
          organizationId, membershipId: accepted.membership.id, invitationId: created.invitation.id,
          database: firstDatabase, now: fixtureTime + 3,
        });
        const raw = structuredClone(fixtures.positive.seatChange.prepare);
        raw.quote.quoteId = randomUUID();
        raw.quote.quoteHash = `native-recovery-${randomUUID()}`;
        raw.quote.quantityBefore = 1;
        raw.quote.quantityAfter = 2;
        raw.quote.quantityDelta = 1;
        raw.quote.unitAmountCents = 0;
        raw.quote.expiresAt = new Date(fixtureTime + 1_000).toISOString();
        raw.authorization.authorizationId = randomUUID();
        raw.authorization.quoteId = raw.quote.quoteId;
        raw.authorization.quoteHash = raw.quote.quoteHash;
        raw.authorization.quantityBefore = 1;
        raw.authorization.quantityAfter = 2;
        raw.authorization.expiresAt = raw.quote.expiresAt;
        raw.snapshot.revision = activation.prepareOperation.membershipRevision!;
        raw.snapshot.observedQuantity = 1;
        raw.snapshot.licensedQuantity = 1;
        raw.snapshot.approvedQuantity = 4;
        const preparation = parseTeamSeatPrepareResponse(raw);
        const prepared = await recordDirectMembershipSeatPreparation({
          organizationId, membershipId: accepted.membership.id, prepareOperationId: activation.prepareOperation.operationId,
          response: preparation, actorUserId, database: firstDatabase, now: fixtureTime + 4,
        });
        const staleStatus = parseTeamSeatQuoteStatusResponse(preparation);
        const remoteStatus = structuredClone(staleStatus);
        const barrier = recoveryPostgresBarrier();
        let armed = false;
        let held = false;
        let afterRecovery: Awaited<ReturnType<typeof snapshot>> | undefined;
        const recoveryDatabase: SqlConnection = {
          ...firstDatabase,
          run: async (sql, parameters) => {
            if (armed && !held && sql.trim().toUpperCase() === 'COMMIT') {
              held = true;
              afterRecovery = await snapshot(organizationId);
              barrier.announce();
              await barrier.held;
            }
            return firstDatabase.run(sql, parameters);
          },
        };
        const readQuoteStatus = async (quoteId: string, operationId: string) => {
          assert.equal(quoteId, preparation.quote.quoteId);
          assert.equal(operationId, prepared.prepareOperation.operationId);
          return structuredClone(remoteStatus);
        };
        let retirements = 0;
        const revokeQuote = async (quoteId: string, input: { authorizationId: string; quoteHash: string; reason: 'activation_refresh' | 'activation_cancel' }, operationId: string) => {
          assert.equal(quoteId, preparation.quote.quoteId);
          assert.equal(operationId, prepared.prepareOperation.operationId);
          assert.equal(input.authorizationId, preparation.authorization.authorizationId);
          assert.equal(input.quoteHash, preparation.quote.quoteHash);
          assert.equal(input.reason, recovery === 'refresh' ? 'activation_refresh' : 'activation_cancel');
          retirements += 1;
          remoteStatus.quote.status = 'revoked';
          remoteStatus.authorization.status = 'revoked';
          armed = true; // The pre-retirement validation transaction already committed.
          return structuredClone(remoteStatus);
        };
        const settle = (promise: Promise<unknown>) => promise.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const recoveryResult = settle(recovery === 'refresh'
          ? beginDirectMembershipSeatRequote({
            organizationId, membershipId: accepted.membership.id, staleQuoteId: preparation.quote.quoteId,
            actorUserId, database: recoveryDatabase, readQuoteStatus, revokeQuote, now: fixtureTime + 2_000,
          })
          : revokeTeamMembershipInvitation({
            organizationId, invitationId: created.invitation.id, actorUserId,
            database: recoveryDatabase, readQuoteStatus, revokeQuote, now: fixtureTime + 2_000,
          }));
        let recordResult: ReturnType<typeof settle> | undefined;
        let barrierTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          stage = `hold actual ${recovery} transaction before its commit`;
          await Promise.race([
            barrier.ready,
            recoveryResult.then((result) => {
              if (!result.ok) throw result.error;
              throw new Error('Recovery completed without retaining its transaction at the barrier.');
            }),
            new Promise<never>((_, reject) => {
              barrierTimer = setTimeout(() => reject(new Error('Recovery did not reach the commit barrier.')), 10_000);
            }),
          ]);
          if (barrierTimer) clearTimeout(barrierTimer);
          assert.ok(held && afterRecovery);
          stage = `start competing ${record} on the second actual session`;
          recordResult = settle(record === 'prepare'
            ? recordDirectMembershipSeatPreparation({
              organizationId, membershipId: accepted.membership.id, prepareOperationId: prepared.prepareOperation.operationId,
              response: preparation, actorUserId, database: secondDatabase, now: fixtureTime + 2_001,
            })
            : recordDirectMembershipSeatAuthorizationStatus({
              organizationId, membershipId: accepted.membership.id, response: staleStatus,
              actorUserId, database: secondDatabase, now: fixtureTime + 2_001,
            }));
          const deadline = Date.now() + 10_000;
          let lockEvidence: { wait_event_type: string | null; query: string; blockers: number[] } | undefined;
          while (Date.now() < deadline) {
            const observed = (await administrator.query<{
              wait_event_type: string | null; query: string; blockers: number[];
            }>(`SELECT wait_event_type, query, pg_blocking_pids(pid) AS blockers
              FROM pg_stat_activity WHERE pid = $1 AND datname = $2`, [identities[1].pid, databaseName])).rows[0];
            if (observed?.wait_event_type === 'Lock' && observed.blockers.includes(identities[0].pid)) {
              lockEvidence = observed;
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          assert.ok(lockEvidence, 'The record transaction must actually wait for the recovery session.');
          assert.match(lockEvidence.query, /canvas_organization_settings/i, 'Record must wait before reading membership or Prepare state.');
          assert.match(lockEvidence.query, /FOR\s+NO\s+KEY\s+UPDATE/i, 'The wait must use the shared organization lifecycle lock.');
          stage = `commit ${recovery} and reject stale ${record} without mutation`;
          barrier.release();
          const completedRecovery = await recoveryResult;
          if (!completedRecovery.ok) throw completedRecovery.error;
          const completedRecord = await recordResult;
          assert.equal(completedRecord.ok, false, 'A stale record must reject after recovery commits.');
          if (completedRecord.ok) throw new Error('Stale record unexpectedly succeeded.');
          assert.ok(completedRecord.error instanceof MembershipOrchestratorError);
          assert.ok(['MEMBERSHIP_OPERATION_CONFLICT', 'MEMBERSHIP_OPERATION_NOT_FOUND'].includes(completedRecord.error.code));
          assert.deepEqual(await snapshot(organizationId), afterRecovery,
            'The stale record must not change membership, authorization binding, journal, outbox or projection.');
          assert.equal(retirements, 1);
          assert.equal(unexpectedHttpCalls, 0);
          console.log(`Native PostgreSQL recovery barrier passed: ${recovery}/${record}.`);
        } finally {
          if (barrierTimer) clearTimeout(barrierTimer);
          barrier.release();
          await Promise.allSettled([recoveryResult, ...(recordResult ? [recordResult] : [])]);
          await Promise.allSettled(workers.map((client) => client.query('ROLLBACK')));
        }
      }
    }
  } catch (error) {
    failure = error;
    console.error(`PostgreSQL membership recovery test failed at ${stage}: ${safeRecoveryPostgresFailure(error)}.`);
  } finally {
    globalThis.fetch = originalFetch;
    const closed = await Promise.allSettled(workers.map((client) => client.end()));
    const runtimeClosed = closeRuntimeDatabase ? await Promise.allSettled([closeRuntimeDatabase()]) : [];
    for (const result of [...closed, ...runtimeClosed]) {
      if (result.status === 'rejected') failure ??= result.reason;
    }
    if (createdDatabase && administrator) {
      try {
        await administrator.query(`DROP DATABASE "${databaseName}"`);
        assert.equal((await administrator.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])).rowCount, 0);
      } catch (error) {
        failure ??= error;
        console.error(`Owned PostgreSQL recovery database cleanup failed: ${safeRecoveryPostgresFailure(error)}.`);
      }
    }
    if (administrator) {
      try { await administrator.end(); } catch (error) { failure ??= error; }
    }
    if (ownedDataDirectory) {
      try { await rm(ownedDataDirectory, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    }
    for (const [key, original] of Object.entries(originalEnvironment)) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
  if (failure) process.exitCode = 1;
  else console.log('Real PostgreSQL membership recovery passed: four two-session record barriers; owned database removed; zero remote HTTP.');
}

void main();
