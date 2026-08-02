import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  acceptTeamMembershipInvitation,
  createTeamMembershipInvitation,
  expireTeamMembershipInvitations,
  listTeamMembershipInvitations,
  revokeTeamMembershipInvitation,
  TeamInvitationError,
} from '../app/lib/organization/team-invitations';
import {
  adoptActiveTeamMembership,
  getTeamMembershipByCandidateEmail,
} from '../app/lib/organization/team-membership';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-invitations-'));
const sqlitePath = path.join(tempRoot, 'invitations.db');
const sqlite = new Database(sqlitePath);
sqlite.pragma('foreign_keys = ON');
runMigrations(sqlite);

const connection = {
  get: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).get(...params) : sqlite.prepare(sql).get()
  ),
  run: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).run(...params) : sqlite.prepare(sql).run()
  ),
  all: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).all(...params) : sqlite.prepare(sql).all()
  ),
  close: () => undefined,
};

function outboxCount(): number {
  return sqlite.prepare('SELECT COUNT(*) FROM team_seat_outbox').pluck().get() as number;
}

async function expectInvitationError(
  operation: () => Promise<unknown>,
  code: TeamInvitationError['code'],
) {
  await assert.rejects(operation, (error) => (
    error instanceof TeamInvitationError && error.code === code
  ));
}

async function main() {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, banned, created_at, updated_at
    ) VALUES ('owner-user', 'Owner', 'owner@example.test', 1, 'admin', 0, 1000, 1000)
  `).run();
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('organization-1', 'owner-user', 'team', 1, 1000, 1000)
  `).run();
  await adoptActiveTeamMembership(connection, {
    organizationId: 'organization-1',
    userId: 'owner-user',
    role: 'owner',
    source: 'first_owner',
    seatOperationType: 'reconcile',
    now: 1_100,
    databaseProvider: 'sqlite',
  });
  const initialOutboxCount = outboxCount();

  const created = await createTeamMembershipInvitation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'Invited.Member@example.test',
    displayName: 'Invited Member',
    role: 'member',
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    database: connection,
    databaseProvider: 'sqlite',
    now: 2_000,
  });
  assert.equal(created.membership.status, 'invited');
  assert.equal(created.membership.userId, null);
  assert.equal(created.invitation.status, 'pending');
  assert.equal(created.invitation.email, 'invited.member@example.test');
  assert.equal(outboxCount(), initialOutboxCount, 'pending invitations must not enqueue Seat or Stripe work');
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?').pluck().get(created.invitation.email),
    0,
  );
  const storedSecret = sqlite.prepare(`
    SELECT token_hash
    FROM team_membership_invitations
    WHERE id = ?
  `).get(created.invitation.id) as { token_hash: string };
  assert.notEqual(storedSecret.token_hash, created.token);
  assert.match(storedSecret.token_hash, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(
    JSON.stringify(await listTeamMembershipInvitations({
      organizationId: 'organization-1',
      database: connection,
    })),
    new RegExp(created.token, 'u'),
  );

  await expectInvitationError(
    () => acceptTeamMembershipInvitation({
      token: `x${created.token}`,
      requestId: '208ff899-a624-4f99-927f-1149d5c5ac7d',
      database: connection,
      databaseProvider: 'sqlite',
      now: 3_000,
    }),
    'INVITATION_NOT_FOUND',
  );

  const acceptanceRequestId = '208ff899-a624-4f99-927f-1149d5c5ac7d';
  const accepted = await acceptTeamMembershipInvitation({
    token: created.token,
    requestId: acceptanceRequestId,
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_000,
  });
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.invitation.status, 'accepted');
  assert.equal(accepted.membership.status, 'approval_required');
  assert.equal(accepted.membership.acceptedAt, 3_000);
  assert.equal(outboxCount(), initialOutboxCount, 'accepting an invitation must not buy or consume a Seat');

  const replayed = await acceptTeamMembershipInvitation({
    token: created.token,
    requestId: acceptanceRequestId,
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_100,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*)
      FROM team_membership_transitions
      WHERE membership_id = ? AND to_status = 'approval_required'
    `).pluck().get(created.membership.id),
    1,
  );
  await expectInvitationError(
    () => acceptTeamMembershipInvitation({
      token: created.token,
      requestId: '996b55f5-55b3-435e-902d-11b2db5e07c7',
      database: connection,
      databaseProvider: 'sqlite',
      now: 3_200,
    }),
    'INVITATION_ALREADY_USED',
  );

  const revokedCandidate = await createTeamMembershipInvitation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'revoked@example.test',
    displayName: 'Revoked Member',
    role: 'member',
    database: connection,
    databaseProvider: 'sqlite',
    now: 4_000,
  });
  const revoked = await revokeTeamMembershipInvitation({
    organizationId: 'organization-1',
    invitationId: revokedCandidate.invitation.id,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 4_100,
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(
    (await getTeamMembershipByCandidateEmail(
      connection,
      'organization-1',
      'revoked@example.test',
    ))?.status,
    'removed',
  );
  await expectInvitationError(
    () => acceptTeamMembershipInvitation({
      token: revokedCandidate.token,
      requestId: '11cc6214-ce35-4914-b4b7-8ad163bdc30d',
      database: connection,
      databaseProvider: 'sqlite',
      now: 4_200,
    }),
    'INVITATION_REVOKED',
  );

  const reissued = await createTeamMembershipInvitation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'revoked@example.test',
    displayName: 'Revoked Member',
    role: 'member',
    database: connection,
    databaseProvider: 'sqlite',
    now: 4_300,
  });
  assert.equal(reissued.invitation.id, revokedCandidate.invitation.id);
  assert.notEqual(reissued.token, revokedCandidate.token);
  await expectInvitationError(
    () => acceptTeamMembershipInvitation({
      token: revokedCandidate.token,
      requestId: '7bf7484f-d59f-4c20-bccf-114e1b560a77',
      database: connection,
      databaseProvider: 'sqlite',
      now: 4_400,
    }),
    'INVITATION_NOT_FOUND',
  );

  const expiring = await createTeamMembershipInvitation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'expired@example.test',
    displayName: 'Expired Member',
    role: 'admin',
    ttlMs: 15 * 60 * 1000,
    database: connection,
    databaseProvider: 'sqlite',
    now: 5_000,
  });
  assert.equal(await expireTeamMembershipInvitations({
    database: connection,
    databaseProvider: 'sqlite',
    now: 5_000 + (15 * 60 * 1000),
  }), 1);
  assert.equal(
    (await getTeamMembershipByCandidateEmail(
      connection,
      'organization-1',
      'expired@example.test',
    ))?.status,
    'removed',
  );
  await expectInvitationError(
    () => acceptTeamMembershipInvitation({
      token: expiring.token,
      requestId: '8482bab2-6c2c-44f8-aecd-1405c9d8c304',
      database: connection,
      databaseProvider: 'sqlite',
      now: 5_000 + (15 * 60 * 1000) + 1,
    }),
    'INVITATION_EXPIRED',
  );

  const mismatch = await createTeamMembershipInvitation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'mismatch@example.test',
    displayName: 'Mismatch',
    role: 'member',
    database: connection,
    databaseProvider: 'sqlite',
    now: 6_000,
  });
  sqlite.prepare(`
    UPDATE team_memberships
    SET role = 'admin'
    WHERE id = ?
  `).run(mismatch.membership.id);
  await expectInvitationError(
    () => acceptTeamMembershipInvitation({
      token: mismatch.token,
      requestId: '80eae727-cfa4-4176-8754-cf413031e9fe',
      database: connection,
      databaseProvider: 'sqlite',
      now: 6_100,
    }),
    'INVITATION_CONFLICT',
  );
  assert.equal(outboxCount(), initialOutboxCount);
  assert.equal(
    sqlite.prepare(`
      SELECT current_revision
      FROM team_membership_sync_state
      WHERE organization_id = 'organization-1'
    `).pluck().get(),
    1,
    'invitation lifecycle changes must not alter the active Seat revision',
  );

  const panelSource = readFileSync(
    path.join(process.cwd(), 'app/components/settings/UserManagementPanel.tsx'),
    'utf8',
  );
  assert.match(panelSource, /memberships\/invitations/u);
  assert.match(panelSource, /createdInviteLink/u);
}

main()
  .then(() => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
    console.log('team invitation tests passed');
  })
  .catch((error) => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
    console.error(error);
    process.exitCode = 1;
  });
