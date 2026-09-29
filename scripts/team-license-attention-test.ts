import assert from 'node:assert/strict';

import { listTeamLicenseAttention, markTeamLicenseAttentionRead } from '../app/lib/license/team-license-attention';
import { reconcileTeamLicenseLifecycle } from '../app/lib/license/team-license-lifecycle';
import type { LicenseStatus } from '../app/lib/license/types';
import { adoptActiveTeamMembership } from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const organizationId = 'team-license-attention';
const ownerId = `owner-${organizationId}`;
const memberId = 'member-team-license-attention';
const startedAt = Date.parse('2030-01-01T00:00:00.000Z');

function license(state: 'active' | 'expired'): LicenseStatus {
  return {
    plan: 'managed', licensed: state === 'active', hostingMode: 'cloud', edition: 'team',
    licenseState: state, seatLimit: 2, licenseClass: 'manual',
    entitlementsVersion: state === 'active' ? 2 : 1,
  } as LicenseStatus;
}

async function main() {
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
    const options = { database, enabled: true, locale: 'de' };
    assert.deepEqual(await listTeamLicenseAttention({ userId: ownerId, ...options }), []);

    const fallback = await reconcileTeamLicenseLifecycle(license('expired'), {
      database, now: new Date(startedAt + 1000),
    });
    assert.equal(fallback.suspendedMemberships, 1);
    assert.equal(fallback.disabledUsers, 1);
    const first = await listTeamLicenseAttention({ userId: ownerId, ...options });
    assert.equal(first.length, 1);
    assert.equal(first[0].unread, true);
    assert.equal(first[0].target.kind, 'license');
    assert.match(first[0].title, /pausiert/);
    assert.deepEqual(await listTeamLicenseAttention({ userId: memberId, ...options }), []);
    assert.deepEqual(await listTeamLicenseAttention({ userId: ownerId, ...options, enabled: false }), []);

    const replay = await reconcileTeamLicenseLifecycle(license('expired'), {
      database, now: new Date(startedAt + 2000),
    });
    assert.equal(replay.changed, false);
    assert.deepEqual((await listTeamLicenseAttention({ userId: ownerId, ...options })).map((item) => item.id), [first[0].id]);

    const marked = await markTeamLicenseAttentionRead({ userId: ownerId, itemId: first[0].id, ...options });
    assert.deepEqual(marked, { updated: 1, found: true });
    assert.equal((await listTeamLicenseAttention({ userId: ownerId, ...options }))[0].unread, false);
    assert.deepEqual(await markTeamLicenseAttentionRead({ userId: memberId, itemId: first[0].id, ...options }), {
      updated: 0, found: false,
    });

    const restore = await reconcileTeamLicenseLifecycle(license('active'), {
      database, now: new Date(startedAt + 3000),
    });
    assert.equal(restore.restoredMemberships, 1);
    const restored = await listTeamLicenseAttention({ userId: ownerId, ...options });
    assert.equal(restored.length, 2);
    assert.match(restored[0].title, /wiederhergestellt/);
    assert.equal(restored[0].unread, true);
    assert.equal(restored[1].unread, false);
    assert.equal((await reconcileTeamLicenseLifecycle(license('active'), {
      database, now: new Date(startedAt + 4000),
    })).changed, false);
    assert.equal((await listTeamLicenseAttention({ userId: ownerId, ...options })).length, 2);
    assert.deepEqual(await markTeamLicenseAttentionRead({ userId: ownerId, ...options }), { updated: 1, found: true });
    assert((await listTeamLicenseAttention({ userId: ownerId, ...options })).every((item) => !item.unread));
  });
  console.info('committed license fallback and restore notifications, owner visibility, read state, replay, and preference-off passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
