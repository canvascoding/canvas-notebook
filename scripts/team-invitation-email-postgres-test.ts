import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type ClientConfig } from 'pg';

import type { SqlConnection } from '../app/lib/db';

/** Explicit local server only. Every write belongs to a newly created database. */
function invitationTestConfiguration(): { configuration: ClientConfig; url: URL } {
  const value = process.env.CANVAS_INVITATION_TEST_DATABASE_URL?.trim();
  if (!value) throw new Error('CANVAS_INVITATION_TEST_DATABASE_URL must be provided explicitly.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('The explicit local PostgreSQL URL is invalid.'); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL is required.');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Only the local PostgreSQL server is allowed.');
  assert.equal(url.port, '55433', 'Only the managed local PostgreSQL port is allowed.');
  assert.equal(url.search, '', 'Connection overrides are not allowed.');
  assert.equal(url.hash, '', 'Connection fragments are not allowed.');
  assert.ok(url.username, 'An explicit database user is required.');
  return { url, configuration: {
    host: url.hostname, port: 55433, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: false, connectionTimeoutMillis: 10_000, statement_timeout: 15_000,
    application_name: 'canvas-invitation-email-test',
  } };
}

function connection(client: Client): SqlConnection {
  return {
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    run: async (sql, params = []) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
    close: () => undefined,
  };
}

function safeFailure(error: unknown): string {
  const record = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : {};
  return [record.name, record.code].filter(value => typeof value === 'string' && /^[A-Za-z0-9_]+$/u.test(value)).join('/') || 'unknown';
}

async function main() {
  let stage = 'validate explicit local URL';
  let admin: Client | undefined;
  const clients: Client[] = [];
  const databaseName = `canvas_invite_email_${randomUUID().replaceAll('-', '')}`;
  assert.match(databaseName, /^canvas_invite_email_[a-f0-9]{32}$/u);
  let createdDatabase = false;
  let dataDirectory: string | undefined;
  let closeRuntimeDatabase: (() => Promise<void>) | undefined;
  let failure: unknown;
  const originalEnvironment: Record<string, string | undefined> = {};
  const override = (key: string, value: string) => {
    originalEnvironment[key] = process.env[key];
    process.env[key] = value;
  };
  try {
    const { configuration, url } = invitationTestConfiguration();
    admin = new Client({ ...configuration, database: 'postgres' });
    stage = 'connect administrator and create owned test database';
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    createdDatabase = true;
    dataDirectory = await mkdtemp(join(tmpdir(), 'canvas-invitation-email-'));
    url.pathname = `/${databaseName}`;
    override('DATABASE_URL', url.toString());
    override('DATA', dataDirectory);
    override('CANVAS_DATABASE_PROVIDER', 'postgres');
    override('CANVAS_POSTGRES_VECTOR_ENABLED', 'false');
    override('CANVAS_DEPLOYMENT_MODE', 'community');
    override('CANVAS_TEAM_FEATURES_ENABLED', 'true');

    stage = 'load modules only after isolation';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const runtime = await import('../app/lib/db');
    closeRuntimeDatabase = runtime.closeDatabaseConnections;
    const { seedTeamSeatOrganization } = await import('./team-seat-test-db');
    const { createTeamMembershipInvitation } = await import('../app/lib/organization/team-invitations');
    const { resendTeamInvitationEmail, TeamInvitationEmailError } = await import('../app/lib/organization/team-invitation-email');
    stage = 'connect two independent test sessions and migrate';
    for (const index of [1, 2]) {
      const client = new Client({ ...configuration, database: databaseName, application_name: `canvas-invitation-email-worker-${index}` });
      clients.push(client);
      await client.connect();
    }
    const identities = await Promise.all(clients.map(async client => (await client.query('SELECT current_database() AS name, pg_backend_pid() AS pid')).rows[0]));
    assert.ok(identities.every(identity => identity.name === databaseName));
    assert.notEqual(identities[0].pid, identities[1].pid, 'Concurrent callers must use distinct PostgreSQL sessions.');
    await runPostgresMigrations(clients[0]);
    const databases = clients.map(connection);
    const organizationId = 'invitation-concurrent-test';
    const actorUserId = `owner-${organizationId}`;
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    await seedTeamSeatOrganization(databases[0], organizationId, now);
    const created = await createTeamMembershipInvitation({ organizationId, actorUserId,
      email: 'concurrent@example.test', displayName: 'Concurrent Invite', role: 'member', database: databases[0], now });
    let smtpCalls = 0;
    let releaseSend: (() => void) | undefined;
    let announceSend: (() => void) | undefined;
    const sendStarted = new Promise<void>(resolve => { announceSend = resolve; });
    const heldSend = new Promise<void>(resolve => { releaseSend = resolve; });
    const requestIds = [randomUUID(), randomUUID()];
    const options = { organizationId, invitationId: created.invitation.id, actorUserId, now,
      publicOrigin: 'http://127.0.0.1:3100',
      resolveDelivery: async () => ({ kind: 'local' as const, fromAddress: 'canvas@example.test' }),
      deliver: async () => { smtpCalls += 1; announceSend!(); await heldSend; return { messageId: 'synthetic-acceptance' }; },
    };
    stage = 'overlap two resend transactions';
    const requests = databases.map((database, index) => resendTeamInvitationEmail({ ...options, database, requestId: requestIds[index] }));
    // Rejection handlers attach immediately; the winner is held after COMMIT
    // so the losing session must observe the persisted sending claim.
    const settledRequests = Promise.allSettled(requests);
    const firstOutcome = Promise.race(requests.map(request => request.then(() => null, error => error)));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await sendStarted;
      const loser = await Promise.race([firstOutcome, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Concurrent claim observation timed out')), 5_000);
      })]);
      assert.ok(loser instanceof TeamInvitationEmailError && loser.code === 'INVITATION_EMAIL_SENDING',
        'The other PostgreSQL transaction must reject before sending or rotating another token.');
      assert.equal(smtpCalls, 1);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseSend!();
    }
    const outcomes = await settledRequests;
    const winnerIndex = outcomes.findIndex(result => result.status === 'fulfilled');
    assert.ok(winnerIndex >= 0);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    const winner = outcomes[winnerIndex];
    assert.ok(winner.status === 'fulfilled');
    assert.ok(winner.value.token);
    const persisted = await databases[0].get('SELECT token_hash FROM team_membership_invitations WHERE id = $1', [created.invitation.id]) as { token_hash: string };
    assert.ok(persisted.token_hash === createHash('sha256').update(winner.value.token!).digest('hex'), 'Only the winning token must be persisted.');
    const attempts = await databases[0].get('SELECT COUNT(*) AS count FROM team_membership_invitation_email_attempts') as { count: number | string };
    assert.equal(Number(attempts.count), 1);
    stage = 'replay winner and check cooldown on other PostgreSQL session';
    const replay = await resendTeamInvitationEmail({ ...options, now: now + 1, database: databases[1 - winnerIndex], requestId: requestIds[winnerIndex] });
    assert.equal(replay.replayed, true);
    assert.equal(replay.token, null);
    assert.equal(smtpCalls, 1);
    await assert.rejects(resendTeamInvitationEmail({ ...options, now: now + 1, database: databases[1 - winnerIndex], requestId: randomUUID() }),
      (error: unknown) => error instanceof TeamInvitationEmailError && error.code === 'INVITATION_EMAIL_COOLDOWN');
    assert.equal(smtpCalls, 1);
  } catch (error) {
    failure = error;
    console.error(`Invitation email PostgreSQL test failed during ${stage}: ${safeFailure(error)}.`);
  } finally {
    const closed = await Promise.allSettled(clients.map(client => client.end()));
    const runtimeClosed = closeRuntimeDatabase ? await Promise.allSettled([closeRuntimeDatabase()]) : [];
    for (const result of [...closed, ...runtimeClosed]) if (result.status === 'rejected') failure ??= result.reason;
    if (createdDatabase && admin) {
      try { await admin.query(`DROP DATABASE "${databaseName}"`); }
      catch (error) { failure ??= error; console.error(`Owned invitation test database cleanup failed: ${safeFailure(error)}.`); }
    }
    if (admin) try { await admin.end(); } catch (error) { failure ??= error; }
    if (dataDirectory) try { await rm(dataDirectory, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    for (const [key, original] of Object.entries(originalEnvironment)) {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
    }
  }
  if (failure) process.exitCode = 1;
  else console.log('Real PostgreSQL invitation resend passed: two sessions, one claim/send/token, UUID replay and cooldown.');
}

void main();
