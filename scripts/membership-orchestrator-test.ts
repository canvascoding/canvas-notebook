import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  beginDirectMembershipSeatRequote,
  beginDirectMembershipActivation,
  beginSuspendedMembershipReactivation,
  completeDirectMembershipActivation,
  getDirectMembershipSeatQuote,
  MembershipOrchestratorError,
  recordDirectMembershipSeatAuthorizationStatus,
  recordDirectMembershipSeatExecutionApplied,
  recordDirectMembershipSeatExecutionPending,
  recordDirectMembershipSeatPreparation,
} from '../app/lib/organization/membership-orchestrator';
import { isOrganizationBillingApprover } from '../app/lib/organization/permissions';
import { SeatLimitGuardError } from '../app/lib/license/seat-limit';
import {
  adoptActiveTeamMembership,
  getActiveTeamMembershipProjection,
  getTeamMembershipByCandidateEmail,
  transitionTeamMembership,
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
  quoteId?: string;
  provider?: 'stripe' | 'manual';
  requiresBillingApproval?: boolean;
  authorizationStatus?: 'pending' | 'approved';
  expiresAt?: string;
}) {
  const quoteId = input.quoteId ?? 'd49f0ef7-92c7-4ea9-b9cc-ab3659dc4056';
  const provider = input.provider ?? 'manual';
  const requiresBillingApproval = input.requiresBillingApproval ?? false;
  const authorizationStatus = input.authorizationStatus ?? 'approved';
  const expiresAt = input.expiresAt ?? '2026-08-01T12:00:00.000Z';
  return {
    quote: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      quoteId,
      subject: {
        type: 'license',
        licenseId: '1f9ee6ae-0f74-4314-918f-881ef4b9282c',
      },
      provider,
      environment: 'production',
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      quantityDelta: 1,
      unitAmountCents: provider === 'stripe' ? 1_500 : 0,
      currency: 'eur',
      billingInterval: 'month',
      immediateAmountCents: provider === 'stripe' ? 500 : 0,
      recurringAmountCents: provider === 'stripe' ? input.desiredQuantity * 1_500 : 0,
      status: 'active',
      expiresAt,
      quoteHash: `quote-hash-${quoteId}`,
      nonBillable: provider !== 'stripe',
    },
    authorization: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      authorizationId: input.authorizationId,
      quoteId,
      quoteHash: `quote-hash-${quoteId}`,
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      status: authorizationStatus,
      expiresAt,
      approvedAt: authorizationStatus === 'approved' ? '2026-08-01T10:00:00.000Z' : null,
      consumedAt: null,
    },
    requiresBillingApproval,
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
  assert.deepEqual(
    sqlite.prepare(`
      SELECT
        role,
        status,
        can_write_team_workspace,
        can_create_public_links
      FROM organization_user_permissions
      WHERE organization_id = 'organization-1' AND user_id = 'member-user'
    `).get(),
    {
      role: 'member',
      status: 'active',
      can_write_team_workspace: 0,
      can_create_public_links: 1,
    },
    'Seat activation must provision an active organization permission atomically',
  );

  const resumedCompletion = await completeDirectMembershipActivation({
    organizationId: 'organization-1',
    membershipId: started.membership.id,
    executeOperationId: prepared.executeOperation!.operationId,
    response: {
      ...executedPayload,
      replayed: true,
    },
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

  const pendingStart = await beginDirectMembershipActivation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'billing.pending@example.test',
    displayName: 'Billing Pending',
    role: 'admin',
    database: connection,
    databaseProvider: 'sqlite',
    now: 5_000,
  });
  const pendingPayload = prepareResponse({
    desiredQuantity: 3,
    authorizationId: 'd75e5bbd-b843-4eb2-826a-72e811f78427',
    quoteId: '5270ff4a-a3c7-4836-a64b-fdaf01b6af18',
    provider: 'stripe',
    requiresBillingApproval: true,
    authorizationStatus: 'pending',
  });
  const pending = await recordDirectMembershipSeatPreparation({
    organizationId: 'organization-1',
    membershipId: pendingStart.membership.id,
    prepareOperationId: pendingStart.prepareOperation.operationId,
    response: pendingPayload,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 5_100,
  });
  assert.equal(pending.stage, 'approval_required');
  assert.equal(pending.membership.status, 'approval_required');
  assert.equal(pending.executeOperation, null);
  const storedPending = await getDirectMembershipSeatQuote({
    organizationId: 'organization-1',
    membershipId: pendingStart.membership.id,
    database: connection,
  });
  assert.equal(storedPending.preparation.quote.quantityAfter, 3);
  assert.equal(storedPending.preparation.quote.unitAmountCents, 1_500);

  const ownerPermission = {
    role: 'owner',
    status: 'active',
    canWriteTeamWorkspace: true,
    canCreatePublicLinks: true,
    canCreateTeamAutomations: true,
    canSharePluginsAndSkills: true,
    canExport: true,
    canDeleteTeamFiles: true,
    canDeleteStudioAssets: true,
    canManageBackups: true,
    canMigrateDatabase: true,
    canEnableKnowledge: true,
    canManageOrganizationMemory: true,
    canRecoverWorkspaces: true,
  } as const;
  assert.equal(isOrganizationBillingApprover(ownerPermission), true);
  assert.equal(isOrganizationBillingApprover({ ...ownerPermission, role: 'admin' }), false);

  const tamperedStatus = {
    quote: {
      ...pendingPayload.quote,
      quantityAfter: 4,
      quantityDelta: 2,
    },
    authorization: pendingPayload.authorization,
  };
  await assert.rejects(
    recordDirectMembershipSeatAuthorizationStatus({
      organizationId: 'organization-1',
      membershipId: pendingStart.membership.id,
      response: tamperedStatus,
      actorUserId: 'owner-user',
      database: connection,
      databaseProvider: 'sqlite',
      now: 5_200,
    }),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'MEMBERSHIP_SEAT_RESPONSE_INVALID'
    ),
  );

  const approvedStatus = {
    quote: pendingPayload.quote,
    authorization: {
      ...pendingPayload.authorization,
      status: 'approved',
      approvedAt: '2026-08-01T10:05:00.000Z',
    },
  };
  const approved = await recordDirectMembershipSeatAuthorizationStatus({
    organizationId: 'organization-1',
    membershipId: pendingStart.membership.id,
    response: approvedStatus,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 5_300,
  });
  assert.equal(approved.activation.stage, 'seat_execute_pending');
  assert.equal(approved.activation.membership.status, 'billing_pending');
  assert.ok(approved.activation.executeOperation);
  const requiresActionPayload = {
    operation: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      operationId: 'd9916299-1906-49b2-83d1-04c164190e24',
      operationKey: approved.activation.executeOperation!.operationId,
      operationType: 'member_create',
      provider: 'stripe',
      environment: 'production',
      status: 'requires_action',
      paymentStatus: 'requires_action',
      previousQuantity: 2,
      requestedQuantity: 3,
      effectiveQuantity: null,
      retryCount: 0,
      lastError: null,
      effectiveAt: null,
      entitlementsVersion: null,
      certificateReissueStatus: 'pending',
      createdAt: '2026-08-01T10:06:00.000Z',
      updatedAt: '2026-08-01T10:06:00.000Z',
    },
    replayed: false,
    license: null,
  };
  const billingPending = await recordDirectMembershipSeatExecutionPending({
    organizationId: 'organization-1',
    membershipId: pendingStart.membership.id,
    executeOperationId: approved.activation.executeOperation!.operationId,
    response: requiresActionPayload,
    database: connection,
    now: 5_400,
  });
  assert.equal(billingPending.activation.stage, 'billing_pending');
  assert.equal(billingPending.activation.membership.status, 'billing_pending');
  assert.equal(billingPending.activation.executeOperation?.status, 'retry_wait');
  assert.equal(billingPending.activation.executeOperation?.attemptCount, 1);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?').pluck().get('billing.pending@example.test'),
    0,
    'requires_action must not create or activate a Better Auth user',
  );
  const paymentFailedPayload = {
    ...requiresActionPayload,
    operation: {
      ...requiresActionPayload.operation,
      status: 'failed',
      paymentStatus: 'payment_failed',
      lastError: 'The payment method was declined.',
      certificateReissueStatus: 'failed',
      updatedAt: '2026-08-01T10:06:30.000Z',
    },
  };
  const paymentFailed = await recordDirectMembershipSeatExecutionPending({
    organizationId: 'organization-1',
    membershipId: pendingStart.membership.id,
    executeOperationId: approved.activation.executeOperation!.operationId,
    response: paymentFailedPayload,
    database: connection,
    now: 5_500,
  });
  assert.equal(paymentFailed.activation.stage, 'billing_pending');
  assert.equal(paymentFailed.activation.membership.status, 'billing_pending');
  assert.equal(paymentFailed.execution.operation.status, 'failed');
  assert.equal(paymentFailed.execution.operation.paymentStatus, 'payment_failed');
  assert.equal(paymentFailed.execution.license, null);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?').pluck().get('billing.pending@example.test'),
    0,
    'payment_failed must not create or activate a Better Auth user',
  );
  assert.equal(
    (await getActiveTeamMembershipProjection(connection, 'organization-1')).observedQuantity,
    2,
    'payment_failed must not increase the active Seat projection',
  );

  const staleStart = await beginDirectMembershipActivation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'stale.quote@example.test',
    displayName: 'Stale Quote',
    role: 'member',
    database: connection,
    databaseProvider: 'sqlite',
    now: 6_000,
  });
  const stalePayload = prepareResponse({
    desiredQuantity: 3,
    authorizationId: 'f122c818-96af-4915-ac2b-13c0d08c0941',
    quoteId: '4bab2bc9-8992-4997-ac34-9d77107512f8',
    provider: 'stripe',
    requiresBillingApproval: true,
    authorizationStatus: 'pending',
    expiresAt: '2026-08-01T10:10:00.000Z',
  });
  await recordDirectMembershipSeatPreparation({
    organizationId: 'organization-1',
    membershipId: staleStart.membership.id,
    prepareOperationId: staleStart.prepareOperation.operationId,
    response: stalePayload,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 6_100,
  });
  const expiredStatus = {
    quote: {
      ...stalePayload.quote,
      status: 'expired',
    },
    authorization: {
      ...stalePayload.authorization,
      status: 'expired',
    },
  };
  const requoted = await beginDirectMembershipSeatRequote({
    organizationId: 'organization-1',
    membershipId: staleStart.membership.id,
    staleQuoteId: stalePayload.quote.quoteId,
    currentResponse: expiredStatus,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 6_200,
  });
  assert.equal(requoted.stage, 'seat_prepare_pending');
  assert.notEqual(requoted.prepareOperation.operationId, staleStart.prepareOperation.operationId);
  assert.equal(JSON.parse(requoted.prepareOperation.requestJson).desiredQuantity, 3);

  const activeMember = await getTeamMembershipByCandidateEmail(
    connection,
    'organization-1',
    'new.member@example.test',
  );
  assert.ok(activeMember?.userId);
  sqlite.prepare(`
    UPDATE "user"
    SET banned = 1, ban_reason = 'canvas_team_membership_suspended:Administrative suspension'
    WHERE id = ?
  `).run(activeMember.userId);
  const suspended = await transitionTeamMembership(connection, {
    organizationId: 'organization-1',
    membershipId: activeMember.id,
    expectedStatus: 'active',
    toStatus: 'suspended',
    actorUserId: 'owner-user',
    source: 'local_admin',
    reason: 'Administrative suspension',
    seatOperationType: 'member_remove',
    enqueueSeatReduction: true,
    databaseProvider: 'sqlite',
    now: 7_000,
  });
  assert.equal(suspended.status, 'suspended');
  assert.equal((await getActiveTeamMembershipProjection(connection, 'organization-1')).observedQuantity, 1);

  const reactivationStart = await beginSuspendedMembershipReactivation({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    actorUserId: 'owner-user',
    database: connection,
    now: 7_100,
  });
  assert.equal(reactivationStart.stage, 'seat_prepare_pending');
  assert.equal(reactivationStart.membership.status, 'suspended');
  assert.equal(reactivationStart.observedQuantity, 1);
  assert.equal(reactivationStart.desiredQuantity, 2);
  assert.equal(reactivationStart.prepareOperation.operationType, 'member_create');
  assert.match(reactivationStart.prepareOperation.dedupeKey, /:reactivation:/u);
  const resumedReactivation = await beginSuspendedMembershipReactivation({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    actorUserId: 'owner-user',
    database: connection,
    now: 7_200,
  });
  assert.equal(resumedReactivation.replayed, true);
  assert.equal(
    resumedReactivation.prepareOperation.operationId,
    reactivationStart.prepareOperation.operationId,
  );

  const reactivationPrepare = prepareResponse({
    desiredQuantity: 2,
    authorizationId: '91c37528-c568-4b8e-91f8-5e8552a38c01',
    quoteId: '0998e69e-75de-48c1-a246-fe70b8a153e6',
    provider: 'stripe',
    requiresBillingApproval: true,
    authorizationStatus: 'pending',
  });
  const reactivationApproval = await recordDirectMembershipSeatPreparation({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    prepareOperationId: reactivationStart.prepareOperation.operationId,
    response: reactivationPrepare,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 7_300,
  });
  assert.equal(reactivationApproval.stage, 'approval_required');
  assert.equal(reactivationApproval.membership.status, 'suspended');
  assert.equal(reactivationApproval.executeOperation, null);

  const approvedReactivation = await recordDirectMembershipSeatAuthorizationStatus({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    response: {
      quote: reactivationPrepare.quote,
      authorization: {
        ...reactivationPrepare.authorization,
        status: 'approved',
        approvedAt: '2026-08-01T10:20:00.000Z',
      },
    },
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 7_400,
  });
  assert.equal(approvedReactivation.activation.stage, 'seat_execute_pending');
  assert.equal(approvedReactivation.activation.membership.status, 'suspended');
  assert.ok(approvedReactivation.activation.executeOperation);

  const reactivationPending = await recordDirectMembershipSeatExecutionPending({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    executeOperationId: approvedReactivation.activation.executeOperation!.operationId,
    response: {
      operation: {
        protocolVersion: 'canvas-team-seat-protocol-v1',
        operationId: '7d996e64-c3ef-4b82-8ba6-d37d75fe32d2',
        operationKey: approvedReactivation.activation.executeOperation!.operationId,
        operationType: 'member_create',
        provider: 'stripe',
        environment: 'production',
        status: 'requires_action',
        paymentStatus: 'requires_action',
        previousQuantity: 1,
        requestedQuantity: 2,
        effectiveQuantity: null,
        retryCount: 0,
        lastError: null,
        effectiveAt: null,
        entitlementsVersion: null,
        certificateReissueStatus: 'pending',
        createdAt: '2026-08-01T10:21:00.000Z',
        updatedAt: '2026-08-01T10:21:00.000Z',
      },
      replayed: false,
      license: null,
    },
    database: connection,
    now: 7_500,
  });
  assert.equal(reactivationPending.activation.stage, 'billing_pending');
  assert.equal(reactivationPending.activation.membership.status, 'suspended');
  assert.deepEqual(
    sqlite.prepare('SELECT banned, ban_reason FROM "user" WHERE id = ?').get(activeMember.userId),
    {
      banned: 1,
      ban_reason: 'canvas_team_membership_suspended:Administrative suspension',
    },
  );

  const activeTransitionCountBefore = Number(sqlite.prepare(`
    SELECT COUNT(*)
    FROM team_membership_transitions
    WHERE membership_id = ? AND to_status = 'active'
  `).pluck().get(suspended.id));
  let reactivationIdentityCreations = 0;
  let reactivationIdentityActivations = 0;
  const reactivationIdentity = {
    ensurePending: async () => {
      reactivationIdentityCreations += 1;
      throw new Error('reactivation must reuse the existing Better Auth identity');
    },
    activate: async (userId: string) => {
      reactivationIdentityActivations += 1;
      sqlite.prepare(`
        UPDATE "user"
        SET banned = 0, ban_reason = NULL
        WHERE id = ?
          AND ban_reason LIKE 'canvas_team_membership_suspended:%'
      `).run(userId);
    },
  };
  const reactivationExecution = executeResponse({
    operationKey: approvedReactivation.activation.executeOperation!.operationId,
    desiredQuantity: 2,
  });
  const workerPersistedExecution = await recordDirectMembershipSeatExecutionApplied({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    executeOperationId: approvedReactivation.activation.executeOperation!.operationId,
    response: reactivationExecution,
    database: connection,
    verifyCertificate: async (_response, desiredQuantity) => {
      assert.equal(desiredQuantity, 2);
    },
    now: 7_550,
  });
  assert.equal(workerPersistedExecution.status, 'succeeded');
  assert.equal(
    (await getTeamMembershipByCandidateEmail(
      connection,
      'organization-1',
      suspended.candidateEmail,
    ))?.status,
    'suspended',
    'background billing recovery must not activate identity access without the local activation step',
  );
  assert.equal(reactivationIdentityCreations, 0);
  assert.equal(reactivationIdentityActivations, 0);
  const reactivated = await completeDirectMembershipActivation({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    executeOperationId: approvedReactivation.activation.executeOperation!.operationId,
    response: reactivationExecution,
    password: '',
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    identity: reactivationIdentity,
    verifyCertificate: async (_response, desiredQuantity) => {
      assert.equal(desiredQuantity, 2);
    },
    now: 7_600,
  });
  assert.equal(reactivated.stage, 'active');
  assert.equal(reactivated.membership.userId, activeMember.userId);
  assert.equal(reactivationIdentityCreations, 0);
  assert.equal(reactivationIdentityActivations, 1);
  assert.equal((await getActiveTeamMembershipProjection(connection, 'organization-1')).observedQuantity, 2);
  assert.equal(
    Number(sqlite.prepare(`
      SELECT COUNT(*)
      FROM team_membership_transitions
      WHERE membership_id = ? AND to_status = 'active'
    `).pluck().get(suspended.id)),
    activeTransitionCountBefore + 1,
  );

  const replayedReactivation = await completeDirectMembershipActivation({
    organizationId: 'organization-1',
    membershipId: suspended.id,
    executeOperationId: approvedReactivation.activation.executeOperation!.operationId,
    response: {
      ...reactivationExecution,
      replayed: true,
    },
    password: '',
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    identity: reactivationIdentity,
    verifyCertificate: async (_response, desiredQuantity) => {
      assert.equal(desiredQuantity, 2);
    },
    now: 7_700,
  });
  assert.equal(replayedReactivation.stage, 'active');
  assert.equal(replayedReactivation.replayed, true);
  assert.equal(reactivationIdentityCreations, 0);
  assert.equal(reactivationIdentityActivations, 2);
  assert.equal(
    Number(sqlite.prepare(`
      SELECT COUNT(*)
      FROM team_membership_transitions
      WHERE membership_id = ? AND to_status = 'active'
    `).pluck().get(suspended.id)),
    activeTransitionCountBefore + 1,
    'a reactivation replay must not create another active transition or Seat revision',
  );

  insertUser({
    id: 'racing-member-user',
    name: 'Racing Member',
    email: 'racing.member@example.test',
    role: 'user',
    now: 7_800,
  });
  await adoptActiveTeamMembership(connection, {
    organizationId: 'organization-1',
    userId: 'racing-member-user',
    role: 'member',
    source: 'migration',
    actorUserId: 'owner-user',
    seatOperationType: 'reconcile',
    databaseProvider: 'sqlite',
    now: 7_800,
  });
  assert.equal(
    (await getActiveTeamMembershipProjection(connection, 'organization-1')).observedQuantity,
    3,
  );
  let staleReplayIdentityActivated = false;
  await assert.rejects(
    completeDirectMembershipActivation({
      organizationId: 'organization-1',
      membershipId: started.membership.id,
      executeOperationId: prepared.executeOperation!.operationId,
      response: {
        ...executedPayload,
        replayed: true,
      },
      password: 'correct horse battery staple',
      actorUserId: 'owner-user',
      database: connection,
      databaseProvider: 'sqlite',
      identity: {
        ensurePending: async () => {
          throw new Error('an active replay must not create another identity');
        },
        activate: async () => {
          staleReplayIdentityActivated = true;
        },
      },
      verifyCertificate: async (_response, desiredQuantity) => {
        assert.equal(desiredQuantity, 2);
      },
      now: 7_850,
    }),
    (error: unknown) => (
      error instanceof MembershipOrchestratorError
      && error.code === 'MEMBERSHIP_SIGNED_LIMIT_INVALID'
    ),
  );
  assert.equal(
    staleReplayIdentityActivated,
    false,
    'a stale successful replay must validate the current projection before enabling identity access',
  );
  const staleIdentity = {
    ensurePending: async (input: {
      name: string;
      email: string;
      password: string;
      role: 'admin' | 'user';
    }) => {
      assert.equal(input.email, 'billing.pending@example.test');
      insertUser({
        id: 'billing-pending-user',
        name: input.name,
        email: input.email,
        role: input.role,
        banned: 1,
        banReason: 'canvas_team_membership_pending',
        now: 7_900,
      });
      return {
        id: 'billing-pending-user',
        email: input.email,
      };
    },
    activate: async () => {
      throw new Error('a stale activation must not enable the pending identity');
    },
  };
  await assert.rejects(
    completeDirectMembershipActivation({
      organizationId: 'organization-1',
      membershipId: pendingStart.membership.id,
      executeOperationId: approved.activation.executeOperation!.operationId,
      response: executeResponse({
        operationKey: approved.activation.executeOperation!.operationId,
        desiredQuantity: 3,
      }),
      password: 'correct horse battery staple',
      actorUserId: 'owner-user',
      database: connection,
      databaseProvider: 'sqlite',
      identity: staleIdentity,
      verifyCertificate: async (_response, desiredQuantity) => {
        assert.equal(desiredQuantity, 3);
      },
      now: 7_900,
    }),
    (error: unknown) => (
      error instanceof SeatLimitGuardError
      && error.code === 'SEAT_LIMIT_EXCEEDED'
    ),
  );
  assert.equal(
    (await getTeamMembershipByCandidateEmail(
      connection,
      'organization-1',
      'billing.pending@example.test',
    ))?.status,
    'billing_pending',
    'a stale concurrent activation must roll back without increasing the active projection',
  );
  assert.deepEqual(
    sqlite.prepare('SELECT banned, ban_reason FROM "user" WHERE id = ?').get('billing-pending-user'),
    {
      banned: 1,
      ban_reason: 'canvas_team_membership_pending',
    },
  );
  assert.equal(
    (await getActiveTeamMembershipProjection(connection, 'organization-1')).observedQuantity,
    3,
  );

  const panelSource = readFileSync(
    path.join(process.cwd(), 'app/components/settings/UserManagementPanel.tsx'),
    'utf8',
  );
  assert.doesNotMatch(panelSource, /authClient\.admin\.createUser/u);
  assert.doesNotMatch(panelSource, /authClient\.admin\.unbanUser/u);
  assert.match(panelSource, /\/api\/admin\/organization\/memberships/u);
  assert.match(
    panelSource,
    /users\/\$\{encodeURIComponent\(user\.id\)\}\/reactivation/u,
  );
  assert.doesNotMatch(
    panelSource,
    /body:\s*JSON\.stringify\(\{[^}]*\b(?:quantity|price|quoteHash)\b/u,
    'the browser must not submit billable Seat quantity, price, or quote hashes',
  );
  const quoteRouteSource = readFileSync(
    path.join(
      process.cwd(),
      'app/api/admin/organization/memberships/[membershipId]/quote/route.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(
    quoteRouteSource,
    /request\.json\(/u,
    'requotes must derive all billable fields from persisted server state',
  );
  const activationRouteSource = readFileSync(
    path.join(
      process.cwd(),
      'app/api/admin/organization/memberships/[membershipId]/activate/route.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(
    activationRouteSource,
    /\b(?:quantity|price|quoteHash)\s*:\s*body\./u,
    'Seat execution must not accept billable fields from the browser',
  );
  const activationServiceSource = readFileSync(
    path.join(process.cwd(), 'app/lib/organization/membership-seat-activation.ts'),
    'utf8',
  );
  const identityPreflightIndex = activationServiceSource.indexOf(
    'assertTeamMembershipIdentityAvailable(',
  );
  const seatExecutionIndex = activationServiceSource.indexOf(
    'executeCommunityTeamSeatChange(',
    identityPreflightIndex,
  );
  const membershipCompletionIndex = activationServiceSource.indexOf(
    'completeDirectMembershipActivation({',
    seatExecutionIndex,
  );
  const onboardingIndex = activationServiceSource.indexOf(
    'initializeUserOnboarding(',
    membershipCompletionIndex,
  );
  assert.ok(identityPreflightIndex > 0);
  assert.ok(seatExecutionIndex > identityPreflightIndex);
  assert.ok(membershipCompletionIndex > seatExecutionIndex);
  assert.ok(
    onboardingIndex > membershipCompletionIndex,
    'onboarding must start only after confirmed Seat and membership activation',
  );
  const authSource = readFileSync(path.join(process.cwd(), 'app/lib/auth.ts'), 'utf8');
  assert.match(authSource, /MEMBERSHIP_ORCHESTRATOR_REQUIRED/u);
  assert.match(authSource, /context\.path === "\/admin\/create-user"/u);
  assert.match(authSource, /assertTeamMembershipIdentityReactivatable/u);
  assert.match(authSource, /isTeamMembershipReactivationBanReason/u);
  assert.match(authSource, /auth\.api\.setUserPassword/u);
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
