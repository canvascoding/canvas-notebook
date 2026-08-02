import 'server-only';

import {
  activatePendingTeamMembershipIdentity,
  ensurePendingTeamMembershipIdentity,
} from '@/app/lib/auth';
import type { SqlConnection } from '@/app/lib/db';
import { openDb } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import { activateLicenseCert } from '@/app/lib/license';
import { assertSeatActivationCapacity } from '@/app/lib/license/seat-limit';
import {
  createTeamSeatExecuteRequest,
  createTeamSeatPrepareRequest,
  parseTeamSeatExecuteResponse,
  parseTeamSeatPrepareResponse,
  parseTeamSeatQuoteStatusResponse,
  type TeamSeatExecuteResponse,
  type TeamSeatPrepareResponse,
  type TeamSeatQuoteStatusResponse,
} from '@/app/lib/license/team-seat-contract';
import {
  enqueueTeamSeatOutboxOperation,
  getTeamMembershipSyncState,
  getTeamSeatOutboxOperation,
  recordTeamSeatOutboxOperationPending,
  recordTeamSeatOutboxOperationSuccess,
  type TeamSeatOutboxOperation,
} from '@/app/lib/license/team-seat-outbox';
import {
  createTeamMembershipCandidate,
  getActiveTeamMembershipProjection,
  getTeamMembershipByCandidateEmail,
  getTeamMembershipById,
  linkTeamMembershipControlPlaneOperation,
  normalizeTeamMembershipCandidateEmail,
  transitionTeamMembership,
  type TeamMembership,
  type TeamMembershipRole,
} from './team-membership';

type MembershipOrchestratorDatabase = Pick<SqlConnection, 'get' | 'run' | 'all' | 'close'>;

export type MembershipActivationStage =
  | 'seat_prepare_pending'
  | 'approval_required'
  | 'seat_execute_pending'
  | 'billing_pending'
  | 'active';

export type MembershipActivation = {
  stage: MembershipActivationStage;
  membership: TeamMembership;
  desiredQuantity: number;
  observedQuantity: number;
  prepareOperation: TeamSeatOutboxOperation;
  executeOperation: TeamSeatOutboxOperation | null;
  requiresBillingApproval: boolean | null;
  replayed: boolean;
};

export class MembershipOrchestratorError extends Error {
  constructor(
    public readonly code:
      | 'MEMBERSHIP_OPERATION_CONFLICT'
      | 'MEMBERSHIP_OPERATION_NOT_FOUND'
      | 'MEMBERSHIP_SEAT_RESPONSE_INVALID'
      | 'MEMBERSHIP_SEAT_NOT_CONFIRMED'
      | 'MEMBERSHIP_SIGNED_LIMIT_INVALID'
      | 'MEMBERSHIP_QUOTE_STILL_ACTIVE',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'MembershipOrchestratorError';
  }
}

async function rollbackQuietly(database: Pick<SqlConnection, 'run'>): Promise<void> {
  try {
    await database.run('ROLLBACK');
  } catch {
    return;
  }
}

async function withActivationTransaction<T>(
  database: Pick<SqlConnection, 'run'>,
  databaseProvider: DatabaseProvider,
  operation: () => Promise<T>,
): Promise<T> {
  await database.run(databaseProvider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = await operation();
    await database.run('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(database);
    throw error;
  }
}

function parsePrepareRequest(operation: TeamSeatOutboxOperation) {
  const operationType = operation.operationType;
  const value = JSON.parse(operation.requestJson) as {
    desiredQuantity?: unknown;
    triggerType?: unknown;
    externalReference?: unknown;
  };
  if (
    (operationType !== 'member_create' && operationType !== 'invitation_accept')
    || value.triggerType !== operationType
    || typeof value.externalReference !== 'string'
    || (
      operationType === 'member_create'
      && value.externalReference !== operation.membershipId
    )
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_CONFLICT',
      'The persisted Seat preparation request is invalid.',
    );
  }
  return createTeamSeatPrepareRequest({
    desiredQuantity: Number(value.desiredQuantity),
    triggerType: operationType,
    externalReference: value.externalReference,
  });
}

export function getMembershipSeatPrepareRequest(operation: TeamSeatOutboxOperation) {
  return parsePrepareRequest(operation);
}

function parseExecuteRequest(operation: TeamSeatOutboxOperation) {
  const value = JSON.parse(operation.requestJson) as {
    authorizationId?: unknown;
    operationKey?: unknown;
    operationType?: unknown;
  };
  if (
    typeof value.authorizationId !== 'string'
    || typeof value.operationKey !== 'string'
    || (
      value.operationType !== 'member_create'
      && value.operationType !== 'invitation_accept'
    )
    || value.operationType !== operation.operationType
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_CONFLICT',
      'The persisted Seat execution request is invalid.',
    );
  }
  return createTeamSeatExecuteRequest({
    authorizationId: value.authorizationId,
    operationKey: value.operationKey,
    operationType: value.operationType,
  });
}

export function getMembershipSeatExecuteRequest(operation: TeamSeatOutboxOperation) {
  return parseExecuteRequest(operation);
}

function assertPendingCandidateMatches(
  membership: TeamMembership,
  input: { displayName: string; role: TeamMembershipRole },
): void {
  if (
    !['approval_required', 'billing_pending'].includes(membership.status)
    || membership.userId !== null
    || membership.externalInvitationId !== null
    || membership.displayName !== input.displayName
    || membership.role !== input.role
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_CONFLICT',
      'This email already belongs to another membership lifecycle.',
    );
  }
}

async function requireMembershipOperation(
  database: MembershipOrchestratorDatabase,
  input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    kind: 'seat_prepare' | 'seat_execute';
  },
): Promise<TeamSeatOutboxOperation> {
  const operation = await getTeamSeatOutboxOperation(database, input.operationId);
  if (
    !operation
    || operation.organizationId !== input.organizationId
    || operation.membershipId !== input.membershipId
    || operation.operationKind !== input.kind
    || !['member_create', 'invitation_accept'].includes(operation.operationType || '')
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_NOT_FOUND',
      'The membership Seat operation was not found.',
      404,
    );
  }
  return operation;
}

async function latestMembershipPrepareOperation(
  database: MembershipOrchestratorDatabase,
  organizationId: string,
  membershipId: string,
): Promise<TeamSeatOutboxOperation | null> {
  const row = await database.get(`
    SELECT operation_id
    FROM team_seat_outbox
    WHERE organization_id = ?
      AND membership_id = ?
      AND operation_kind = 'seat_prepare'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [organizationId, membershipId]) as { operation_id: string } | undefined;
  return row
    ? getTeamSeatOutboxOperation(database, row.operation_id)
    : null;
}

function assertPreparedResponse(
  operation: TeamSeatOutboxOperation,
  prepared: TeamSeatPrepareResponse,
): ReturnType<typeof parsePrepareRequest> {
  const request = parsePrepareRequest(operation);
  if (
    prepared.quote.quantityAfter !== request.desiredQuantity
    || prepared.authorization.quantityAfter !== request.desiredQuantity
    || prepared.quote.quantityBefore !== prepared.authorization.quantityBefore
    || prepared.quote.quoteHash !== prepared.authorization.quoteHash
    || prepared.snapshot.observedQuantity !== prepared.quote.quantityBefore
    || prepared.snapshot.licensedQuantity !== prepared.quote.quantityBefore
    || (prepared.requiresBillingApproval && prepared.authorization.status !== 'pending')
    || (!prepared.requiresBillingApproval && prepared.authorization.status !== 'approved')
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_SEAT_RESPONSE_INVALID',
      'The Control Plane Seat preparation does not match the server-calculated membership change.',
      502,
    );
  }
  return request;
}

function assertQuoteStatusMatchesPreparation(
  prepared: TeamSeatPrepareResponse,
  current: TeamSeatQuoteStatusResponse,
): void {
  const quoteMatches = (
    prepared.quote.quoteId === current.quote.quoteId
    && prepared.quote.provider === current.quote.provider
    && prepared.quote.environment === current.quote.environment
    && prepared.quote.priceVersionId === current.quote.priceVersionId
    && prepared.quote.quantityBefore === current.quote.quantityBefore
    && prepared.quote.quantityAfter === current.quote.quantityAfter
    && prepared.quote.quantityDelta === current.quote.quantityDelta
    && prepared.quote.unitAmountCents === current.quote.unitAmountCents
    && prepared.quote.currency === current.quote.currency
    && prepared.quote.billingInterval === current.quote.billingInterval
    && prepared.quote.immediateAmountCents === current.quote.immediateAmountCents
    && prepared.quote.recurringAmountCents === current.quote.recurringAmountCents
    && prepared.quote.expiresAt === current.quote.expiresAt
    && prepared.quote.quoteHash === current.quote.quoteHash
    && prepared.quote.nonBillable === current.quote.nonBillable
  );
  if (
    !quoteMatches
    || prepared.quote.subject.type !== current.quote.subject.type
    || (
      prepared.quote.subject.type === 'license'
      && (
        current.quote.subject.type !== 'license'
        || prepared.quote.subject.licenseId !== current.quote.subject.licenseId
      )
    )
    || (
      prepared.quote.subject.type === 'organization'
      && (
        current.quote.subject.type !== 'organization'
        || prepared.quote.subject.organizationId !== current.quote.subject.organizationId
      )
    )
    || prepared.authorization.authorizationId !== current.authorization.authorizationId
    || prepared.authorization.quoteId !== current.authorization.quoteId
    || prepared.authorization.quoteHash !== current.authorization.quoteHash
    || prepared.authorization.quantityBefore !== current.authorization.quantityBefore
    || prepared.authorization.quantityAfter !== current.authorization.quantityAfter
    || prepared.authorization.expiresAt !== current.authorization.expiresAt
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_SEAT_RESPONSE_INVALID',
      'The current Control Plane authorization does not match the locally displayed Seat quote.',
      502,
    );
  }
}

async function enqueueMembershipSeatExecution(
  database: MembershipOrchestratorDatabase,
  input: {
    organizationId: string;
    membership: TeamMembership;
    prepareOperation: TeamSeatOutboxOperation;
    authorizationId: string;
    now: number;
  },
): Promise<TeamSeatOutboxOperation> {
  const executeRequest = createTeamSeatExecuteRequest({
    authorizationId: input.authorizationId,
    operationKey: input.authorizationId,
    operationType: input.prepareOperation.operationType!,
  });
  return (await enqueueTeamSeatOutboxOperation(database, {
    organizationId: input.organizationId,
    operationId: input.authorizationId,
    dedupeKey: `membership:${input.membership.id}:seat-execute:${input.authorizationId}`,
    operationKind: 'seat_execute',
    operationType: input.prepareOperation.operationType,
    membershipId: input.membership.id,
    membershipRevision: input.prepareOperation.membershipRevision,
    request: executeRequest,
    now: input.now,
    nextAttemptAt: input.now,
  })).operation;
}

export async function beginDirectMembershipActivation(input: {
  organizationId: string;
  actorUserId: string;
  email: string;
  displayName: string;
  role: Extract<TeamMembershipRole, 'admin' | 'member'>;
  database?: MembershipOrchestratorDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<MembershipActivation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  const email = normalizeTeamMembershipCandidateEmail(input.email);
  const displayName = input.displayName.trim().slice(0, 200);
  if (!displayName) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_CONFLICT',
      'A display name is required for membership activation.',
      400,
    );
  }

  try {
    let membership = await getTeamMembershipByCandidateEmail(
      database,
      input.organizationId,
      email,
    );
    let replayed = Boolean(membership);
    if (membership) {
      assertPendingCandidateMatches(membership, {
        displayName,
        role: input.role,
      });
    } else {
      try {
        membership = await createTeamMembershipCandidate(database, {
          organizationId: input.organizationId,
          email,
          displayName,
          role: input.role,
          status: 'approval_required',
          invitedByUserId: input.actorUserId,
          source: 'local_admin',
          reason: 'direct_membership_activation_started',
          metadata: { operationType: 'member_create' },
          now,
          databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
        });
      } catch (error) {
        membership = await getTeamMembershipByCandidateEmail(
          database,
          input.organizationId,
          email,
        );
        if (!membership) throw error;
        assertPendingCandidateMatches(membership, {
          displayName,
          role: input.role,
        });
        replayed = true;
      }
    }

    const projection = await getActiveTeamMembershipProjection(database, input.organizationId);
    const desiredQuantity = projection.observedQuantity + 1;
    const syncState = await getTeamMembershipSyncState(database, input.organizationId);
    const request = createTeamSeatPrepareRequest({
      desiredQuantity,
      triggerType: 'member_create',
      externalReference: membership.id,
    });
    const enqueued = await enqueueTeamSeatOutboxOperation(database, {
      organizationId: input.organizationId,
      dedupeKey: `membership:${membership.id}:seat-prepare`,
      operationKind: 'seat_prepare',
      operationType: 'member_create',
      membershipId: membership.id,
      membershipRevision: syncState?.currentRevision ?? 0,
      request,
      now,
      nextAttemptAt: now,
    });
    const prepareOperation = enqueued.replayed
      ? await latestMembershipPrepareOperation(database, input.organizationId, membership.id)
      : enqueued.operation;
    if (!prepareOperation) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The persisted Seat preparation operation was not found.',
        404,
      );
    }

    return {
      stage: 'seat_prepare_pending',
      membership,
      desiredQuantity,
      observedQuantity: projection.observedQuantity,
      prepareOperation,
      executeOperation: null,
      requiresBillingApproval: null,
      replayed: replayed || enqueued.replayed,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function beginInvitationMembershipActivation(input: {
  organizationId: string;
  membershipId: string;
  invitationId: string;
  database?: MembershipOrchestratorDatabase;
  now?: number;
}): Promise<MembershipActivation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  try {
    const membership = await getTeamMembershipById(
      database,
      input.organizationId,
      input.membershipId,
    );
    if (
      !membership
      || membership.status !== 'approval_required'
      || membership.userId !== null
      || membership.externalInvitationId !== input.invitationId
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        'The accepted invitation does not match an approval-pending membership.',
      );
    }
    const projection = await getActiveTeamMembershipProjection(database, input.organizationId);
    const desiredQuantity = projection.observedQuantity + 1;
    const syncState = await getTeamMembershipSyncState(database, input.organizationId);
    const request = createTeamSeatPrepareRequest({
      desiredQuantity,
      triggerType: 'invitation_accept',
      externalReference: input.invitationId,
    });
    const enqueued = await enqueueTeamSeatOutboxOperation(database, {
      organizationId: input.organizationId,
      dedupeKey: `invitation:${input.invitationId}:seat-prepare`,
      operationKind: 'seat_prepare',
      operationType: 'invitation_accept',
      membershipId: input.membershipId,
      membershipRevision: syncState?.currentRevision ?? 0,
      request,
      now,
      nextAttemptAt: now,
    });
    const prepareOperation = enqueued.replayed
      ? await latestMembershipPrepareOperation(database, input.organizationId, input.membershipId)
      : enqueued.operation;
    if (!prepareOperation) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The persisted invitation Seat preparation was not found.',
        404,
      );
    }
    return {
      stage: 'seat_prepare_pending',
      membership,
      desiredQuantity,
      observedQuantity: projection.observedQuantity,
      prepareOperation,
      executeOperation: null,
      requiresBillingApproval: null,
      replayed: enqueued.replayed,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function beginSuspendedMembershipReactivation(input: {
  organizationId: string;
  membershipId: string;
  actorUserId: string;
  database?: MembershipOrchestratorDatabase;
  now?: number;
}): Promise<MembershipActivation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  try {
    const membership = await getTeamMembershipById(
      database,
      input.organizationId,
      input.membershipId,
    );
    if (
      !membership
      || membership.status !== 'suspended'
      || membership.userId === null
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        'Only a suspended membership with an existing identity can be reactivated.',
      );
    }
    const projection = await getActiveTeamMembershipProjection(database, input.organizationId);
    const desiredQuantity = projection.observedQuantity + 1;
    const syncState = await getTeamMembershipSyncState(database, input.organizationId);
    if (!syncState) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        'The suspended membership does not have a Seat revision.',
      );
    }
    const request = createTeamSeatPrepareRequest({
      desiredQuantity,
      triggerType: 'member_create',
      externalReference: membership.id,
    });
    const enqueued = await enqueueTeamSeatOutboxOperation(database, {
      organizationId: input.organizationId,
      dedupeKey: `membership:${membership.id}:reactivation:${syncState.currentRevision}:seat-prepare`,
      operationKind: 'seat_prepare',
      operationType: 'member_create',
      membershipId: membership.id,
      membershipRevision: syncState.currentRevision,
      request,
      now,
      nextAttemptAt: now,
    });
    return {
      stage: 'seat_prepare_pending',
      membership,
      desiredQuantity,
      observedQuantity: projection.observedQuantity,
      prepareOperation: enqueued.operation,
      executeOperation: null,
      requiresBillingApproval: null,
      replayed: enqueued.replayed,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function recordDirectMembershipSeatPreparation(input: {
  organizationId: string;
  membershipId: string;
  prepareOperationId: string;
  response: unknown;
  actorUserId?: string | null;
  database?: MembershipOrchestratorDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<MembershipActivation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  try {
    const operation = await requireMembershipOperation(database, {
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      operationId: input.prepareOperationId,
      kind: 'seat_prepare',
    });
    const prepared = parseTeamSeatPrepareResponse(input.response);
    const request = assertPreparedResponse(operation, prepared);
    let membership = await linkTeamMembershipControlPlaneOperation(database, {
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      controlPlaneOperationId: prepared.authorization.authorizationId,
      now,
    });

    if (prepared.authorization.status === 'approved') {
      if (membership.status === 'approval_required') {
        membership = await transitionTeamMembership(database, {
          organizationId: input.organizationId,
          membershipId: input.membershipId,
          expectedStatus: 'approval_required',
          toStatus: 'billing_pending',
          actorUserId: input.actorUserId,
          source: 'control_plane',
          reason: 'team_seat_authorization_approved',
          controlPlaneOperationId: prepared.authorization.authorizationId,
          metadata: {
            quoteId: prepared.quote.quoteId,
            quoteHash: prepared.quote.quoteHash,
          },
          now,
          databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
        });
      } else if (
        membership.status !== 'billing_pending'
        && !(
          membership.status === 'suspended'
          && membership.userId !== null
          && operation.operationType === 'member_create'
        )
      ) {
        throw new MembershipOrchestratorError(
          'MEMBERSHIP_OPERATION_CONFLICT',
          `Membership cannot execute a Seat change from status ${membership.status}.`,
        );
      }
    }
    const executeOperation = prepared.authorization.status === 'approved'
      ? await enqueueMembershipSeatExecution(database, {
        organizationId: input.organizationId,
        membership,
        prepareOperation: operation,
        authorizationId: prepared.authorization.authorizationId,
        now,
      })
      : null;
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: operation.operationId,
      response: prepared,
      controlPlaneOperationId: prepared.authorization.authorizationId,
      now,
    });

    return {
      stage: prepared.authorization.status === 'approved'
        ? 'seat_execute_pending'
        : 'approval_required',
      membership,
      desiredQuantity: request.desiredQuantity,
      observedQuantity: prepared.snapshot.observedQuantity,
      prepareOperation: (await getTeamSeatOutboxOperation(database, operation.operationId))!,
      executeOperation,
      requiresBillingApproval: prepared.requiresBillingApproval,
      replayed: operation.status === 'succeeded',
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export type DirectMembershipSeatQuote = {
  activation: MembershipActivation;
  preparation: TeamSeatPrepareResponse;
};

export async function getDirectMembershipSeatQuote(input: {
  organizationId: string;
  membershipId: string;
  database?: MembershipOrchestratorDatabase;
}): Promise<DirectMembershipSeatQuote> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  try {
    const membership = await getTeamMembershipById(
      database,
      input.organizationId,
      input.membershipId,
    );
    if (!membership) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The membership activation was not found.',
        404,
      );
    }
    const prepareOperation = await latestMembershipPrepareOperation(
      database,
      input.organizationId,
      input.membershipId,
    );
    if (!prepareOperation || !prepareOperation.responseJson) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The prepared Seat quote was not found.',
        404,
      );
    }
    const preparation = parseTeamSeatPrepareResponse(
      JSON.parse(prepareOperation.responseJson),
    );
    const request = assertPreparedResponse(prepareOperation, preparation);
    const executeOperation = await getTeamSeatOutboxOperation(
      database,
      preparation.authorization.authorizationId,
    );
    const executionPending = executeOperation
      && ['processing', 'retry_wait'].includes(executeOperation.status);
    return {
      activation: {
        stage: membership.status === 'active'
          ? 'active'
          : executionPending
            ? 'billing_pending'
          : preparation.authorization.status === 'approved'
            ? 'seat_execute_pending'
            : membership.status === 'billing_pending'
              ? 'billing_pending'
              : 'approval_required',
        membership,
        desiredQuantity: request.desiredQuantity,
        observedQuantity: preparation.snapshot.observedQuantity,
        prepareOperation,
        executeOperation,
        requiresBillingApproval: preparation.requiresBillingApproval,
        replayed: true,
      },
      preparation,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function recordDirectMembershipSeatAuthorizationStatus(input: {
  organizationId: string;
  membershipId: string;
  response: unknown;
  actorUserId?: string | null;
  database?: MembershipOrchestratorDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<DirectMembershipSeatQuote> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  try {
    const stored = await getDirectMembershipSeatQuote({
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      database,
    });
    const current = parseTeamSeatQuoteStatusResponse(input.response);
    assertQuoteStatusMatchesPreparation(stored.preparation, current);
    let membership = stored.activation.membership;
    if (
      current.authorization.status === 'approved'
      && membership.status === 'approval_required'
    ) {
      membership = await transitionTeamMembership(database, {
        organizationId: input.organizationId,
        membershipId: input.membershipId,
        expectedStatus: 'approval_required',
        toStatus: 'billing_pending',
        actorUserId: input.actorUserId,
        source: 'control_plane',
        reason: 'team_seat_authorization_approved',
        controlPlaneOperationId: current.authorization.authorizationId,
        metadata: {
          quoteId: current.quote.quoteId,
          quoteHash: current.quote.quoteHash,
        },
        now,
        databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
      });
    }
    if (
      current.authorization.status === 'approved'
      && membership.status !== 'billing_pending'
      && membership.status !== 'active'
      && !(
        membership.status === 'suspended'
        && membership.userId !== null
        && stored.activation.prepareOperation.operationType === 'member_create'
      )
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        `Membership cannot execute an approved Seat change from status ${membership.status}.`,
      );
    }
    const executeOperation = current.authorization.status === 'approved'
      ? await enqueueMembershipSeatExecution(database, {
        organizationId: input.organizationId,
        membership,
        prepareOperation: stored.activation.prepareOperation,
        authorizationId: current.authorization.authorizationId,
        now,
      })
      : stored.activation.executeOperation;
    return {
      activation: {
        ...stored.activation,
        membership,
        executeOperation,
        stage: membership.status === 'active'
          ? 'active'
          : current.authorization.status === 'approved'
            ? 'seat_execute_pending'
            : membership.status === 'billing_pending'
              ? 'billing_pending'
              : 'approval_required',
      },
      preparation: {
        ...stored.preparation,
        quote: current.quote,
        authorization: current.authorization,
      },
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function beginDirectMembershipSeatRequote(input: {
  organizationId: string;
  membershipId: string;
  staleQuoteId: string;
  currentResponse?: unknown;
  actorUserId?: string | null;
  database?: MembershipOrchestratorDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<MembershipActivation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  try {
    const stored = await getDirectMembershipSeatQuote({
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      database,
    });
    const current = input.currentResponse
      ? parseTeamSeatQuoteStatusResponse(input.currentResponse)
      : {
        quote: stored.preparation.quote,
        authorization: stored.preparation.authorization,
      };
    assertQuoteStatusMatchesPreparation(stored.preparation, current);
    const pendingMembership = stored.activation.membership;
    const refreshableCandidate = pendingMembership.status === 'approval_required'
      && pendingMembership.userId === null;
    const refreshableReactivation = pendingMembership.status === 'suspended'
      && pendingMembership.userId !== null
      && stored.activation.prepareOperation.operationType === 'member_create';
    if (
      (!refreshableCandidate && !refreshableReactivation)
      || stored.preparation.quote.quoteId !== input.staleQuoteId
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        'The Seat quote cannot be refreshed for this membership lifecycle.',
      );
    }
    if (
      current.quote.status !== 'expired'
      && current.quote.status !== 'revoked'
      && current.authorization.status !== 'expired'
      && current.authorization.status !== 'revoked'
      && Date.parse(current.authorization.expiresAt) > now
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_QUOTE_STILL_ACTIVE',
        'The current Seat quote is still active and must not be replaced.',
      );
    }
    const projection = await getActiveTeamMembershipProjection(database, input.organizationId);
    const desiredQuantity = projection.observedQuantity + 1;
    const syncState = await getTeamMembershipSyncState(database, input.organizationId);
    const previousRequest = parsePrepareRequest(stored.activation.prepareOperation);
    const operationType = stored.activation.prepareOperation.operationType!;
    const count = await database.get(`
      SELECT COUNT(*) AS count
      FROM team_seat_outbox
      WHERE organization_id = ?
        AND membership_id = ?
        AND operation_kind = 'seat_prepare'
    `, [input.organizationId, input.membershipId]) as { count: number } | undefined;
    const request = createTeamSeatPrepareRequest({
      desiredQuantity,
      triggerType: operationType,
      externalReference: previousRequest.externalReference,
    });
    const enqueued = await enqueueTeamSeatOutboxOperation(database, {
      organizationId: input.organizationId,
      dedupeKey: `${operationType}:${input.membershipId}:seat-prepare:${Number(count?.count || 0) + 1}`,
      operationKind: 'seat_prepare',
      operationType,
      membershipId: input.membershipId,
      membershipRevision: syncState?.currentRevision ?? 0,
      request,
      now,
      nextAttemptAt: now,
    });
    return {
      stage: 'seat_prepare_pending',
      membership: stored.activation.membership,
      desiredQuantity,
      observedQuantity: projection.observedQuantity,
      prepareOperation: enqueued.operation,
      executeOperation: null,
      requiresBillingApproval: null,
      replayed: enqueued.replayed,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export type DirectMembershipSeatExecutionPending = {
  activation: MembershipActivation;
  execution: TeamSeatExecuteResponse;
};

export async function recordDirectMembershipSeatExecutionPending(input: {
  organizationId: string;
  membershipId: string;
  executeOperationId: string;
  response: unknown;
  database?: MembershipOrchestratorDatabase;
  now?: number;
}): Promise<DirectMembershipSeatExecutionPending> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  try {
    const operation = await requireMembershipOperation(database, {
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      operationId: input.executeOperationId,
      kind: 'seat_execute',
    });
    const request = parseExecuteRequest(operation);
    const execution = parseTeamSeatExecuteResponse(input.response);
    const prepareOperation = await latestMembershipPrepareOperation(
      database,
      input.organizationId,
      input.membershipId,
    );
    if (!prepareOperation) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The corresponding Seat preparation was not found.',
        404,
      );
    }
    const desiredQuantity = parsePrepareRequest(prepareOperation).desiredQuantity;
    if (
      execution.operation.operationKey !== request.operationKey
      || execution.operation.operationType !== request.operationType
      || execution.operation.requestedQuantity !== desiredQuantity
      || execution.operation.status === 'applied'
      || execution.license !== null
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_SEAT_RESPONSE_INVALID',
        'The pending Seat execution does not match the server-calculated membership change.',
        502,
      );
    }
    const membership = await getTeamMembershipById(
      database,
      input.organizationId,
      input.membershipId,
    );
    if (
      !membership
      || (
        membership.status !== 'billing_pending'
        && !(
          membership.status === 'suspended'
          && membership.userId !== null
          && operation.operationType === 'member_create'
        )
      )
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        'Only a billing-pending candidate or suspended reactivation can persist a pending Seat execution.',
      );
    }
    const pendingOperation = await recordTeamSeatOutboxOperationPending(database, {
      operationId: operation.operationId,
      response: execution,
      controlPlaneOperationId: execution.operation.operationId,
      errorCode: `TEAM_SEAT_${execution.operation.status.toUpperCase()}`,
      error: execution.operation.lastError
        || execution.operation.paymentStatus
        || 'The Seat execution is still pending.',
      retryAt: now + 30_000,
      now,
    });
    return {
      activation: {
        stage: 'billing_pending',
        membership,
        desiredQuantity,
        observedQuantity: parseTeamSeatPrepareResponse(
          JSON.parse(prepareOperation.responseJson || '{}'),
        ).snapshot.observedQuantity,
        prepareOperation,
        executeOperation: pendingOperation,
        requiresBillingApproval: true,
        replayed: execution.replayed,
      },
      execution,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

type MembershipIdentityPort = {
  ensurePending(input: {
    name: string;
    email: string;
    password: string;
    role: 'admin' | 'user';
  }): Promise<{ id: string; email: string }>;
  activate(userId: string): Promise<void>;
};

async function activateAndVerifyTeamCertificate(
  response: TeamSeatExecuteResponse,
  desiredQuantity: number,
): Promise<void> {
  if (!response.license) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_SEAT_NOT_CONFIRMED',
      'The applied Seat operation did not include a replacement license certificate.',
      502,
    );
  }
  const details = response.license.details;
  const status = await activateLicenseCert(response.license.license, {
    licenseId: details.id,
    instanceId: details.instanceId,
    plan: details.plan,
    status: details.status,
    hostingMode: details.hostingMode,
    edition: details.edition,
    licenseClass: details.licenseClass,
    licenseEnvironment: details.licenseEnvironment,
    entitlementsVersion: details.entitlementsVersion,
  });
  if (
    !status.licensed
    || status.edition !== 'team'
    || (status.licenseState !== 'active' && status.licenseState !== 'grace')
    || typeof status.seatLimit !== 'number'
    || status.seatLimit < desiredQuantity
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_SIGNED_LIMIT_INVALID',
      'The signed replacement certificate does not confirm the requested Seat limit.',
      502,
    );
  }
}

async function persistAppliedTeamSeatExecution(
  database: MembershipOrchestratorDatabase,
  input: {
    organizationId: string;
    membershipId: string;
    executeOperationId: string;
    response: unknown;
    verifyCertificate?: (
      response: TeamSeatExecuteResponse,
      desiredQuantity: number,
    ) => Promise<void>;
    now: number;
  },
): Promise<{
  operation: TeamSeatOutboxOperation;
  executed: TeamSeatExecuteResponse;
  prepareOperation: TeamSeatOutboxOperation;
  desiredQuantity: number;
}> {
  const operation = await requireMembershipOperation(database, {
    organizationId: input.organizationId,
    membershipId: input.membershipId,
    operationId: input.executeOperationId,
    kind: 'seat_execute',
  });
  const request = parseExecuteRequest(operation);
  const executed = parseTeamSeatExecuteResponse(input.response);
  if (
    executed.operation.operationKey !== request.operationKey
    || executed.operation.operationType !== request.operationType
    || executed.operation.requestedQuantity < 1
    || executed.operation.status !== 'applied'
    || executed.operation.effectiveQuantity !== executed.operation.requestedQuantity
    || executed.operation.certificateReissueStatus !== 'issued'
    || !executed.license
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_SEAT_NOT_CONFIRMED',
      'The Seat operation has not confirmed a usable signed limit.',
    );
  }

  const prepareOperation = await latestMembershipPrepareOperation(
    database,
    input.organizationId,
    input.membershipId,
  );
  if (!prepareOperation) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_NOT_FOUND',
      'The corresponding Seat preparation was not found.',
      404,
    );
  }
  const desiredQuantity = parsePrepareRequest(prepareOperation).desiredQuantity;
  if (executed.operation.requestedQuantity !== desiredQuantity) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_SEAT_RESPONSE_INVALID',
      'The executed Seat quantity does not match the server-calculated membership change.',
      502,
    );
  }
  await (input.verifyCertificate ?? activateAndVerifyTeamCertificate)(
    executed,
    desiredQuantity,
  );
  if (operation.status !== 'succeeded') {
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: operation.operationId,
      response: {
        ...executed,
        license: {
          details: executed.license.details,
          certificatePersisted: true,
        },
      },
      controlPlaneOperationId: executed.operation.operationId,
      now: input.now,
    });
  }
  return {
    operation,
    executed,
    prepareOperation,
    desiredQuantity,
  };
}

export async function recordDirectMembershipSeatExecutionApplied(input: {
  organizationId: string;
  membershipId: string;
  executeOperationId: string;
  response: unknown;
  database?: MembershipOrchestratorDatabase;
  verifyCertificate?: (
    response: TeamSeatExecuteResponse,
    desiredQuantity: number,
  ) => Promise<void>;
  now?: number;
}): Promise<TeamSeatOutboxOperation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  try {
    await persistAppliedTeamSeatExecution(database, {
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      executeOperationId: input.executeOperationId,
      response: input.response,
      verifyCertificate: input.verifyCertificate,
      now: input.now ?? Date.now(),
    });
    const operation = await getTeamSeatOutboxOperation(
      database,
      input.executeOperationId,
    );
    if (!operation) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The persisted Seat execution was not found.',
        404,
      );
    }
    return operation;
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function completeDirectMembershipActivation(input: {
  organizationId: string;
  membershipId: string;
  executeOperationId: string;
  response: unknown;
  password: string;
  actorUserId?: string | null;
  database?: MembershipOrchestratorDatabase;
  databaseProvider?: DatabaseProvider;
  identity?: MembershipIdentityPort;
  verifyCertificate?: (response: TeamSeatExecuteResponse, desiredQuantity: number) => Promise<void>;
  now?: number;
}): Promise<MembershipActivation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const now = input.now ?? Date.now();
  const identity = input.identity ?? {
    ensurePending: ensurePendingTeamMembershipIdentity,
    activate: activatePendingTeamMembershipIdentity,
  };
  try {
    const persistedExecution = await persistAppliedTeamSeatExecution(database, {
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      executeOperationId: input.executeOperationId,
      response: input.response,
      verifyCertificate: input.verifyCertificate,
      now,
    });
    const {
      operation,
      executed,
      prepareOperation: persistedPrepare,
      desiredQuantity,
    } = persistedExecution;

    let membership = await getTeamMembershipById(
      database,
      input.organizationId,
      input.membershipId,
    );
    if (!membership) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The membership candidate was not found.',
        404,
      );
    }
    if (membership.status === 'active') {
      if (!membership.userId) {
        throw new MembershipOrchestratorError(
          'MEMBERSHIP_OPERATION_CONFLICT',
          'The active membership does not reference a Better Auth identity.',
        );
      }
      const projection = await getActiveTeamMembershipProjection(database, input.organizationId);
      if (projection.observedQuantity > desiredQuantity) {
        throw new MembershipOrchestratorError(
          'MEMBERSHIP_SIGNED_LIMIT_INVALID',
          'The active membership projection exceeds the confirmed Seat quantity.',
        );
      }
      await identity.activate(membership.userId);
      return {
        stage: 'active',
        membership,
        desiredQuantity,
        observedQuantity: projection.observedQuantity,
        prepareOperation: persistedPrepare,
        executeOperation: (await getTeamSeatOutboxOperation(database, operation.operationId))!,
        requiresBillingApproval: null,
        replayed: true,
      };
    }
    if (membership.status === 'suspended') {
      if (!membership.userId || operation.operationType !== 'member_create') {
        throw new MembershipOrchestratorError(
          'MEMBERSHIP_OPERATION_CONFLICT',
          'The suspended membership cannot be finalized by this Seat operation.',
        );
      }
      const reactivated = await withActivationTransaction(
        database,
        input.databaseProvider ?? getDatabaseProvider(),
        async () => {
          const current = await getTeamMembershipById(
            database,
            input.organizationId,
            input.membershipId,
          );
          if (
            !current
            || current.status !== 'suspended'
            || !current.userId
          ) {
            throw new MembershipOrchestratorError(
              'MEMBERSHIP_OPERATION_CONFLICT',
              'The suspended membership changed before Seat activation.',
            );
          }
          await assertSeatActivationCapacity(database, {
            organizationId: input.organizationId,
            desiredQuantity,
            signedSeatLimit: executed.license!.details.quotas.users,
          });
          const activated = await transitionTeamMembership(database, {
            organizationId: input.organizationId,
            membershipId: input.membershipId,
            expectedStatus: 'suspended',
            toStatus: 'active',
            userId: current.userId,
            acceptedAt: current.acceptedAt ?? now,
            actorUserId: input.actorUserId,
            source: 'control_plane',
            reason: 'team_membership_reactivated',
            controlPlaneOperationId: executed.operation.operationId,
            seatOperationType: 'member_create',
            transactionMode: 'existing',
            now,
            databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
          });
          const projection = await getActiveTeamMembershipProjection(
            database,
            input.organizationId,
          );
          if (projection.observedQuantity !== desiredQuantity) {
            throw new MembershipOrchestratorError(
              'MEMBERSHIP_SIGNED_LIMIT_INVALID',
              'The reactivated membership projection does not match the confirmed Seat quantity.',
            );
          }
          return { membership: activated, projection };
        },
      );
      membership = reactivated.membership;
      await identity.activate(membership.userId!);
      return {
        stage: 'active',
        membership,
        desiredQuantity,
        observedQuantity: reactivated.projection.observedQuantity,
        prepareOperation: persistedPrepare,
        executeOperation: (await getTeamSeatOutboxOperation(database, operation.operationId))!,
        requiresBillingApproval: null,
        replayed: operation.status === 'succeeded' || executed.replayed,
      };
    }
    const pendingIdentity = await identity.ensurePending({
      name: membership.displayName || membership.candidateEmail,
      email: membership.candidateEmail,
      password: input.password,
      role: membership.role === 'admin' ? 'admin' : 'user',
    });
    if (pendingIdentity.email.trim().toLowerCase() !== membership.candidateEmail) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        'The pending Better Auth identity does not match the membership candidate.',
      );
    }

    const activated = await withActivationTransaction(
      database,
      input.databaseProvider ?? getDatabaseProvider(),
      async () => {
        let current = await getTeamMembershipById(
          database,
          input.organizationId,
          input.membershipId,
        );
        if (!current) {
          throw new MembershipOrchestratorError(
            'MEMBERSHIP_OPERATION_NOT_FOUND',
            'The membership candidate was not found.',
            404,
          );
        }
        if (current.status === 'approval_required') {
          current = await transitionTeamMembership(database, {
            organizationId: input.organizationId,
            membershipId: input.membershipId,
            expectedStatus: 'approval_required',
            toStatus: 'billing_pending',
            actorUserId: input.actorUserId,
            source: 'control_plane',
            reason: 'team_seat_execution_confirmed',
            controlPlaneOperationId: executed.operation.operationId,
            transactionMode: 'existing',
            now,
            databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
          });
        }
        if (current.status === 'billing_pending') {
          await assertSeatActivationCapacity(database, {
            organizationId: input.organizationId,
            desiredQuantity,
            signedSeatLimit: executed.license!.details.quotas.users,
          });
          current = await transitionTeamMembership(database, {
            organizationId: input.organizationId,
            membershipId: input.membershipId,
            expectedStatus: 'billing_pending',
            toStatus: 'active',
            userId: pendingIdentity.id,
            acceptedAt: now,
            actorUserId: input.actorUserId,
            source: 'control_plane',
            reason: 'team_seat_and_certificate_confirmed',
            controlPlaneOperationId: executed.operation.operationId,
            seatOperationType: operation.operationType!,
            transactionMode: 'existing',
            now,
            databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
          });
        } else if (
          current.status !== 'active'
          || current.userId !== pendingIdentity.id
        ) {
          throw new MembershipOrchestratorError(
            'MEMBERSHIP_OPERATION_CONFLICT',
            `Membership cannot be finalized from status ${current.status}.`,
          );
        }
        const projection = await getActiveTeamMembershipProjection(
          database,
          input.organizationId,
        );
        if (projection.observedQuantity !== desiredQuantity) {
          throw new MembershipOrchestratorError(
            'MEMBERSHIP_SIGNED_LIMIT_INVALID',
            'The active membership projection does not match the confirmed Seat quantity.',
          );
        }
        return { membership: current, projection };
      });
    membership = activated.membership;
    await identity.activate(pendingIdentity.id);

    return {
      stage: 'active',
      membership,
      desiredQuantity,
      observedQuantity: activated.projection.observedQuantity,
      prepareOperation: persistedPrepare,
      executeOperation: (await getTeamSeatOutboxOperation(database, operation.operationId))!,
      requiresBillingApproval: null,
      replayed: operation.status === 'succeeded' || executed.replayed,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}
