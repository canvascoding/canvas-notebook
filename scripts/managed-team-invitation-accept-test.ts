import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
process.env.CANVAS_INSTANCE_ID = 'managed-invitation-policy-test';

const organizationId = 'managed-organization';
const membershipId = 'pending-membership';
const invitationId = 'pending-invitation';
const token = 'A'.repeat(43);
const requestId = 'c56130c0-5664-4e1c-931e-1e5630798639';
const differentRequestId = '50a6d0da-e40a-40c0-b05c-5a6dc67c880d';

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-managed-invitation-policy-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;
  const [{ acceptTeamMembershipInvitation, TeamInvitationError }, { createTableSql, getPostgresSchemaTables },
    { requireManagedTeamInvitationPolicy }, { recordManagedTeamAccessPolicy }] = await Promise.all([
    import('../app/lib/organization/team-invitations'),
    import('../app/lib/db/postgres'),
    import('../app/lib/license/managed-team-invitation-policy'),
    import('../app/lib/license/managed-team-access-policy'),
  ]);
  const pg = new PGlite();
  try {
    const missingPolicy = await requireManagedTeamInvitationPolicy();
    assert.equal(missingPolicy?.status, 409);
    assert.equal((await missingPolicy?.json())?.code, 'MANAGED_TEAM_INVITATIONS_PAUSED');
    await recordManagedTeamAccessPolicy({
      instanceId: process.env.CANVAS_INSTANCE_ID!, entitlementsVersion: 1,
      policy: { state: 'active', reason: null, graceEndsAt: null, allowNewMembers: true },
    });
    assert.equal(await requireManagedTeamInvitationPolicy(), null);
    for (const name of ['team_memberships', 'team_membership_invitations', 'team_membership_transitions']) {
      const table = getPostgresSchemaTables().find((candidate) => createTableSql(candidate).includes(`"${name}"`));
      assert.ok(table, `${name} must be included in PostgreSQL startup migrations`);
      await pg.exec(createTableSql(table));
    }
    const now = Date.now();
    await pg.query(`
      INSERT INTO team_memberships (
        id, organization_id, candidate_email, display_name, user_id, role, status,
        external_invitation_id, invited_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, NULL, 'member', 'invited', $5, $6, $6, $6)
    `, [membershipId, organizationId, 'tester@example.test', 'Tester', invitationId, now]);
    await pg.query(`
      INSERT INTO team_membership_invitations (
        id, organization_id, membership_id, token_hash, email_snapshot, role_snapshot,
        status, expires_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'member', 'pending', $6, $7, $7)
    `, [invitationId, organizationId, membershipId,
      createHash('sha256').update(token).digest('hex'), 'tester@example.test', now + 60_000, now]);
    const database = {
      async all(sql: string, params?: unknown[]) { return (await pg.query(sql, params)).rows; },
      async get(sql: string, params?: unknown[]) { return (await pg.query(sql, params)).rows[0]; },
      async run(sql: string, params?: unknown[]) {
        const result = await pg.query(sql, params);
        return { changes: result.affectedRows ?? 0 };
      },
      async close() {},
    };
    const first = await acceptTeamMembershipInvitation({ token, requestId, database, now });
    assert.equal(first.replayed, false);
    assert.equal(first.membership.status, 'approval_required');
    assert.equal(first.membership.userId, null);

    const replay = await acceptTeamMembershipInvitation({ token, requestId, database, now: now + 1 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.membership.id, first.membership.id);
    await assert.rejects(
      acceptTeamMembershipInvitation({ token, requestId: differentRequestId, database, now: now + 2 }),
      (error: unknown) => error instanceof TeamInvitationError && error.code === 'INVITATION_ALREADY_USED',
    );
    const rows = await pg.query<{ status: string; user_id: string | null; accepted_at: number | null }>(`
      SELECT status, user_id, accepted_at FROM team_memberships WHERE id = $1
    `, [membershipId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, 'approval_required');
    assert.equal(rows.rows[0].user_id, null);
    assert.ok(rows.rows[0].accepted_at);
    const transitions = await pg.query<{ to_status: string }>(`
      SELECT to_status FROM team_membership_transitions WHERE membership_id = $1
    `, [membershipId]);
    assert.deepEqual(transitions.rows.map((row) => row.to_status), ['approval_required']);
    await recordManagedTeamAccessPolicy({
      instanceId: process.env.CANVAS_INSTANCE_ID!, entitlementsVersion: 2,
      policy: { state: 'grace', reason: 'grant_expired', graceEndsAt: new Date(Date.now() + 86_400_000).toISOString(), allowNewMembers: false },
    });
    const gracePolicy = await requireManagedTeamInvitationPolicy();
    assert.equal(gracePolicy?.status, 409);
    assert.equal((await gracePolicy?.json())?.code, 'MANAGED_TEAM_INVITATIONS_PAUSED');
    await recordManagedTeamAccessPolicy({
      instanceId: process.env.CANVAS_INSTANCE_ID!, entitlementsVersion: 3,
      policy: { state: 'restricted', reason: 'grant_revoked', graceEndsAt: null, allowNewMembers: false },
    });
    const restrictedPolicy = await requireManagedTeamInvitationPolicy();
    assert.equal(restrictedPolicy?.status, 409);
    assert.equal((await restrictedPolicy?.json())?.code, 'MANAGED_TEAM_INVITATIONS_PAUSED');
    assert.equal((await pg.query<{ status: string }>('SELECT status FROM team_memberships WHERE id = $1', [membershipId])).rows[0].status, 'approval_required');
    process.env.CANVAS_DEPLOYMENT_MODE = 'community';
    assert.equal(await requireManagedTeamInvitationPolicy(), null);
    process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
    console.info('managed invitation acceptance replay and conflicting request ID passed');
  } finally {
    await pg.close();
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
