import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  beginInvitationMembershipActivation,
  completeDirectMembershipActivation,
  recordDirectMembershipSeatAuthorizationStatus,
  recordDirectMembershipSeatPreparation,
} from '../app/lib/organization/membership-orchestrator';
import {
  acceptTeamMembershipInvitation,
  createTeamMembershipInvitation,
  expireTeamMembershipInvitations,
  listTeamMembershipInvitations,
  previewTeamMembershipInvitation,
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

function invitationPrepareResponse(input: {
  desiredQuantity: number;
  authorizationId: string;
}) {
  return {
    quote: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      quoteId: '7c858925-e00b-4ba4-8062-c9fad8557c0d',
      subject: {
        type: 'license',
        licenseId: '1f9ee6ae-0f74-4314-918f-881ef4b9282c',
      },
      provider: 'stripe',
      environment: 'production',
      priceVersionId: 'price-version-invitation',
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      quantityDelta: 1,
      unitAmountCents: 1_500,
      currency: 'eur',
      billingInterval: 'month',
      immediateAmountCents: 500,
      recurringAmountCents: input.desiredQuantity * 1_500,
      status: 'active',
      expiresAt: '2026-08-01T12:00:00.000Z',
      quoteHash: 'invitation-quote-hash',
      nonBillable: false,
    },
    authorization: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      authorizationId: input.authorizationId,
      quoteId: '7c858925-e00b-4ba4-8062-c9fad8557c0d',
      quoteHash: 'invitation-quote-hash',
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      status: 'pending',
      expiresAt: '2026-08-01T12:00:00.000Z',
      approvedAt: null,
      consumedAt: null,
    },
    requiresBillingApproval: true,
    snapshot: {
      revision: 1,
      observedQuantity: input.desiredQuantity - 1,
      licensedQuantity: input.desiredQuantity - 1,
      approvedQuantity: input.desiredQuantity - 1,
      billedQuantity: input.desiredQuantity - 1,
      billingStatus: 'active',
    },
  };
}

function invitationExecuteResponse(input: {
  operationKey: string;
  desiredQuantity: number;
}) {
  return {
    operation: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      operationId: 'c08481b2-5dd2-4f40-9ef9-c41f127a6b04',
      operationKey: input.operationKey,
      operationType: 'invitation_accept',
      provider: 'stripe',
      environment: 'production',
      status: 'applied',
      paymentStatus: 'paid',
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
        licenseClass: 'commercial',
        licenseEnvironment: 'production',
        billingOrganizationId: 'organization-1',
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
  assert.equal(
    (await previewTeamMembershipInvitation({
      token: created.token,
      database: connection,
      now: 3_050,
    })).resumeRequestId,
    acceptanceRequestId,
  );

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

  const invitationActivation = await beginInvitationMembershipActivation({
    organizationId: 'organization-1',
    membershipId: accepted.membership.id,
    invitationId: accepted.invitation.id,
    database: connection,
    now: 3_300,
  });
  assert.equal(invitationActivation.stage, 'seat_prepare_pending');
  assert.equal(invitationActivation.desiredQuantity, 2);
  assert.deepEqual(JSON.parse(invitationActivation.prepareOperation.requestJson), {
    desiredQuantity: 2,
    externalReference: accepted.invitation.id,
    protocolVersion: 'canvas-team-seat-protocol-v1',
    triggerType: 'invitation_accept',
  });
  const invitationAuthorizationId = 'c66b3977-04af-468a-8d08-bad97ad48783';
  const invitationPreparedPayload = invitationPrepareResponse({
    desiredQuantity: 2,
    authorizationId: invitationAuthorizationId,
  });
  const invitationPrepared = await recordDirectMembershipSeatPreparation({
    organizationId: 'organization-1',
    membershipId: accepted.membership.id,
    prepareOperationId: invitationActivation.prepareOperation.operationId,
    response: invitationPreparedPayload,
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_400,
  });
  assert.equal(invitationPrepared.stage, 'approval_required');
  assert.equal(invitationPrepared.executeOperation, null);
  const invitationApproved = await recordDirectMembershipSeatAuthorizationStatus({
    organizationId: 'organization-1',
    membershipId: accepted.membership.id,
    response: {
      quote: invitationPreparedPayload.quote,
      authorization: {
        ...invitationPreparedPayload.authorization,
        status: 'approved',
        approvedAt: '2026-08-01T10:00:00.000Z',
      },
    },
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_500,
  });
  assert.equal(invitationApproved.activation.stage, 'seat_execute_pending');
  assert.equal(invitationApproved.activation.membership.status, 'billing_pending');
  assert.equal(
    JSON.parse(invitationApproved.activation.executeOperation!.requestJson).operationType,
    'invitation_accept',
  );
  const invitationIdentity = {
    ensurePending: async (input: {
      name: string;
      email: string;
      password: string;
      role: 'admin' | 'user';
    }) => {
      assert.equal(input.password, 'invited password');
      sqlite.prepare(`
        INSERT INTO "user" (
          id, name, email, email_verified, role, banned, ban_reason, created_at, updated_at
        ) VALUES ('invited-user', ?, ?, 1, ?, 1, 'canvas_team_membership_pending', 3600, 3600)
      `).run(input.name, input.email, input.role);
      return { id: 'invited-user', email: input.email };
    },
    activate: async (userId: string) => {
      sqlite.prepare(`
        UPDATE "user"
        SET banned = 0, ban_reason = NULL
        WHERE id = ?
      `).run(userId);
    },
  };
  const invitationExecutedPayload = invitationExecuteResponse({
    operationKey: invitationApproved.activation.executeOperation!.operationId,
    desiredQuantity: 2,
  });
  const invitationCompleted = await completeDirectMembershipActivation({
    organizationId: 'organization-1',
    membershipId: accepted.membership.id,
    executeOperationId: invitationApproved.activation.executeOperation!.operationId,
    response: invitationExecutedPayload,
    password: 'invited password',
    database: connection,
    databaseProvider: 'sqlite',
    identity: invitationIdentity,
    verifyCertificate: async (_response, desiredQuantity) => {
      assert.equal(desiredQuantity, 2);
    },
    now: 3_600,
  });
  assert.equal(invitationCompleted.stage, 'active');
  assert.equal(invitationCompleted.membership.userId, 'invited-user');
  assert.deepEqual(
    sqlite.prepare('SELECT banned, ban_reason FROM "user" WHERE id = ?').get('invited-user'),
    { banned: 0, ban_reason: null },
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*)
      FROM team_membership_transitions
      WHERE membership_id = ? AND to_status = 'active'
    `).pluck().get(accepted.membership.id),
    1,
    'successful invitation acceptance must allocate one active membership revision',
  );
  const activeReplay = await acceptTeamMembershipInvitation({
    token: created.token,
    requestId: acceptanceRequestId,
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_700,
  });
  assert.equal(activeReplay.replayed, true);
  assert.equal(activeReplay.membership.status, 'active');
  assert.equal(activeReplay.membership.userId, 'invited-user');

  const declinedCandidate = await createTeamMembershipInvitation({
    organizationId: 'organization-1',
    actorUserId: 'owner-user',
    email: 'declined@example.test',
    displayName: 'Declined Member',
    role: 'member',
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_800,
  });
  const declinedAcceptance = await acceptTeamMembershipInvitation({
    token: declinedCandidate.token,
    requestId: '98ec9a4f-01b3-4bc1-b5c4-ae335e103944',
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_810,
  });
  const declinedActivation = await beginInvitationMembershipActivation({
    organizationId: 'organization-1',
    membershipId: declinedAcceptance.membership.id,
    invitationId: declinedAcceptance.invitation.id,
    database: connection,
    now: 3_820,
  });
  await recordDirectMembershipSeatPreparation({
    organizationId: 'organization-1',
    membershipId: declinedAcceptance.membership.id,
    prepareOperationId: declinedActivation.prepareOperation.operationId,
    response: invitationPrepareResponse({
      desiredQuantity: 3,
      authorizationId: 'dc44ed59-3237-4724-a4bf-4109a92f6553',
    }),
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_830,
  });
  const declined = await revokeTeamMembershipInvitation({
    organizationId: 'organization-1',
    invitationId: declinedCandidate.invitation.id,
    actorUserId: 'owner-user',
    database: connection,
    databaseProvider: 'sqlite',
    now: 3_840,
  });
  assert.equal(declined.status, 'revoked');
  assert.equal(
    (await getTeamMembershipByCandidateEmail(
      connection,
      'organization-1',
      'declined@example.test',
    ))?.status,
    'removed',
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*)
      FROM team_seat_outbox
      WHERE membership_id = ? AND operation_kind = 'seat_execute'
    `).pluck().get(declinedAcceptance.membership.id),
    0,
    'declining an accepted invitation before execution must not enqueue billing',
  );
  const afterInvitationFlowsOutboxCount = outboxCount();

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
  assert.equal(outboxCount(), afterInvitationFlowsOutboxCount);
  assert.equal(
    sqlite.prepare(`
      SELECT current_revision
      FROM team_membership_sync_state
      WHERE organization_id = 'organization-1'
    `).pluck().get(),
    2,
    'invitation lifecycle changes must not alter the active Seat revision',
  );

  const panelSource = readFileSync(
    path.join(process.cwd(), 'app/components/settings/UserManagementPanel.tsx'),
    'utf8',
  );
  assert.match(panelSource, /memberships\/invitations/u);
  assert.match(panelSource, /createdInviteLink/u);
  assert.match(panelSource, /loadInvitationSeatQuote/u);
  const publicPageSource = readFileSync(
    path.join(process.cwd(), 'app/components/invitations/TeamInvitationAcceptancePanel.tsx'),
    'utf8',
  );
  assert.match(publicPageSource, /\/api\/organization\/invitations\/preview/u);
  assert.match(publicPageSource, /\/api\/organization\/invitations\/accept/u);
  assert.match(publicPageSource, /\/api\/organization\/invitations\/activate/u);
  assert.ok(
    publicPageSource.indexOf('/api/organization/invitations/preview')
    < publicPageSource.indexOf('/api/organization/invitations/accept'),
    'the non-mutating invitation preview must be available before explicit acceptance',
  );
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
