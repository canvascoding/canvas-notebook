import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  beginDirectMembershipActivation,
  completeDirectMembershipActivation,
  recordDirectMembershipSeatPreparation,
} from '../app/lib/organization/membership-orchestrator';
import {
  adoptActiveTeamMembership,
  getActiveTeamMembershipProjection,
  getTeamMembershipByCandidateEmail,
} from '../app/lib/organization/team-membership';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-membership-orchestrator-'));
const sqlitePath = path.join(tempRoot, 'orchestrator.db');
let sqlite = new Database(sqlitePath);
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

function insertUser(input: {
  id: string;
  name: string;
  email: string;
  role?: string;
  banned?: number;
  banReason?: string | null;
  now?: number;
}) {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, banned, ban_reason, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.email,
    input.role ?? 'user',
    input.banned ?? 0,
    input.banReason ?? null,
    input.now ?? 1_000,
    input.now ?? 1_000,
  );
}

function prepareResponse(input: {
  desiredQuantity: number;
  authorizationId: string;
}) {
  return {
    quote: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      quoteId: 'd49f0ef7-92c7-4ea9-b9cc-ab3659dc4056',
      subject: {
        type: 'license',
        licenseId: '1f9ee6ae-0f74-4314-918f-881ef4b9282c',
      },
      provider: 'manual',
      environment: 'production',
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      quantityDelta: 1,
      unitAmountCents: 0,
      currency: 'eur',
      billingInterval: 'month',
      immediateAmountCents: 0,
      recurringAmountCents: 0,
      status: 'active',
      expiresAt: '2026-08-01T12:00:00.000Z',
      quoteHash: 'quote-hash',
      nonBillable: true,
    },
    authorization: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      authorizationId: input.authorizationId,
      quoteId: 'd49f0ef7-92c7-4ea9-b9cc-ab3659dc4056',
      quoteHash: 'quote-hash',
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      status: 'approved',
      expiresAt: '2026-08-01T12:00:00.000Z',
      approvedAt: '2026-08-01T10:00:00.000Z',
      consumedAt: null,
    },
    requiresBillingApproval: false,
    snapshot: {
      revision: 1,
      observedQuantity: input.desiredQuantity - 1,
      licensedQuantity: input.desiredQuantity - 1,
      approvedQuantity: 25,
      billedQuantity: 0,
      billingStatus: 'active',
    },
  };
}

function executeResponse(input: {
  operationKey: string;
  desiredQuantity: number;
}) {
  return {
    operation: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      operationId: '5f5b7a45-e342-40e1-926b-5de3638c17eb',
      operationKey: input.operationKey,
      operationType: 'member_create',
      provider: 'manual',
      environment: 'production',
      status: 'applied',
      paymentStatus: 'manual_grant',
      previousQuantity: input.desiredQuantity - 1,
      requestedQuantity: input.desiredQuantity,
      effectiveQuantity: input.desiredQuantity,
      retryCount: 0,
      lastError: null,
      effectiveAt: '2026-08-01T10:01:00.000Z',
      entitlementsVersion: 2,
      certificateReissueStatus: 'issued',
      createdAt: '2026-08-01T10:01:00.000Z',
      updatedAt: '2026-08-01T10:01:00.000Z',
    },
    replayed: false,
    license: {
      license: 'x'.repeat(128),
      details: {
        id: '1f9ee6ae-0f74-4314-918f-881ef4b9282c',
        plan: 'team',
        status: 'active',
        instanceId: 'instance-production-1',
        hostingMode: 'community',
        edition: 'team',
        licenseClass: 'manual',
        licenseEnvironment: 'production',
        billingOrganizationId: null,
        entitlementsVersion: 2,
        deploymentMode: 'self_hosted',
        features: {
          multiUser: true,
          teamWorkspace: true,
        },
        quotas: {
          users: input.desiredQuantity,
        },
        activatedAt: '2026-08-01T10:01:00.000Z',
        expiresAt: '2026-08-08T10:01:00.000Z',
      },
    },
  };
}

async function main() {
  insertUser({
    id: 'owner-user',
    name: 'Owner',
    email: 'owner@example.test',
    role: 'admin',
  });
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

  const started = await beginDirectMembershipActivation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'New.Member@example.test',
    displayName: 'New Member',
    role: 'member',
    database: connection,
    databaseProvider: 'sqlite',
    now: 2_000,
  });
  assert.equal(started.stage, 'seat_prepare_pending');
  assert.equal(started.observedQuantity, 1);
  assert.equal(started.desiredQuantity, 2);
  assert.equal(started.membership.status, 'approval_required');
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?').pluck().get('new.member@example.test'),
    0,
    'starting an activation must not create a login-capable Better Auth user',
  );

  sqlite.close();
  sqlite = new Database(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  const resumedStart = await beginDirectMembershipActivation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'new.member@example.test',
    displayName: 'New Member',
    role: 'member',
    database: connection,
    databaseProvider: 'sqlite',
    now: 2_100,
  });
  assert.equal(resumedStart.replayed, true);
  assert.equal(resumedStart.membership.id, started.membership.id);
  assert.equal(resumedStart.prepareOperation.operationId, started.prepareOperation.operationId);

  const authorizationId = '541b814e-379a-460f-b82b-111af91ca710';
  const preparedPayload = prepareResponse({
    desiredQuantity: 2,
    authorizationId,
  });
  const prepared = await recordDirectMembershipSeatPreparation({
    organizationId: 'organization-1',
    membershipId: started.membership.id,
    prepareOperationId: started.prepareOperation.operationId,
    response: preparedPayload,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_000,
  });
  assert.equal(prepared.stage, 'seat_execute_pending');
  assert.equal(prepared.membership.status, 'billing_pending');
  assert.equal(prepared.executeOperation?.operationId, authorizationId);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?').pluck().get('new.member@example.test'),
    0,
    'an approved quote still must not create a user before Seat execution and certificate verification',
  );

  sqlite.close();
  sqlite = new Database(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  const resumedPrepare = await recordDirectMembershipSeatPreparation({
    organizationId: 'organization-1',
    membershipId: started.membership.id,
    prepareOperationId: started.prepareOperation.operationId,
    response: preparedPayload,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_100,
  });
  assert.equal(resumedPrepare.executeOperation?.operationId, prepared.executeOperation?.operationId);

  let certificateVerifications = 0;
  const identity = {
    ensurePending: async (input: {
      name: string;
      email: string;
      password: string;
      role: 'admin' | 'user';
    }) => {
      assert.equal(input.password, 'correct horse battery staple');
      const existing = sqlite.prepare(`
        SELECT id, email
        FROM "user"
        WHERE email = ?
        LIMIT 1
      `).get(input.email) as { id: string; email: string } | undefined;
      if (existing) return existing;
      insertUser({
        id: 'member-user',
        name: input.name,
        email: input.email,
        role: input.role,
        banned: 1,
        banReason: 'canvas_team_membership_pending',
        now: 4_000,
      });
      return { id: 'member-user', email: input.email };
    },
    activate: async (userId: string) => {
      sqlite.prepare(`
        UPDATE "user"
        SET banned = 0, ban_reason = NULL
        WHERE id = ? AND ban_reason = 'canvas_team_membership_pending'
      `).run(userId);
    },
  };
  const executedPayload = executeResponse({
    operationKey: prepared.executeOperation!.operationId,
    desiredQuantity: 2,
  });
  const completed = await completeDirectMembershipActivation({
    organizationId: 'organization-1',
    membershipId: started.membership.id,
    executeOperationId: prepared.executeOperation!.operationId,
    response: executedPayload,
    password: 'correct horse battery staple',
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    identity,
    verifyCertificate: async (_response, desiredQuantity) => {
      certificateVerifications += 1;
      assert.equal(desiredQuantity, 2);
    },
    now: 4_000,
  });
  assert.equal(completed.stage, 'active');
  assert.equal(completed.membership.userId, 'member-user');
  assert.equal((await getActiveTeamMembershipProjection(connection, 'organization-1')).observedQuantity, 2);
  assert.deepEqual(
    sqlite.prepare('SELECT banned, ban_reason FROM "user" WHERE id = ?').get('member-user'),
    { banned: 0, ban_reason: null },
  );

  const resumedCompletion = await completeDirectMembershipActivation({
    organizationId: 'organization-1',
    membershipId: started.membership.id,
    executeOperationId: prepared.executeOperation!.operationId,
    response: executedPayload,
    password: 'correct horse battery staple',
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    identity,
    verifyCertificate: async (_response, desiredQuantity) => {
      certificateVerifications += 1;
      assert.equal(desiredQuantity, 2);
    },
    now: 4_100,
  });
  assert.equal(resumedCompletion.stage, 'active');
  assert.equal(resumedCompletion.replayed, true);
  assert.equal(certificateVerifications, 2);
  assert.equal(
    (await getTeamMembershipByCandidateEmail(
      connection,
      'organization-1',
      'new.member@example.test',
    ))?.status,
    'active',
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*)
      FROM team_membership_transitions
      WHERE membership_id = ? AND to_status = 'active'
    `).pluck().get(started.membership.id),
    1,
    'crash recovery must not allocate a second active membership revision',
  );

  const panelSource = readFileSync(
    path.join(process.cwd(), 'app/components/settings/UserManagementPanel.tsx'),
    'utf8',
  );
  assert.doesNotMatch(panelSource, /authClient\.admin\.createUser/u);
  assert.match(panelSource, /\/api\/admin\/organization\/memberships/u);
  const authSource = readFileSync(path.join(process.cwd(), 'app/lib/auth.ts'), 'utf8');
  assert.match(authSource, /MEMBERSHIP_ORCHESTRATOR_REQUIRED/u);
  assert.match(authSource, /context\.path === "\/admin\/create-user"/u);
}

main()
  .then(() => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
    console.log('membership orchestrator tests passed');
  })
  .catch((error) => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
    console.error(error);
    process.exitCode = 1;
  });
