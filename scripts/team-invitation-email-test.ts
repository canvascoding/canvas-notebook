import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { SqlConnection } from '../app/lib/db';
import { SystemSmtpDeliveryUnknownError } from '../app/lib/email/system-smtp-service';
import { ManagedSystemEmailHttpError } from '../app/lib/email/managed-system-email-client';
import {
  listTeamInvitationEmailDeliveries,
  resendTeamInvitationEmail,
  sendCreatedTeamInvitationEmail,
  TeamInvitationEmailError,
} from '../app/lib/organization/team-invitation-email';
import {
  acceptTeamMembershipInvitation,
  createTeamMembershipInvitation,
  previewTeamMembershipInvitation,
  revokeTeamMembershipInvitation,
  TeamInvitationError,
} from '../app/lib/organization/team-invitations';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';
import { loadIsolatedModule } from './helpers/isolated-source-module';
import * as crypto from 'node:crypto';
import { renderTeamInvitationEmail } from '../app/lib/email/templates/team-invitation';
import { normalizePublicOrigin } from '../app/lib/utils/request-origin';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const organizationId = 'invitation-email-test';
const actorUserId = `owner-${organizationId}`;
const publicOrigin = 'http://127.0.0.1:3100';
const localRoute = async () => ({ kind: 'local' as const, fromAddress: 'canvas@example.test' });

function errorCode(code: string) {
  return (error: unknown) => error instanceof TeamInvitationEmailError && error.code === code;
}

async function count(database: SqlConnection, table: string) {
  const row = await database.get(`SELECT COUNT(*) AS count FROM ${table}`) as { count: string | number };
  return Number(row.count);
}

async function main() {
  await withTeamSeatTestDatabase(async database => {
    await seedTeamSeatOrganization(database, organizationId, now);
    const messages: Array<{ to: string; html: string }> = [];
    const deliver: NonNullable<Parameters<typeof sendCreatedTeamInvitationEmail>[0]['deliver']> = async message => {
      messages.push(message);
      return { messageId: `synthetic-${messages.length}` };
    };
    const options = { database, now, publicOrigin, resolveDelivery: localRoute, deliver };
    let nextEmail = 0;
    const invite = (role: 'admin' | 'member' | 'external' = 'member') => createTeamMembershipInvitation({
      organizationId, actorUserId, email: `invite-${++nextEmail}@example.test`,
      displayName: '<img src=x onerror=alert(1)>', role, database, now,
    });

    for (const role of ['admin', 'member', 'external'] as const) {
      const created = await invite(role);
      assert.equal((await listTeamInvitationEmailDeliveries({ organizationId, database, now }))[created.invitation.id].status, 'not_sent');
      const delivered = await sendCreatedTeamInvitationEmail({ ...options, ...created, actorUserId, locale: 'de' });
      assert.equal(delivered.status, 'sent');
      assert.equal(delivered.deliveryUnknown, false);
      assert.equal(delivered.canResend, false);
      assert.equal(delivered.sentAt, now);
      const message = messages.at(-1)!;
      assert.equal(message.to, created.invitation.email);
      assert.ok(message.html.includes(`${publicOrigin}/invite/team?token=${encodeURIComponent(created.token)}`), 'Email must contain the exact public acceptance link.');
      assert.ok(message.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'Recipient display name must be escaped.');
      assert.ok(!message.html.includes('<img src=x'), 'Recipient name must not become executable HTML.');
      assert.ok(message.html.includes('eigenes Passwort'), 'Invitee must set their own password.');
      assert.ok(!JSON.stringify(delivered).includes(created.token), 'Status must never expose bearer tokens.');
      const before = messages.length;
      let replayProviderReads = 0;
      await sendCreatedTeamInvitationEmail({ ...options, ...created, actorUserId,
        resolveDelivery: async () => { replayProviderReads += 1; throw new Error('Provider must not be read for an initial-send replay'); } });
      assert.equal(messages.length, before, 'Repeated initial delivery must send nothing.');
      assert.equal(replayProviderReads, 0, 'Repeated initial delivery must be independent of provider availability.');
    }
    assert.equal(await count(database, '"user"'), 1, 'Email delivery must not create a user.');
    assert.equal(await count(database, 'team_seat_outbox'), 0, 'Inviting/emailing must not claim or execute a Seat.');
    console.log('Invitation email: all roles, escaped public links, persisted SMTP acceptance and initial-send replay passed.');

    const created = await invite();
    await sendCreatedTeamInvitationEmail({ ...options, ...created, actorUserId });
    const beforeResend = messages.length;
    const requestId = randomUUID();
    const resent = await resendTeamInvitationEmail({ ...options, now: now + 60_000,
      organizationId, invitationId: created.invitation.id, actorUserId, requestId });
    assert.equal(resent.replayed, false);
    assert.ok(resent.token && resent.token !== created.token, 'Explicit resend must rotate the bearer token.');
    assert.equal(messages.length, beforeResend + 1);
    let replayProviderReads = 0;
    const providerIndependentReplay = await resendTeamInvitationEmail({ ...options, now: now + 60_001,
      organizationId, invitationId: created.invitation.id, actorUserId, requestId,
      resolveDelivery: () => { replayProviderReads += 1; return new Promise(() => undefined); } });
    assert.equal(providerIndependentReplay.replayed, true);
    assert.equal(replayProviderReads, 0, 'A stored UUID replay must not contact a stalled provider.');
    assert.equal(resent.invitation.expiresAt, created.invitation.expiresAt, 'Resend must retain the invitation lifetime.');
    assert.equal(resent.invitation.membershipId, created.invitation.membershipId);
    await assert.rejects(previewTeamMembershipInvitation({ token: created.token, database, now: now + 60_001 }),
      (error: unknown) => error instanceof TeamInvitationError && error.code === 'INVITATION_NOT_FOUND');
    assert.equal((await previewTeamMembershipInvitation({ token: resent.token!, database, now: now + 60_001 })).invitation.id, created.invitation.id);
    const replay = await resendTeamInvitationEmail({ ...options, now: now + 60_001,
      organizationId, invitationId: created.invitation.id, actorUserId, requestId });
    assert.equal(replay.replayed, true);
    assert.equal(replay.token, null);
    assert.equal(messages.length, beforeResend + 1);
    await assert.rejects(resendTeamInvitationEmail({ ...options, now: now + 60_001,
      organizationId, invitationId: created.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_EMAIL_COOLDOWN'));
    console.log('Invitation email: explicit resend token rotation, unchanged membership/expiry, UUID replay and cooldown passed.');

    const stalledPreflight = await invite();
    let stalledSmtpCalls = 0;
    const stalledStarted = Date.now();
    const stalled = await sendCreatedTeamInvitationEmail({ ...options, ...stalledPreflight, actorUserId,
      preflightTimeoutMs: 10,
      resolveDelivery: () => new Promise(() => undefined),
      deliver: async () => { stalledSmtpCalls += 1; return { messageId: 'must-not-send' }; } });
    assert.equal(stalled.status, 'failed');
    assert.equal(stalled.errorCode, 'INVITATION_EMAIL_SEND_FAILED');
    assert.equal(stalled.deliveryUnknown, false, 'A preflight timeout is known to precede SMTP delivery.');
    assert.equal(stalledSmtpCalls, 0);
    assert.ok(Date.now() - stalledStarted < 2_000, 'Test-clock preflight must settle within its deadline.');
    console.log('Invitation email: provider-independent replays and bounded preflight timeout settle without SMTP or unknown delivery.');

    const unconfigured = await invite();
    const disabled = await sendCreatedTeamInvitationEmail({ ...options, ...unconfigured, actorUserId,
      resolveDelivery: async () => ({ kind: 'unconfigured', errorCode: 'INVITATION_EMAIL_DISABLED' }) });
    assert.equal(disabled.status, 'unconfigured');
    assert.equal(disabled.errorCode, 'INVITATION_EMAIL_DISABLED');
    const rejected = await invite();
    const leakedProviderText = `smtp-password-must-not-be-persisted:${rejected.token}`;
    const failure = await sendCreatedTeamInvitationEmail({ ...options, ...rejected, actorUserId,
      deliver: async () => { throw new Error(leakedProviderText); } });
    assert.equal(failure.status, 'failed');
    assert.equal(failure.errorCode, 'INVITATION_EMAIL_SEND_FAILED');
    assert.equal(failure.deliveryUnknown, false);
    assert.ok(!JSON.stringify(await database.all('SELECT * FROM team_membership_invitation_email_attempts')).includes(leakedProviderText), 'Raw provider errors must not enter persistence.');
    console.log('Invitation email: unconfigured and definite failure statuses persist safe codes without SMTP details.');

    const unknown = await invite();
    const unknownDelivery = await sendCreatedTeamInvitationEmail({ ...options, ...unknown, actorUserId,
      deliver: async () => { throw new SystemSmtpDeliveryUnknownError(leakedProviderText); } });
    assert.equal(unknownDelivery.status, 'failed');
    assert.equal(unknownDelivery.deliveryUnknown, true);
    const beforeUnknownResend = messages.length;
    await listTeamInvitationEmailDeliveries({ organizationId, database, now: now + 180_000 });
    assert.equal(messages.length, beforeUnknownResend, 'Reading status must not retry delivery.');
    await assert.rejects(resendTeamInvitationEmail({ ...options, now: now + 60_000,
      organizationId, invitationId: unknown.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_EMAIL_UNKNOWN_CONFIRMATION_REQUIRED'));
    const confirmed = await resendTeamInvitationEmail({ ...options, now: now + 60_000,
      organizationId, invitationId: unknown.invitation.id, actorUserId, requestId: randomUUID(), confirmDeliveryUnknown: true });
    assert.equal(confirmed.emailDelivery.status, 'sent');
    assert.equal(messages.length, beforeUnknownResend + 1);
    console.log('Invitation email: unknown delivery has no automatic retry and requires explicit confirmation.');

    const managedUnknown = await invite();
    const managedRequestId = randomUUID();
    let managedAttempts = 0;
    const managedOptions = { ...options, organizationId, invitationId: managedUnknown.invitation.id, actorUserId,
      requestId: managedRequestId,
      resolveDelivery: async () => ({ kind: 'managed' as const, fromAddress: 'canvas@example.test' }),
      deliver: async () => { managedAttempts += 1; throw new ManagedSystemEmailHttpError('Synthetic late managed response', 503); },
    };
    const managedUnknownResult = await resendTeamInvitationEmail(managedOptions);
    assert.equal(managedUnknownResult.emailDelivery.status, 'failed');
    assert.equal(managedUnknownResult.emailDelivery.errorCode, 'INVITATION_EMAIL_DELIVERY_UNKNOWN');
    assert.equal(managedUnknownResult.emailDelivery.deliveryUnknown, true);
    await listTeamInvitationEmailDeliveries({ organizationId, database, now: now + 180_000 });
    const managedReplay = await resendTeamInvitationEmail({ ...managedOptions, now: now + 60_000 });
    assert.equal(managedReplay.replayed, true);
    assert.equal(managedReplay.token, null);
    assert.equal(managedAttempts, 1, 'Managed HTTP 503 status reads and UUID replays must never send again.');
    const confirmedRequestId = randomUUID();
    await assert.rejects(resendTeamInvitationEmail({ ...managedOptions, requestId: confirmedRequestId, now: now + 60_000 }),
      errorCode('INVITATION_EMAIL_UNKNOWN_CONFIRMATION_REQUIRED'));
    const managedConfirmed = await resendTeamInvitationEmail({ ...managedOptions, requestId: confirmedRequestId, now: now + 60_000,
      confirmDeliveryUnknown: true,
      deliver: async () => { managedAttempts += 1; return { messageId: 'managed-confirmed-acceptance' }; } });
    assert.equal(managedConfirmed.emailDelivery.status, 'sent');
    assert.equal(managedAttempts, 2, 'Only explicit confirmation authorizes another send after managed HTTP 503.');
    const smtpRejected = await invite();
    const smtpRejectedResult = await sendCreatedTeamInvitationEmail({ ...options, ...smtpRejected, actorUserId,
      deliver: async () => { throw Object.assign(new Error('Synthetic SMTP rejection'), { responseCode: 550 }); } });
    assert.equal(smtpRejectedResult.deliveryUnknown, false, 'An explicit local SMTP 550 rejection remains definite.');
    assert.equal(smtpRejectedResult.errorCode, 'INVITATION_EMAIL_SEND_FAILED');
    console.log('Invitation email: managed HTTP 503 is unknown, UUID replay sends nothing, confirmation is required; SMTP 550 remains definite.');

    const interrupted = await invite();
    const interruptedId = randomUUID();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const completion = resendTeamInvitationEmail({ ...options,
      organizationId, invitationId: interrupted.invitation.id, actorUserId, requestId: interruptedId,
      deliver: async () => {
        started!();
        await new Promise<void>(resolve => { release = resolve; });
        return { messageId: 'held-send' };
      } });
    await startedPromise;
    try {
      const pending = (await listTeamInvitationEmailDeliveries({ organizationId, database, now }))[interrupted.invitation.id];
      assert.equal(pending.status, 'sending');
      const pendingReplay = await resendTeamInvitationEmail({ ...options,
        organizationId, invitationId: interrupted.invitation.id, actorUserId, requestId: interruptedId });
      assert.equal(pendingReplay.replayed, true);
      assert.equal(pendingReplay.emailDelivery.status, 'sending');
      await assert.rejects(resendTeamInvitationEmail({ ...options,
        organizationId, invitationId: interrupted.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_EMAIL_SENDING'));
      const stale = (await listTeamInvitationEmailDeliveries({ organizationId, database, now: now + 120_000 }))[interrupted.invitation.id];
      assert.equal(stale.status, 'failed');
      assert.equal(stale.deliveryUnknown, true);
      await assert.rejects(resendTeamInvitationEmail({ ...options, now: now + 120_000,
        organizationId, invitationId: interrupted.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_EMAIL_UNKNOWN_CONFIRMATION_REQUIRED'));
    } finally { release!(); await completion; }
    console.log('Invitation email: persisted in-flight claim, concurrent request fencing and interrupted lease classification passed.');

    const terminal = await invite();
    await revokeTeamMembershipInvitation({ organizationId, invitationId: terminal.invitation.id, actorUserId, database, now });
    await assert.rejects(resendTeamInvitationEmail({ ...options,
      organizationId, invitationId: terminal.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_CONFLICT'));
    const accepted = await invite();
    await acceptTeamMembershipInvitation({ token: accepted.token, requestId: randomUUID(), database, now });
    await assert.rejects(resendTeamInvitationEmail({ ...options,
      organizationId, invitationId: accepted.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_CONFLICT'));
    const expired = await invite();
    await assert.rejects(resendTeamInvitationEmail({ ...options, now: now + 7 * 24 * 60 * 60 * 1000,
      organizationId, invitationId: expired.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_EXPIRED'));
    await assert.rejects(resendTeamInvitationEmail({ ...options, organizationId: 'another-org',
      invitationId: created.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_NOT_FOUND'));
    console.log('Invitation email: accepted, revoked, expired and cross-organization resends are rejected.');

    const rollback = await invite();
    await database.run(`CREATE FUNCTION reject_invitation_email_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic invitation email persistence failure'; END $$`);
    await database.run(`CREATE TRIGGER reject_invitation_email_insert BEFORE INSERT ON team_membership_invitation_email_attempts
      FOR EACH ROW EXECUTE FUNCTION reject_invitation_email_insert()`);
    const beforeRollback = messages.length;
    try {
      await assert.rejects(resendTeamInvitationEmail({ ...options, organizationId,
        invitationId: rollback.invitation.id, actorUserId, requestId: randomUUID() }));
    } finally {
      await database.run('DROP TRIGGER reject_invitation_email_insert ON team_membership_invitation_email_attempts');
      await database.run('DROP FUNCTION reject_invitation_email_insert()');
    }
    assert.equal(messages.length, beforeRollback, 'Failed attempt INSERT must cause no SMTP send.');
    assert.equal((await previewTeamMembershipInvitation({ token: rollback.token, database, now })).invitation.id, rollback.invitation.id,
      'Failed attempt INSERT must roll back token rotation.');
    console.log('Invitation email: failed claim persistence rolls back token rotation and sends nothing.');

    const persistFailure = await invite();
    const failedCompletionDatabase: SqlConnection = {
      ...database,
      run: async (sql, params) => {
        if (sql.includes('SET status = $1, error_code = $2')) throw new Error('Synthetic completion persistence failure');
        return database.run(sql, params);
      },
    };
    const beforeFailedCompletion = messages.length;
    await assert.rejects(sendCreatedTeamInvitationEmail({ ...options, ...persistFailure, actorUserId, database: failedCompletionDatabase }),
      (error: unknown) => error instanceof TeamInvitationEmailError && error.code === 'INVITATION_EMAIL_STATUS_UNAVAILABLE' && error.status === 503);
    assert.equal(messages.length, beforeFailedCompletion + 1, 'Provider acceptance may precede a completion persistence failure.');
    assert.equal((await listTeamInvitationEmailDeliveries({ organizationId, database, now }))[persistFailure.invitation.id].status, 'sending');
    await sendCreatedTeamInvitationEmail({ ...options, ...persistFailure, actorUserId });
    assert.equal(messages.length, beforeFailedCompletion + 1, 'Repeating after completion persistence failure must not send again.');
    assert.equal((await listTeamInvitationEmailDeliveries({ organizationId, database, now: now + 120_000 }))[persistFailure.invitation.id].deliveryUnknown, true);
    await assert.rejects(resendTeamInvitationEmail({ ...options, now: now + 120_000, organizationId,
      invitationId: persistFailure.invitation.id, actorUserId, requestId: randomUUID() }), errorCode('INVITATION_EMAIL_UNKNOWN_CONFIRMATION_REQUIRED'));
    console.log('Invitation email: completion persistence failure remains visible after reload and cannot trigger another SMTP send.');

    const currentAttempt = await invite();
    let earlierAttempt: string | null = null;
    await sendCreatedTeamInvitationEmail({ ...options, ...currentAttempt, actorUserId,
      deliver: async message => { earlierAttempt = message.attemptId; return { messageId: 'earlier-attempt' }; } });
    const currentRequestId = randomUUID();
    const actualCompletion: SqlConnection = {
      ...database,
      run: async (sql, params) => {
        if (sql.includes('SET status = $1, error_code = $2')) {
          assert.equal(params?.[6], currentRequestId, 'Completion must settle the exact newly claimed attempt ID.');
        }
        return database.run(sql, params);
      },
    };
    const currentResult = await resendTeamInvitationEmail({ ...options, database: actualCompletion, now: now + 60_000,
      organizationId, invitationId: currentAttempt.invitation.id, actorUserId, requestId: currentRequestId,
      deliver: async () => { throw new Error('Synthetic rejected delivery'); } });
    assert.equal(currentResult.emailDelivery.status, 'failed');
    const older = await database.get('SELECT status FROM team_membership_invitation_email_attempts WHERE id = $1', [earlierAttempt]) as { status: string };
    assert.equal(older.status, 'sent', 'A later failure must not overwrite an earlier accepted attempt.');
    console.log('Invitation email: settlement CAS targets its exact attempt and preserves previous delivery history.');

    const localMessages: Array<{ to: string[]; messageId: string; body: string }> = [];
    const managedMessages: Array<{ purpose: string; to: string[]; idempotencyKey: string; body: string }> = [];
    let mode: 'local' | 'managed' = 'local';
    const isolated = loadIsolatedModule<typeof import('../app/lib/organization/team-invitation-email')>(
      'app/lib/organization/team-invitation-email.ts', {
        'server-only': {}, 'node:crypto': crypto,
        '@/app/lib/db': { openDb: () => { throw new Error('Unexpected real database fallback'); } },
        '@/app/lib/email/system-smtp-config': { getSystemSmtpConfigurationStatus: async () => ({
          deliveryMode: mode, complete: true, managedAvailable: true, fromAddress: 'canvas@example.test',
        }) },
        '@/app/lib/email/system-smtp-service': { SystemSmtpDeliveryUnknownError,
          sendSystemSmtpEmail: async (message: typeof localMessages[number]) => { localMessages.push(message); return { messageId: 'local-id' }; } },
        '@/app/lib/email/managed-system-email-client': {
          ManagedSystemEmailDeliveryUnknownError: class extends Error {},
          ManagedSystemEmailHttpError,
          getManagedSystemEmailAvailability: async () => ({ available: true, fromAddress: 'canvas@example.test' }),
          sendManagedSystemEmail: async (message: typeof managedMessages[number]) => { managedMessages.push(message); return { messageId: 'managed-id' }; },
        },
        '@/app/lib/email/templates/team-invitation': { renderTeamInvitationEmail },
        '@/app/lib/utils/request-origin': { normalizePublicOrigin },
      });
    await isolated.sendCreatedTeamInvitationEmail({ ...(await invite()), actorUserId, database, now,
      publicOrigin: 'http://synthetic-user:synthetic-password@127.0.0.1:3100/unsafe/path?x=1#fragment' });
    assert.equal(localMessages.length, 1);
    assert.equal(localMessages[0].to.length, 1);
    assert.match(localMessages[0].messageId, /^<[a-f0-9]{64}@example\.test>$/u);
    assert.ok(!localMessages[0].body.includes('synthetic-password'), 'Configured URL credentials must not enter email links.');
    mode = 'managed';
    await isolated.sendCreatedTeamInvitationEmail({ ...(await invite()), actorUserId, database, now, publicOrigin });
    assert.equal(managedMessages.length, 1);
    assert.equal(managedMessages[0].purpose, 'invite');
    assert.equal(managedMessages[0].to.length, 1);
    assert.ok(managedMessages[0].idempotencyKey.startsWith('team-invitation:'));
    console.log('Invitation email: default local/managed System-email routing, one recipient and managed invite purpose passed.');

    const race = await invite();
    let rotatedToken: string | null = null;
    const racingDatabase: SqlConnection = {
      ...database,
      run: async (sql, params) => {
        if (sql.includes("SET\n          status = 'accepted'")) {
          const rotated = await resendTeamInvitationEmail({ ...options, organizationId,
            invitationId: race.invitation.id, actorUserId, requestId: randomUUID() });
          rotatedToken = rotated.token;
        }
        return database.run(sql, params);
      },
    };
    await assert.rejects(acceptTeamMembershipInvitation({ token: race.token, requestId: randomUUID(), database: racingDatabase, now }),
      (error: unknown) => error instanceof TeamInvitationError && error.code === 'INVITATION_ALREADY_USED');
    assert.ok(rotatedToken, 'Interleaving must execute token rotation after old-token read.');
    const freshAcceptance = await acceptTeamMembershipInvitation({ token: rotatedToken!, requestId: randomUUID(), database, now });
    assert.equal(freshAcceptance.invitation.status, 'accepted');
    console.log('Invitation email: an already-read old bearer token cannot accept after rotation; new token remains usable.');
  });
}

void main().catch(() => { console.error('Invitation email persistence regression failed.'); process.exitCode = 1; });
