import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const organizationId = 'team-license-term-warning';
const ownerId = `owner-${organizationId}`;
const day = 86_400_000;
const term = Date.parse('2030-02-01T12:00:00.000Z');

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-license-term-warning-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;
  try {
    const { recordTeamLicenseTermWarning, termWarningStage } = await import('../app/lib/license/team-license-term-warning');
    const { listTeamLicenseAttention, markTeamLicenseAttentionRead } = await import('../app/lib/license/team-license-attention');
    const { enqueueTeamLicenseEmail, processTeamLicenseEmailOutbox } = await import('../app/lib/license/team-license-email-outbox');
    const { updateUserPreferences } = await import('../app/lib/user-preferences');
    const { seedTeamSeatOrganization, withTeamSeatTestDatabase } = await import('./team-seat-test-db');
    await withTeamSeatTestDatabase(async (database) => {
      await seedTeamSeatOrganization(database, organizationId, term - 30 * day);
      const input = {
        database, instanceId: 'instance-term-warning', organizationId,
        grantId: 'manual-grant-a', termEndsAt: new Date(term).toISOString(), seatLimit: 5,
      };
      assert.equal(termWarningStage(input.termEndsAt, term - 15 * day), null);
      assert.equal(termWarningStage(input.termEndsAt, term), null);
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - 15 * day }), { stage: null, created: false });
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - 14 * day }), { stage: 14, created: true });
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - 13 * day }), { stage: 14, created: false });
      const ownerAttention = { userId: ownerId, database, enabled: true, locale: 'de' };
      let notices = await listTeamLicenseAttention(ownerAttention);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, 'license.team_grant_expiring');
      assert.match(notices[0].title, /14 Tagen/u);
      assert.equal(notices[0].unread, true);
      assert.deepEqual(await listTeamLicenseAttention({ userId: 'not-owner', database, enabled: true }), []);
      assert.deepEqual(await listTeamLicenseAttention({ ...ownerAttention, enabled: false }), []);
      await updateUserPreferences(ownerId, { teamLicenseNotificationsEnabled: false });
      assert.deepEqual(await listTeamLicenseAttention({ userId: ownerId, database }), []);
      await updateUserPreferences(ownerId, { teamLicenseNotificationsEnabled: true });
      assert.equal((await listTeamLicenseAttention({ userId: ownerId, database })).length, 1);
      assert.deepEqual(await markTeamLicenseAttentionRead({ ...ownerAttention, itemId: notices[0].id }), { updated: 1, found: true });
      assert.equal((await listTeamLicenseAttention(ownerAttention))[0].unread, false);

      const failed: string[] = [];
      assert.deepEqual(await processTeamLicenseEmailOutbox({
        database, now: term - 14 * day,
        deliver: async (message) => {
          failed.push(message.idempotencyKey);
          assert.match(message.subject, /14/u);
          throw new Error('Transient fake failure');
        },
      }), { delivered: 0, failed: 1, skipped: 0, manualReview: 0 });
      assert.deepEqual(await processTeamLicenseEmailOutbox({
        database, now: term - 14 * day + 30_000,
        deliver: async (message) => {
          assert.deepEqual([message.idempotencyKey], failed);
          return { messageId: 'fake-14d' };
        },
      }), { delivered: 1, failed: 0, skipped: 0, manualReview: 0 });

      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - 3 * day }), { stage: 3, created: true });
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - 2 * day }), { stage: 3, created: false });
      await updateUserPreferences(ownerId, { teamLicenseEmailNotificationsEnabled: false });
      assert.deepEqual(await processTeamLicenseEmailOutbox({
        database, now: term - 3 * day,
        deliver: async () => { throw new Error('Preference-off email sent'); },
      }), { delivered: 0, failed: 0, skipped: 1, manualReview: 0 });
      await updateUserPreferences(ownerId, { teamLicenseEmailNotificationsEnabled: true });

      await enqueueTeamLicenseEmail(database, {
        auditEventId: 'independent-restore', organizationId, userId: ownerId,
        kind: 'owner_restored', reason: 'active', seatLimit: 5, now: term - day - 1000,
      });
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - day }), { stage: 1, created: true });
      assert.equal((await database.get(`
        SELECT status FROM team_license_email_outbox WHERE audit_event_id = 'independent-restore'
      `) as { status: string }).status, 'pending');
      notices = await listTeamLicenseAttention(ownerAttention);
      assert.equal(notices.length, 3);
      assert.match(notices[0].title, /1 Tag/u);
      assert.deepEqual((await database.all(`
        SELECT action FROM audit_events WHERE event_type = 'license_term_warning'
      `) as Array<{ action: string }>).map((row) => row.action).sort(), [
        'team.grant_expiring_14d', 'team.grant_expiring_1d', 'team.grant_expiring_3d',
      ]);
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, grantId: 'manual-grant-b', now: term - day }), { stage: 1, created: true });
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, termEndsAt: new Date(term + day).toISOString(), now: term - day }), { stage: 3, created: true });
    });
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
  console.info('manual grant term warnings, NC preference, dedupe, email retry, and unrelated restore job passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
