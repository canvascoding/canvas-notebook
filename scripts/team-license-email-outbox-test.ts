import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LicenseStatus } from '../app/lib/license/types';

const organizationId = 'team-license-email-outbox';
const ownerId = `owner-${organizationId}`;
const memberId = 'member-team-license-email-outbox';
const startedAt = Date.parse('2030-01-01T00:00:00.000Z');

function license(state: 'active' | 'expired'): LicenseStatus {
  return {
    plan: 'managed', licensed: state === 'active', hostingMode: 'cloud', edition: 'team',
    licenseState: state, seatLimit: 2, licenseClass: 'manual',
    entitlementsVersion: state === 'active' ? 2 : 1,
  } as LicenseStatus;
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-license-email-outbox-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;
  try {
    const { reconcileTeamLicenseLifecycle } = await import('../app/lib/license/team-license-lifecycle');
    const { enqueueTeamLicenseEmail, processTeamLicenseEmailOutbox, readTeamLicenseEmailOutboxDiagnostics } = await import('../app/lib/license/team-license-email-outbox');
    const { ManagedSystemEmailDeliveryUnknownError, ManagedSystemEmailHttpError, sendManagedSystemEmail } = await import('../app/lib/email/managed-system-email-client');
    const { adoptActiveTeamMembership } = await import('../app/lib/organization/team-membership');
    const { updateUserPreferences } = await import('../app/lib/user-preferences');
    const { seedTeamSeatOrganization, withTeamSeatTestDatabase } = await import('./team-seat-test-db');
    const previousFetch = globalThis.fetch;
    const previousManaged = process.env.CANVAS_MANAGED_SERVICES_ENABLED;
    const previousToken = process.env.CANVAS_INSTANCE_TOKEN;
    const previousControlPlane = process.env.CANVAS_CONTROL_PLANE_URL;
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_INSTANCE_TOKEN = 'fake-test-token';
    process.env.CANVAS_CONTROL_PLANE_URL = 'http://127.0.0.1:9';
    const managedMessage = {
      purpose: 'automation_alert' as const, to: ['owner@example.test'],
      subject: 'Test', body: 'Test body', idempotencyKey: 'test-idempotency',
    };
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Delivery state unknown.' }), { status: 409 });
      await assert.rejects(sendManagedSystemEmail(managedMessage), ManagedSystemEmailDeliveryUnknownError);
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Definite transient failure.' }), { status: 502 });
      await assert.rejects(sendManagedSystemEmail(managedMessage), (error: unknown) => (
        error instanceof ManagedSystemEmailHttpError && error.statusCode === 502
      ));
      globalThis.fetch = async () => { throw new TypeError('Fake connection reset'); };
      await assert.rejects(sendManagedSystemEmail(managedMessage), ManagedSystemEmailDeliveryUnknownError);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousManaged === undefined) delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
      else process.env.CANVAS_MANAGED_SERVICES_ENABLED = previousManaged;
      if (previousToken === undefined) delete process.env.CANVAS_INSTANCE_TOKEN;
      else process.env.CANVAS_INSTANCE_TOKEN = previousToken;
      if (previousControlPlane === undefined) delete process.env.CANVAS_CONTROL_PLANE_URL;
      else process.env.CANVAS_CONTROL_PLANE_URL = previousControlPlane;
    }
    await withTeamSeatTestDatabase(async (database) => {
      await seedTeamSeatOrganization(database, organizationId, startedAt);
      await database.run(`
        INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
        VALUES ($1, 'Test Member', 'member-license@example.test', 1, 'user', $2, $2)
      `, [memberId, startedAt]);
      await adoptActiveTeamMembership(database, {
        organizationId, userId: ownerId, role: 'owner', source: 'first_owner', now: startedAt,
      });
      await adoptActiveTeamMembership(database, {
        organizationId, userId: memberId, role: 'member', source: 'migration', now: startedAt,
      });
      await database.run(`
        INSERT INTO organization_user_permissions
          (organization_id, user_id, role, status, created_at, updated_at)
        VALUES ($1, $2, 'owner', 'active', $4, $4),
          ($1, $3, 'member', 'active', $4, $4)
      `, [organizationId, ownerId, memberId, startedAt]);

      const pausedAt = startedAt + 1000;
      const fallback = await reconcileTeamLicenseLifecycle(license('expired'), {
        database, now: new Date(pausedAt),
      });
      assert.equal(fallback.disabledUsers, 1);
      const pending = await database.all('SELECT user_id, event_kind, status FROM team_license_email_outbox ORDER BY user_id') as Array<{
        user_id: string; event_kind: string; status: string;
      }>;
      assert.equal(pending.length, 2);
      assert(pending.some((row) => row.user_id === ownerId && row.event_kind === 'owner_restricted'));
      assert(pending.some((row) => row.user_id === memberId && row.event_kind === 'member_paused'));
      assert(pending.every((row) => row.status === 'pending'));
      assert.equal((await reconcileTeamLicenseLifecycle(license('expired'), {
        database, now: new Date(pausedAt + 1000),
      })).changed, false);
      assert.equal((await database.all('SELECT id FROM team_license_email_outbox')).length, 2);

      const attempted: string[] = [];
      const first = await processTeamLicenseEmailOutbox({
        database, now: pausedAt, deliver: async (message) => {
          attempted.push(message.idempotencyKey);
          throw new ManagedSystemEmailHttpError('Definite transient fake transport failure', 502);
        },
      });
      assert.deepEqual(first, { delivered: 0, failed: 2, skipped: 0, manualReview: 0 });
      assert.equal((await database.all("SELECT id FROM team_license_email_outbox WHERE status = 'delivered'")).length, 0);
      const successful: string[] = [];
      const second = await processTeamLicenseEmailOutbox({
        database, now: pausedAt + 30_000, deliver: async (message) => {
          successful.push(message.idempotencyKey);
          return { messageId: 'fake-message' };
        },
      });
      assert.deepEqual(second, { delivered: 2, failed: 0, skipped: 0, manualReview: 0 });
      assert.deepEqual(successful.sort(), attempted.sort());
      assert.deepEqual(await processTeamLicenseEmailOutbox({
        database, now: pausedAt + 60_000, deliver: async () => { throw new Error('Duplicate send'); },
      }), { delivered: 0, failed: 0, skipped: 0, manualReview: 0 });

      await updateUserPreferences(memberId, { teamLicenseEmailNotificationsEnabled: false });
      const restoredAt = startedAt + 120_000;
      const restored = await reconcileTeamLicenseLifecycle(license('active'), {
        database, now: new Date(restoredAt),
      });
      assert.equal(restored.restoredUsers, 1);
      const third = await processTeamLicenseEmailOutbox({
        database, now: restoredAt, deliver: async (message) => {
          assert.equal(message.to, `${organizationId}@example.test`);
          return { messageId: 'fake-owner-restore' };
        },
      });
      assert.deepEqual(third, { delivered: 1, failed: 0, skipped: 1, manualReview: 0 });
      const states = await database.all('SELECT event_kind, status FROM team_license_email_outbox ORDER BY created_at, id') as Array<{
        event_kind: string; status: string;
      }>;
      assert.equal(states.filter((row) => row.status === 'delivered').length, 3);
      assert(states.some((row) => row.event_kind === 'member_restored' && row.status === 'skipped'));

      await enqueueTeamLicenseEmail(database, {
        auditEventId: 'stale-audit', organizationId, userId: ownerId,
        kind: 'owner_restricted', reason: 'expired', seatLimit: 1, now: restoredAt + 1000,
      });
      await enqueueTeamLicenseEmail(database, {
        auditEventId: 'current-audit', organizationId, userId: ownerId,
        kind: 'owner_restored', reason: 'active', seatLimit: 2, now: restoredAt + 2000,
      });
      const superseded = await database.get(`
        SELECT status FROM team_license_email_outbox WHERE audit_event_id = 'stale-audit'
      `) as { status: string };
      assert.equal(superseded.status, 'superseded');
      const final = await processTeamLicenseEmailOutbox({
        database, now: restoredAt + 2000, deliver: async (message) => {
          assert.match(message.idempotencyKey, /current-audit/);
          return { messageId: 'fake-current-message' };
        },
      });
      assert.deepEqual(final, { delivered: 1, failed: 0, skipped: 0, manualReview: 0 });

      await enqueueTeamLicenseEmail(database, {
        auditEventId: 'unknown-audit', organizationId, userId: ownerId,
        kind: 'owner_restricted', reason: 'expired', seatLimit: 1, now: restoredAt + 3000,
      });
      const unknown = await processTeamLicenseEmailOutbox({
        database, now: restoredAt + 3000,
        deliver: async () => { throw new ManagedSystemEmailDeliveryUnknownError('Managed delivery unknown (409).'); },
      });
      assert.deepEqual(unknown, { delivered: 0, failed: 0, skipped: 0, manualReview: 1 });
      assert.equal((await database.get(`
        SELECT status FROM team_license_email_outbox WHERE audit_event_id = 'unknown-audit'
      `) as { status: string }).status, 'manual_review');
      assert.deepEqual(await readTeamLicenseEmailOutboxDiagnostics(database, organizationId), {
        manualReview: 1, retryPending: 0,
      });
      assert.deepEqual(await processTeamLicenseEmailOutbox({
        database, now: restoredAt + 60_000,
        deliver: async () => { throw new Error('Unknown delivery must not auto-retry'); },
      }), { delivered: 0, failed: 0, skipped: 0, manualReview: 0 });
    });
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
  console.info('team license email outbox persisted, retried, deduplicated, and respected user preference');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
