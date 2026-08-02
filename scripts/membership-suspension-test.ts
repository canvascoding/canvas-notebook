import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  adoptActiveTeamMembership,
  getTeamMembershipByUserId,
} from '../app/lib/organization/team-membership';
import {
  MembershipSuspensionError,
  suspendTeamMembershipUser,
} from '../app/lib/organization/membership-suspension';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-membership-suspension-'));
const sqlite = new Database(path.join(tempRoot, 'suspension.db'));
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

function insertUser(id: string, email: string, role: 'admin' | 'user') {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, banned, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 0, 1000, 1000)
  `).run(id, id, email, role);
}

function insertPermission(
  organizationId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member',
) {
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id,
      user_id,
      role,
      status,
      can_recover_workspaces,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'active', 1, 1000, 1000)
  `).run(organizationId, userId, role);
}

async function expectSuspensionError(
  operation: () => Promise<unknown>,
  code: MembershipSuspensionError['code'],
) {
  await assert.rejects(operation, (error) => (
    error instanceof MembershipSuspensionError && error.code === code
  ));
}

async function main() {
  const organizationId = 'organization-1';
  insertUser('owner-user', 'owner@example.test', 'admin');
  insertUser('admin-user', 'admin@example.test', 'admin');
  insertUser('member-user', 'member@example.test', 'user');
  insertUser('rollback-user', 'rollback@example.test', 'user');
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id,
      owner_user_id,
      deployment_mode,
      team_features_enabled,
      created_at,
      updated_at
    ) VALUES (?, 'owner-user', 'team', 1, 1000, 1000)
  `).run(organizationId);
  insertPermission(organizationId, 'owner-user', 'owner');
  insertPermission(organizationId, 'admin-user', 'admin');
  insertPermission(organizationId, 'member-user', 'member');
  insertPermission(organizationId, 'rollback-user', 'member');

  for (const membership of [
    { userId: 'owner-user', role: 'owner' as const },
    { userId: 'admin-user', role: 'admin' as const },
    { userId: 'member-user', role: 'member' as const },
    { userId: 'rollback-user', role: 'member' as const },
  ]) {
    await adoptActiveTeamMembership(connection, {
      organizationId,
      userId: membership.userId,
      role: membership.role,
      source: 'migration',
      actorUserId: 'owner-user',
      seatOperationType: 'reconcile',
      databaseProvider: 'sqlite',
      now: 1_100,
    });
  }
  sqlite.prepare(`
    INSERT INTO "session" (
      id, expires_at, token, created_at, updated_at, user_id
    ) VALUES
      ('member-session', 5000, 'member-token', 1000, 1000, 'member-user'),
      ('rollback-session', 5000, 'rollback-token', 1000, 1000, 'rollback-user')
  `).run();

  const suspended = await suspendTeamMembershipUser({
    organizationId,
    targetUserId: 'member-user',
    actorUserId: 'admin-user',
    reason: 'Security review',
    database: connection,
    databaseProvider: 'sqlite',
    now: 2_000,
  });
  assert.equal(suspended.membership.status, 'suspended');
  assert.equal(suspended.sessionsRevoked, 1);
  assert.equal(suspended.replayed, false);
  assert.deepEqual(
    sqlite.prepare('SELECT banned, ban_reason FROM "user" WHERE id = ?').get('member-user'),
    { banned: 1, ban_reason: 'Security review' },
  );
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM "session" WHERE user_id = ?').pluck().get('member-user'),
    0,
  );
  const syncState = sqlite.prepare(`
    SELECT current_revision, current_observed_quantity
    FROM team_membership_sync_state
    WHERE organization_id = ?
  `).get(organizationId) as {
    current_revision: number;
    current_observed_quantity: number;
  };
  assert.equal(syncState.current_observed_quantity, 3);
  const reduction = sqlite.prepare(`
    SELECT membership_revision, request_json, status
    FROM team_seat_outbox
    WHERE membership_id = ?
      AND operation_kind = 'seat_prepare'
      AND operation_type = 'member_remove'
    LIMIT 1
  `).get(suspended.membership.id) as {
    membership_revision: number;
    request_json: string;
    status: string;
  };
  assert.equal(reduction.membership_revision, syncState.current_revision);
  assert.equal(reduction.status, 'pending');
  assert.deepEqual(JSON.parse(reduction.request_json), {
    desiredQuantity: 3,
    externalReference: suspended.membership.id,
    protocolVersion: 'canvas-team-seat-protocol-v1',
    triggerType: 'member_remove',
  });

  const replay = await suspendTeamMembershipUser({
    organizationId,
    targetUserId: 'member-user',
    actorUserId: 'admin-user',
    reason: 'Security review',
    database: connection,
    databaseProvider: 'sqlite',
    now: 2_100,
  });
  assert.equal(replay.replayed, true);
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*)
      FROM team_seat_outbox
      WHERE membership_id = ?
        AND operation_kind = 'seat_prepare'
        AND operation_type = 'member_remove'
    `).pluck().get(suspended.membership.id),
    1,
  );

  await expectSuspensionError(
    () => suspendTeamMembershipUser({
      organizationId,
      targetUserId: 'owner-user',
      actorUserId: 'admin-user',
      database: connection,
      databaseProvider: 'sqlite',
      now: 2_200,
    }),
    'MEMBERSHIP_LAST_OWNER',
  );
  await expectSuspensionError(
    () => suspendTeamMembershipUser({
      organizationId,
      targetUserId: 'admin-user',
      actorUserId: 'admin-user',
      database: connection,
      databaseProvider: 'sqlite',
      now: 2_300,
    }),
    'MEMBERSHIP_SELF_SUSPENSION',
  );

  sqlite.exec(`
    CREATE TRIGGER fail_member_remove_prepare
    BEFORE INSERT ON team_seat_outbox
    WHEN NEW.operation_kind = 'seat_prepare' AND NEW.operation_type = 'member_remove'
    BEGIN
      SELECT RAISE(ABORT, 'simulated reduction outbox failure');
    END
  `);
  await assert.rejects(() => suspendTeamMembershipUser({
    organizationId,
    targetUserId: 'rollback-user',
    actorUserId: 'admin-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 2_400,
  }));
  assert.deepEqual(
    sqlite.prepare('SELECT banned, ban_reason FROM "user" WHERE id = ?').get('rollback-user'),
    { banned: 0, ban_reason: null },
  );
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM "session" WHERE user_id = ?').pluck().get('rollback-user'),
    1,
  );
  assert.equal(
    (await getTeamMembershipByUserId(connection, organizationId, 'rollback-user'))?.status,
    'active',
  );
  const authSource = readFileSync(
    path.join(process.cwd(), 'app/lib/auth.ts'),
    'utf8',
  );
  assert.match(authSource, /context\.path === "\/admin\/ban-user"/u);
  assert.match(authSource, /context\.path === "\/admin\/unban-user"/u);
  const panelSource = readFileSync(
    path.join(process.cwd(), 'app/components/settings/UserManagementPanel.tsx'),
    'utf8',
  );
  assert.match(panelSource, /users\/\$\{encodeURIComponent\(user\.id\)\}\/suspension/u);
}

main()
  .then(() => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
    console.log('membership suspension tests passed');
  })
  .catch((error) => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
    console.error(error);
    process.exitCode = 1;
  });
