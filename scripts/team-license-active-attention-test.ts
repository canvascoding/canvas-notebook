import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlConnection } from '../app/lib/db';

const day = 86_400_000;
const term = Date.parse('2030-02-01T12:00:00.000Z');

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-license-active-attention-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;
  try {
    const { listTeamLicenseAttention, markTeamLicenseAttentionRead } = await import('../app/lib/license/team-license-attention');
    const { recordTeamLicenseTermWarning } = await import('../app/lib/license/team-license-term-warning');
    const { resolveObsoleteTeamLicenseInAppWarnings } = await import('../app/lib/license/team-license-warning-resolution');
    const { adoptActiveTeamMembership } = await import('../app/lib/organization/team-membership');
    const { seedTeamSeatOrganization, withTeamSeatTestDatabase } = await import('./team-seat-test-db');

    await withTeamSeatTestDatabase(async (database) => {
      const organizationId = 'active-license-attention';
      const ownerId = `owner-${organizationId}`;
      const memberId = `member-${organizationId}`;
      const instanceId = 'instance-active-license';
      await seedTeamSeatOrganization(database, organizationId, term - 30 * day);
      await database.run(`
        INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
        VALUES ($1, 'Warned Member', 'active-member@example.test', 1, 'user', $2, $2)
      `, [memberId, term - 30 * day]);
      await adoptActiveTeamMembership(database, {
        organizationId, userId: memberId, role: 'member', source: 'migration', now: term - 30 * day,
      });
      const ownerOptions = { database, userId: ownerId, enabled: true, locale: 'de' };
      const memberOptions = { ...ownerOptions, userId: memberId };
      const input = {
        database, organizationId, instanceId, grantId: 'manual-grant-a',
        termEndsAt: new Date(term).toISOString(), seatLimit: 5,
      };
      const activeOwner = () => listTeamLicenseAttention({ ...ownerOptions, activeOnly: true });
      const activeMember = () => listTeamLicenseAttention({ ...memberOptions, activeOnly: true });

      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - 14 * day }), { stage: 14, created: true });
      const firstOwner = (await activeOwner())[0];
      const firstMember = (await activeMember())[0];
      assert(firstOwner && firstMember);
      assert.notEqual(firstOwner.id, firstMember.id);
      assert.deepEqual(await markTeamLicenseAttentionRead({ ...ownerOptions, itemId: firstOwner.id }), { updated: 1, found: true });
      assert.deepEqual(await activeOwner(), [], 'reading removes the active event');
      assert.equal((await listTeamLicenseAttention(ownerOptions))[0].unread, false, 'history retains its read state');
      assert.equal((await activeMember())[0].unread, true, 'one recipient reading leaves the other recipient unread');
      assert.deepEqual(await markTeamLicenseAttentionRead({ ...ownerOptions, itemId: firstOwner.id }), { updated: 1, found: true });
      assert.deepEqual(await markTeamLicenseAttentionRead({ ...memberOptions, itemId: firstOwner.id }), { updated: 0, found: false });

      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - 3 * day }), { stage: 3, created: true });
      assert.equal((await activeOwner()).length, 1);
      assert.match((await activeOwner())[0].title, /3 Tagen/u);
      assert.equal((await activeMember()).length, 1);
      assert.deepEqual(await recordTeamLicenseTermWarning({ ...input, now: term - day }), { stage: 1, created: true });
      const finalWarning = (await activeOwner())[0];
      assert.match(finalWarning.title, /1 Tag/u);
      assert.equal((await activeOwner()).length, 1);
      await markTeamLicenseAttentionRead({ ...ownerOptions, itemId: finalWarning.id });
      assert.deepEqual(await activeOwner(), [], 'reading the newest stage cannot resurrect the older unread stage');
      assert.match((await activeMember())[0].title, /1 Tag/u);
      const firstReadAt = await readTimestamp(database, ownerId, firstOwner.id);
      const originalWarnings = await warningAudits(database, organizationId);

      const grace = { ...input, graceEndsAt: new Date(term + 7 * day).toISOString(), now: term + 1000 };
      assert.deepEqual(await recordTeamLicenseTermWarning(grace), { stage: null, created: true });
      assert.equal((await activeOwner()).length, 1);
      assert.match((await activeOwner())[0].detail, /Schonfrist/u);
      assert.equal((await activeMember()).length, 1);
      assert.match((await activeMember())[0].detail, /Schonfrist/u);
      assert.equal((await listTeamLicenseAttention(ownerOptions)).length, 4, 'resolution records stay outside ordinary history');
      assert.equal(await resolutionCount(database, organizationId), 6, 'advance warnings resolve for every recipient');
      assert.deepEqual((await warningAudits(database, organizationId)).slice(0, originalWarnings.length), originalWarnings);
      assert.equal(await readTimestamp(database, ownerId, firstOwner.id), firstReadAt, 'resolution preserves existing read timestamps');
      const graceOwner = (await activeOwner())[0];
      await markTeamLicenseAttentionRead({ ...ownerOptions, itemId: graceOwner.id });
      assert.deepEqual(await activeOwner(), []);
      assert.equal((await activeMember()).length, 1);

      const renewedTerm = term + 40 * day;
      const renewal = { ...input, termEndsAt: new Date(renewedTerm).toISOString(), now: term + 8 * day };
      assert.deepEqual(await recordTeamLicenseTermWarning(renewal), { stage: null, created: false });
      assert.deepEqual(await activeOwner(), []);
      assert.deepEqual(await activeMember(), [], 'renewal without a warning stage clears old member warnings');
      const resolvedCount = await resolutionCount(database, organizationId);
      assert.equal(resolvedCount, 8);
      const warningsAfterRenewal = await warningAudits(database, organizationId);
      await recordTeamLicenseTermWarning({ ...renewal, now: renewal.now + 1000 });
      assert.equal(await resolutionCount(database, organizationId), resolvedCount, 'resolution replay is idempotent');
      assert.deepEqual(await warningAudits(database, organizationId), warningsAfterRenewal, 'resolution never rewrites original audits');
      assert.equal(await readTimestamp(database, ownerId, firstOwner.id), firstReadAt);
      assert.deepEqual(await markTeamLicenseAttentionRead({ ...ownerOptions, itemId: firstOwner.id }), { updated: 1, found: true }, 'resolved history remains markable');

      assert.deepEqual(await recordTeamLicenseTermWarning({ ...renewal, now: renewedTerm - 14 * day }), { stage: 14, created: true });
      assert.equal((await activeOwner()).length, 1, 'a new term creates a new active event');
      const perpetual = { ...input, grantId: 'perpetual-grant', termEndsAt: null, now: renewedTerm - 13 * day };
      assert.deepEqual(await recordTeamLicenseTermWarning(perpetual), { stage: null, created: false });
      assert.deepEqual(await activeOwner(), []);
      assert.deepEqual(await activeMember(), []);
      const perpetualCount = await resolutionCount(database, organizationId);
      await recordTeamLicenseTermWarning({ ...perpetual, now: perpetual.now + 1000 });
      assert.equal(await resolutionCount(database, organizationId), perpetualCount);

      const commercialTerm = renewedTerm + 20 * day;
      await recordTeamLicenseTermWarning({ ...input, grantId: 'manual-before-commercial', termEndsAt: new Date(commercialTerm).toISOString(), now: commercialTerm - 14 * day });
      assert.equal((await activeOwner()).length, 1);
      const commercial = {
        database, organizationId, instanceId, grantId: null, termEndsAt: null,
        grace: false, restricted: false, now: commercialTerm - 13 * day,
      };
      await resolveObsoleteTeamLicenseInAppWarnings(commercial);
      assert.deepEqual(await activeOwner(), []);
      assert.deepEqual(await activeMember(), [], 'commercial Team resolves old manual warnings for every recipient');
      const commercialCount = await resolutionCount(database, organizationId);
      await resolveObsoleteTeamLicenseInAppWarnings({ ...commercial, now: commercial.now + 1000 });
      assert.equal(await resolutionCount(database, organizationId), commercialCount);

      const scopeOrg = 'license-scope';
      const otherOrg = 'license-other-scope';
      await seedTeamSeatOrganization(database, scopeOrg, term);
      await seedTeamSeatOrganization(database, otherOrg, term);
      const scopeOwner = `owner-${scopeOrg}`;
      const otherOwner = `owner-${otherOrg}`;
      await insertAudit(database, {
        id: 'scope-instance-a', organizationId: scopeOrg, userId: scopeOwner,
        action: 'team.grant_expiring_3d', now: term,
        metadata: { instanceId: 'instance-a', grantId: 'grant-a', termEndsAt: new Date(term + 3 * day).toISOString() },
      });
      await insertAudit(database, {
        id: 'scope-instance-b', organizationId: scopeOrg, userId: scopeOwner,
        action: 'team.grant_expiring_3d', now: term + 1000,
        metadata: { instanceId: 'instance-b', grantId: 'grant-b', termEndsAt: new Date(term + 3 * day).toISOString() },
      });
      await insertAudit(database, {
        id: 'scope-other-organization', organizationId: otherOrg, userId: otherOwner,
        action: 'team.grant_expiring_3d', now: term,
        metadata: { instanceId: 'instance-a', grantId: 'grant-a', termEndsAt: new Date(term + 3 * day).toISOString() },
      });
      await resolveObsoleteTeamLicenseInAppWarnings({ ...commercial, organizationId: scopeOrg, instanceId: 'instance-a', now: term + 2000 });
      assert.deepEqual((await listTeamLicenseAttention({ database, userId: scopeOwner, enabled: true, activeOnly: true })).map((item) => item.id), ['license:scope-instance-b']);
      assert.equal((await listTeamLicenseAttention({ database, userId: otherOwner, enabled: true, activeOnly: true })).length, 1, 'another organization is untouched');

      await insertAudit(database, {
        id: 'scope-future-warning', organizationId: scopeOrg, userId: scopeOwner,
        action: 'team.grant_expiring_1d', now: term + 10_000,
        metadata: { instanceId: 'instance-a', grantId: 'future-grant', termEndsAt: new Date(term + day).toISOString() },
      });
      await resolveObsoleteTeamLicenseInAppWarnings({ ...commercial, organizationId: scopeOrg, instanceId: 'instance-a', now: term + 3000 });
      assert((await listTeamLicenseAttention({ database, userId: scopeOwner, enabled: true, activeOnly: true })).some((item) => item.id === 'license:scope-future-warning'), 'stale input cannot resolve a newer warning');
      assert.equal(await resolutionCount(database, scopeOrg), 1);

      const lifecycleOrg = 'license-lifecycle-active';
      await seedTeamSeatOrganization(database, lifecycleOrg, term);
      const lifecycleOwner = `owner-${lifecycleOrg}`;
      const lifecycleOptions = { database, userId: lifecycleOwner, enabled: true, activeOnly: true, locale: 'de' };
      await insertAudit(database, {
        id: 'lifecycle-restricted', organizationId: lifecycleOrg, userId: lifecycleOwner,
        action: 'team.solo_fallback_applied', now: term,
        metadata: { suspendedMemberships: 2, restoredMemberships: 0, remainingFallbackUsers: 2 },
      });
      await insertAudit(database, {
        id: 'lifecycle-restored', organizationId: lifecycleOrg, userId: lifecycleOwner,
        action: 'team.access_restored', now: term + 1000,
        metadata: { suspendedMemberships: 0, restoredMemberships: 2, remainingFallbackUsers: 0 },
      });
      let lifecycle = await listTeamLicenseAttention(lifecycleOptions);
      assert.equal(lifecycle.length, 1);
      assert.equal(lifecycle[0].id, 'license:lifecycle-restored');
      assert.equal(lifecycle[0].priority, 'normal', 'complete recovery is informative');
      await markTeamLicenseAttentionRead({ ...lifecycleOptions, activeOnly: false, itemId: lifecycle[0].id });
      assert.deepEqual(await listTeamLicenseAttention(lifecycleOptions), [], 'read recovery cannot revive the old restriction');
      await insertAudit(database, {
        id: 'lifecycle-partial', organizationId: lifecycleOrg, userId: lifecycleOwner,
        action: 'team.access_restored', now: term + 2000,
        metadata: { suspendedMemberships: 1, restoredMemberships: 1, remainingFallbackUsers: 1 },
      });
      lifecycle = await listTeamLicenseAttention(lifecycleOptions);
      assert.equal(lifecycle.length, 1);
      assert.equal(lifecycle[0].priority, 'high');
      assert.match(lifecycle[0].title, /teilweise/u);
      assert.match(lifecycle[0].detail, /eingeschränkt/u);
      await insertAudit(database, {
        id: 'lifecycle-remaining', organizationId: lifecycleOrg, userId: lifecycleOwner,
        action: 'team.access_restored', now: term + 3000,
        metadata: { suspendedMemberships: 0, restoredMemberships: 1, remainingFallbackUsers: 1 },
      });
      assert.equal((await listTeamLicenseAttention(lifecycleOptions))[0].priority, 'high', 'remaining restricted users keep recovery actionable');
      await insertAudit(database, {
        id: 'lifecycle-unrelated-warning', organizationId: lifecycleOrg, userId: lifecycleOwner,
        action: 'team.grant_expiring_1d', now: term - 1000,
        metadata: { instanceId: 'independent-instance', grantId: 'independent-grant', termEndsAt: new Date(term + day).toISOString() },
      });
      assert.equal((await listTeamLicenseAttention(lifecycleOptions)).length, 2, 'restoration alone cannot erase an unrelated grant warning');
      await markTeamLicenseAttentionRead({ ...lifecycleOptions, activeOnly: false });
      assert.deepEqual(await listTeamLicenseAttention(lifecycleOptions), [], 'mark-all-read removes all active license events');
      assert.equal((await listTeamLicenseAttention({ ...lifecycleOptions, activeOnly: false })).length, 5);

      const atomicOrg = 'license-resolution-atomic';
      await seedTeamSeatOrganization(database, atomicOrg, term - 30 * day);
      const atomicInput = { ...input, organizationId: atomicOrg, instanceId: 'instance-atomic' };
      await recordTeamLicenseTermWarning({ ...atomicInput, now: term - 14 * day });
      const atomicOptions = { database, userId: `owner-${atomicOrg}`, enabled: true, activeOnly: true };
      const beforeFailure = await listTeamLicenseAttention(atomicOptions);
      const originalAtomicAudit = await warningAudits(database, atomicOrg);
      const failingDatabase = {
        ...database,
        get: async (...args: Parameters<SqlConnection['get']>) => {
          if (args[0].includes('INSERT INTO audit_events')) throw new Error('Forced replacement warning failure');
          return database.get(...args);
        },
      };
      await assert.rejects(recordTeamLicenseTermWarning({
        ...atomicInput, database: failingDatabase,
        termEndsAt: new Date(term + 20 * day).toISOString(), now: term + 10 * day,
      }), /Forced replacement warning failure/u);
      assert.equal(await resolutionCount(database, atomicOrg), 0, 'a failed replacement rolls back its resolutions');
      assert.deepEqual(await warningAudits(database, atomicOrg), originalAtomicAudit);
      assert.deepEqual(await listTeamLicenseAttention(atomicOptions), beforeFailure, 'the original active warning survives transaction failure');
    });
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
  console.info('active license attention: read persistence, stage/grace supersession, recipient isolation, authoritative resolution, replay, scope, stale input, recovery priority, and transaction rollback passed');
}

async function insertAudit(database: SqlConnection, input: {
  id: string;
  organizationId: string;
  userId: string;
  action: string;
  metadata: Record<string, unknown>;
  now: number;
}) {
  const lifecycle = ['team.solo_fallback_applied', 'team.seat_limit_enforced', 'team.access_restored'].includes(input.action);
  await database.run(`
    INSERT INTO audit_events (id, organization_id, user_id, source, event_type, entity_type, entity_id,
      action, status, summary, metadata_json, created_at)
    VALUES ($1, $2, $3, 'license', $4, 'organization', $2, $5, 'success', 'Active attention regression fixture', $6, $7)
  `, [input.id, input.organizationId, input.userId, lifecycle ? 'license_lifecycle' : 'license_term_warning', input.action, JSON.stringify(input.metadata), input.now]);
}

async function readTimestamp(database: SqlConnection, userId: string, itemId: string) {
  const row = await database.get('SELECT read_at FROM mobile_inbox_read_states WHERE user_id = $1 AND item_key = $2', [userId, itemId]) as { read_at: number | string } | undefined;
  assert(row);
  return row.read_at;
}

async function resolutionCount(database: SqlConnection, organizationId: string) {
  const row = await database.get(`SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = $1 AND event_type = 'license_term_warning_resolved'`, [organizationId]) as { count: number | string };
  return Number(row.count);
}

async function warningAudits(database: SqlConnection, organizationId: string) {
  return database.all(`SELECT id, action, metadata_json, created_at FROM audit_events
    WHERE organization_id = $1 AND event_type = 'license_term_warning' ORDER BY created_at ASC, id ASC`, [organizationId]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
