import assert from 'node:assert/strict';
import { TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL } from '../app/lib/db/postgres';
import { adoptActiveTeamMembership } from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    const cases = [
      { organizationId: 'legacy-community-solo', mode: 'single_user' },
      { organizationId: 'legacy-managed-single', mode: 'managed_single' },
      { organizationId: 'legacy-managed-team', mode: 'managed_team' },
    ];
    for (const entry of cases) {
      await seedTeamSeatOrganization(database, entry.organizationId, now);
      await database.run(`UPDATE canvas_organization_settings SET deployment_mode = $1 WHERE organization_id = $2`, [entry.mode, entry.organizationId]);
    }
    const memberId = 'legacy-team-member';
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Legacy Member', 'LEGACY-MEMBER@example.test', 1, 'user', $2, $2)
    `, [memberId, now]);
    await database.run(`
      INSERT INTO organization_user_permissions (organization_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, 'member', 'active', $3, $3)
    `, ['legacy-managed-team', memberId, now]);
    const preexisting = await adoptActiveTeamMembership(database, {
      organizationId: 'legacy-managed-team',
      userId: 'owner-legacy-managed-team',
      role: 'owner',
      source: 'reconciliation',
      now,
    });
    await database.run(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL);
    const rows = await database.all(`
      SELECT organization_id, user_id, candidate_email, role, status
      FROM team_memberships
      WHERE organization_id LIKE 'legacy-%'
      ORDER BY organization_id, role, user_id
    `) as Array<{ organization_id: string; user_id: string; candidate_email: string; role: string; status: string }>;
    assert.equal(rows.length, 4);
    for (const entry of cases) {
      assert.ok(rows.some((row) => row.organization_id === entry.organizationId
        && row.user_id === `owner-${entry.organizationId}` && row.role === 'owner' && row.status === 'active'));
    }
    assert.ok(rows.some((row) => row.user_id === memberId
      && row.candidate_email === 'legacy-member@example.test' && row.role === 'member' && row.status === 'active'));
    const existing = await database.get(`SELECT id FROM team_memberships WHERE organization_id = $1 AND user_id = $2`, [
      'legacy-managed-team', 'owner-legacy-managed-team',
    ]) as { id: string };
    assert.equal(existing.id, preexisting.id);
    for (const entry of cases) {
      const sync = await database.get(`SELECT current_observed_quantity FROM team_membership_sync_state WHERE organization_id = $1`, [entry.organizationId]) as { current_observed_quantity: number };
      assert.equal(sync.current_observed_quantity, entry.organizationId === 'legacy-managed-team' ? 2 : 1);
    }
    const marker = await database.get(`SELECT metadata_json FROM canvas_data_migrations WHERE migration_key = 'team-seat-membership-v1'`) as { metadata_json: string };
    assert.equal(JSON.parse(marker.metadata_json).billableOperationsCreated, 0);
    assert.equal((await database.get(`SELECT count(*)::integer AS count FROM team_seat_outbox`) as { count: number }).count, 0);
    await database.run(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL);
    assert.equal((await database.get(`SELECT count(*)::integer AS count FROM team_memberships WHERE organization_id LIKE 'legacy-%'`) as { count: number }).count, 4);
    assert.equal((await database.get(`SELECT count(*)::integer AS count FROM team_membership_transitions WHERE source = 'migration'`) as { count: number }).count, 4);
  });
  await withTeamSeatTestDatabase(async (database) => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    const organizationId = 'legacy-duplicate-identity';
    await seedTeamSeatOrganization(database, organizationId, now);
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ('duplicate-legacy-user', 'Duplicate', $1, 1, 'user', $2, $2)
    `, [`${organizationId.toUpperCase()}@EXAMPLE.TEST`, now]);
    await database.run(`
      INSERT INTO organization_user_permissions (organization_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, 'duplicate-legacy-user', 'member', 'active', $2, $2)
    `, [organizationId, now]);
    await assert.rejects(
      async () => { await database.run(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL); },
      /duplicate Team Seat legacy identities/,
    );
    assert.equal((await database.get(`SELECT count(*)::integer AS count FROM team_memberships WHERE organization_id = $1`, [organizationId]) as { count: number }).count, 0);
    assert.equal((await database.get(`SELECT count(*)::integer AS count FROM canvas_data_migrations WHERE migration_key = 'team-seat-membership-v1'`) as { count: number }).count, 0);
  });
  console.log('team-seat-legacy-migration-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
