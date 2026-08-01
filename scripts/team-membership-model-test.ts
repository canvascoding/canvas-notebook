import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  parseTeamSeatMembershipSnapshot,
  TEAM_SEAT_PROTOCOL_VERSION,
} from '../app/lib/license/team-seat-contract';
import { getTeamMembershipSyncState } from '../app/lib/license/team-seat-outbox';
import {
  adoptActiveTeamMembership,
  createTeamMembershipCandidate,
  getActiveTeamMembershipProjection,
  isActiveTeamMembership,
  TeamMembershipError,
  transitionTeamMembership,
} from '../app/lib/organization/team-membership';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-membership-model-'));
const sqlite = new Database(path.join(tempRoot, 'sqlite.db'));
sqlite.pragma('foreign_keys = ON');
runMigrations(sqlite);
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
};

function insertUser(id: string, email: string, role = 'user'): void {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(id, id, email, role, 1_000, 1_000);
}

async function main(): Promise<void> {
  insertUser('owner-user', 'owner@example.test', 'admin');
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('organization-1', 'owner-user', 'team', 1, 1000, 1000)
  `).run();

  const columns = new Set(
    sqlite.prepare('PRAGMA table_info(team_memberships)').all()
      .map((row) => String((row as { name: string }).name)),
  );
  assert.equal(columns.has('candidate_email'), true);
  assert.equal(columns.has('user_id'), true);
  assert.equal(columns.has('external_invitation_id'), true);
  assert.equal(columns.has('control_plane_operation_id'), true);

  const candidate = await createTeamMembershipCandidate(connection, {
    organizationId: 'organization-1',
    email: ' Candidate@Example.test ',
    displayName: 'Candidate',
    externalInvitationId: 'invitation-external-1',
    controlPlaneOperationId: 'operation-prepare-1',
    invitedByUserId: 'owner-user',
    source: 'invitation',
    reason: 'Initial invitation',
    now: 1_100,
    databaseProvider: 'sqlite',
  });

  assert.equal(candidate.candidateEmail, 'candidate@example.test');
  assert.equal(candidate.userId, null);
  assert.equal(candidate.status, 'invited');
  assert.equal(candidate.externalInvitationId, 'invitation-external-1');
  assert.equal(candidate.controlPlaneOperationId, 'operation-prepare-1');
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM "user" WHERE lower(email) = ?')
      .pluck()
      .get(candidate.candidateEmail),
    0,
  );
  assert.equal(
    (sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM team_membership_transitions
      WHERE membership_id = ?
    `).get(candidate.id) as { count: number }).count,
    1,
  );

  await assert.rejects(
    transitionTeamMembership(connection, {
      organizationId: 'organization-1',
      membershipId: candidate.id,
      expectedStatus: 'invited',
      toStatus: 'active',
      acceptedAt: 1_150,
      actorUserId: 'owner-user',
      source: 'local_admin',
      now: 1_150,
      databaseProvider: 'sqlite',
    }),
    (error: unknown) => (
      error instanceof TeamMembershipError
      && error.code === 'ACTIVE_IDENTITY_REQUIRED'
    ),
  );
  assert.equal(
    (sqlite.prepare('SELECT status FROM team_memberships WHERE id = ?').get(candidate.id) as { status: string }).status,
    'invited',
  );
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) AS count FROM team_membership_transitions WHERE membership_id = ?')
      .get(candidate.id) as { count: number }).count,
    1,
  );

  const approvalRequired = await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'invited',
    toStatus: 'approval_required',
    acceptedAt: 1_200,
    actorUserId: 'owner-user',
    source: 'invitation',
    reason: 'Invitation accepted; approval is required',
    now: 1_200,
    databaseProvider: 'sqlite',
  });
  assert.equal(approvalRequired.userId, null);
  assert.equal(approvalRequired.acceptedAt, 1_200);

  const billingPending = await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'approval_required',
    toStatus: 'billing_pending',
    actorUserId: 'owner-user',
    source: 'control_plane',
    controlPlaneOperationId: 'operation-execute-1',
    now: 1_300,
    databaseProvider: 'sqlite',
  });
  assert.equal(billingPending.userId, null);
  assert.equal(billingPending.controlPlaneOperationId, 'operation-execute-1');

  insertUser('candidate-user', 'candidate@example.test');
  const activeMember = await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'billing_pending',
    toStatus: 'active',
    userId: 'candidate-user',
    actorUserId: 'owner-user',
    source: 'control_plane',
    controlPlaneOperationId: 'operation-execute-1',
    now: 1_400,
    databaseProvider: 'sqlite',
  });
  assert.equal(isActiveTeamMembership(activeMember), true);
  assert.equal(activeMember.userId, 'candidate-user');
  assert.equal(activeMember.acceptedAt, 1_200);

  const pending = await createTeamMembershipCandidate(connection, {
    organizationId: 'organization-1',
    email: 'pending@example.test',
    status: 'billing_pending',
    controlPlaneOperationId: 'operation-pending-1',
    source: 'control_plane',
    now: 1_450,
    databaseProvider: 'sqlite',
  });
  assert.equal(pending.userId, null);

  const owner = await adoptActiveTeamMembership(connection, {
    organizationId: 'organization-1',
    userId: 'owner-user',
    role: 'owner',
    source: 'first_owner',
    seatOperationType: 'reconcile',
    reason: 'Adopt the existing first owner without creating another auth user',
    now: 1_500,
    databaseProvider: 'sqlite',
  });
  assert.equal(isActiveTeamMembership(owner), true);

  const projection = await getActiveTeamMembershipProjection(connection, 'organization-1');
  assert.equal(projection.observedQuantity, 2);
  assert.deepEqual(projection.roleSummary, {
    owner: 1,
    admin: 0,
    member: 1,
    external: 0,
  });

  const contractSnapshot = parseTeamSeatMembershipSnapshot({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    revision: 1,
    snapshotHash: 'snapshot-hash',
    observedQuantity: projection.observedQuantity,
    roleSummary: projection.roleSummary,
    memberHashes: [],
    generatedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(contractSnapshot.observedQuantity, 2);

  sqlite.exec(`
    CREATE TRIGGER fail_suspended_membership_audit
    BEFORE INSERT ON team_membership_transitions
    WHEN NEW.to_status = 'suspended'
    BEGIN
      SELECT RAISE(ABORT, 'forced transition audit failure');
    END
  `);
  await assert.rejects(
    transitionTeamMembership(connection, {
      organizationId: 'organization-1',
      membershipId: candidate.id,
      expectedStatus: 'active',
      toStatus: 'suspended',
      actorUserId: 'owner-user',
      source: 'local_admin',
      now: 1_600,
      databaseProvider: 'sqlite',
    }),
    /forced transition audit failure/u,
  );
  assert.equal(
    (sqlite.prepare('SELECT status FROM team_memberships WHERE id = ?').get(candidate.id) as { status: string }).status,
    'active',
    'the membership update must roll back if its transition audit cannot be persisted',
  );
  assert.equal(
    (await getTeamMembershipSyncState(connection, 'organization-1'))?.currentRevision,
    2,
    'the membership revision must roll back with a failed transition audit',
  );
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM team_seat_outbox').pluck().get(),
    2,
    'the snapshot outbox write must roll back with a failed transition audit',
  );
  sqlite.exec('DROP TRIGGER fail_suspended_membership_audit');

  const suspended = await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'active',
    toStatus: 'suspended',
    actorUserId: 'owner-user',
    source: 'local_admin',
    now: 1_700,
    databaseProvider: 'sqlite',
  });
  assert.equal(isActiveTeamMembership(suspended), false);
  assert.equal(
    (await getTeamMembershipSyncState(connection, 'organization-1'))?.currentRevision,
    3,
  );
  assert.equal(
    (await getActiveTeamMembershipProjection(connection, 'organization-1')).observedQuantity,
    1,
  );

  await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'suspended',
    toStatus: 'active',
    actorUserId: 'owner-user',
    source: 'control_plane',
    now: 1_800,
    databaseProvider: 'sqlite',
  });
  await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'active',
    toStatus: 'removed',
    actorUserId: 'owner-user',
    source: 'local_admin',
    now: 1_900,
    databaseProvider: 'sqlite',
  });
  const reinvited = await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: candidate.id,
    expectedStatus: 'removed',
    toStatus: 'invited',
    actorUserId: 'owner-user',
    source: 'invitation',
    externalInvitationId: 'invitation-external-2',
    now: 2_000,
    databaseProvider: 'sqlite',
  });
  assert.equal(reinvited.userId, null);
  assert.equal(reinvited.acceptedAt, null);
  assert.equal(reinvited.externalInvitationId, 'invitation-external-2');

  assert.throws(() => {
    sqlite.prepare(`
      INSERT INTO team_memberships (
        id, organization_id, candidate_email, role, status, created_at, updated_at
      ) VALUES ('invalid-active', 'organization-1', 'invalid@example.test', 'member', 'active', 2000, 2000)
    `).run();
  }, /CHECK constraint failed/u);

  const transitions = sqlite.prepare(`
    SELECT from_status, to_status, source
    FROM team_membership_transitions
    WHERE membership_id = ?
    ORDER BY created_at ASC
  `).all(candidate.id);
  assert.deepEqual(
    transitions.map((row) => (row as { to_status: string }).to_status),
    ['invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'active', 'removed', 'invited'],
  );

  console.log('team-membership-model-test: ok');
}

void main()
  .finally(() => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
