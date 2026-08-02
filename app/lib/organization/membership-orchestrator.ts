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
import {
  createTeamSeatExecuteRequest,
  createTeamSeatPrepareRequest,
  parseTeamSeatExecuteResponse,
  parseTeamSeatPrepareResponse,
  type TeamSeatExecuteResponse,
  type TeamSeatPrepareResponse,
} from '@/app/lib/license/team-seat-contract';
import {
  enqueueTeamSeatOutboxOperation,
  getTeamMembershipSyncState,
  getTeamSeatOutboxOperation,
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
      | 'MEMBERSHIP_SIGNED_LIMIT_INVALID',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'MembershipOrchestratorError';
  }
}

function parsePrepareRequest(operation: TeamSeatOutboxOperation) {
  const value = JSON.parse(operation.requestJson) as {
    desiredQuantity?: unknown;
    triggerType?: unknown;
    externalReference?: unknown;
  };
  if (
    value.triggerType !== 'member_create'
    || typeof value.externalReference !== 'string'
    || value.externalReference !== operation.membershipId
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_CONFLICT',
      'The persisted Seat preparation request is invalid.',
    );
  }
  return createTeamSeatPrepareRequest({
    desiredQuantity: Number(value.desiredQuantity),
    triggerType: value.triggerType,
    externalReference: value.externalReference,
  });
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
    || value.operationType !== 'member_create'
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

function assertPendingCandidateMatches(
  membership: TeamMembership,
  input: { displayName: string; role: TeamMembershipRole },
): void {
  if (
    !['approval_required', 'billing_pending'].includes(membership.status)
    || membership.userId !== null
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
    || operation.operationType !== 'member_create'
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_OPERATION_NOT_FOUND',
      'The membership Seat operation was not found.',
      404,
    );
  }
  return operation;
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

    return {
      stage: 'seat_prepare_pending',
      membership,
      desiredQuantity,
      observedQuantity: projection.observedQuantity,
      prepareOperation: enqueued.operation,
      executeOperation: null,
      requiresBillingApproval: null,
      replayed: replayed || enqueued.replayed,
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
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: operation.operationId,
      response: prepared,
      controlPlaneOperationId: prepared.authorization.authorizationId,
      now,
    });
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
      } else if (membership.status !== 'billing_pending') {
        throw new MembershipOrchestratorError(
          'MEMBERSHIP_OPERATION_CONFLICT',
          `Membership cannot execute a Seat change from status ${membership.status}.`,
        );
      }
    }
    const operationKey = prepared.authorization.authorizationId;
    const executeRequest = createTeamSeatExecuteRequest({
      authorizationId: prepared.authorization.authorizationId,
      operationKey,
      operationType: 'member_create',
    });
    const executeOperation = (await enqueueTeamSeatOutboxOperation(database, {
      organizationId: input.organizationId,
      operationId: operationKey,
      dedupeKey: `membership:${membership.id}:seat-execute:${prepared.authorization.authorizationId}`,
      operationKind: 'seat_execute',
      operationType: 'member_create',
      membershipId: membership.id,
      membershipRevision: operation.membershipRevision,
      request: executeRequest,
      now,
      nextAttemptAt: now,
    })).operation;

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

    const prepareOperation = await database.get(`
      SELECT operation_id
      FROM team_seat_outbox
      WHERE organization_id = ?
        AND membership_id = ?
        AND operation_kind = 'seat_prepare'
      ORDER BY created_at ASC
      LIMIT 1
    `, [input.organizationId, input.membershipId]) as { operation_id: string } | undefined;
    if (!prepareOperation) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The corresponding Seat preparation was not found.',
        404,
      );
    }
    const persistedPrepare = await getTeamSeatOutboxOperation(database, prepareOperation.operation_id);
    if (!persistedPrepare) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_NOT_FOUND',
        'The corresponding Seat preparation was not found.',
        404,
      );
    }
    const desiredQuantity = parsePrepareRequest(persistedPrepare).desiredQuantity;
    if (executed.operation.requestedQuantity !== desiredQuantity) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_SEAT_RESPONSE_INVALID',
        'The executed Seat quantity does not match the server-calculated membership change.',
        502,
      );
    }
    await (input.verifyCertificate ?? activateAndVerifyTeamCertificate)(executed, desiredQuantity);
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
      now,
    });

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

    if (membership.status === 'approval_required') {
      membership = await transitionTeamMembership(database, {
        organizationId: input.organizationId,
        membershipId: input.membershipId,
        expectedStatus: 'approval_required',
        toStatus: 'billing_pending',
        actorUserId: input.actorUserId,
        source: 'control_plane',
        reason: 'team_seat_execution_confirmed',
        controlPlaneOperationId: executed.operation.operationId,
        now,
        databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
      });
    }
    if (membership.status === 'billing_pending') {
      membership = await transitionTeamMembership(database, {
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
        seatOperationType: 'member_create',
        now,
        databaseProvider: input.databaseProvider ?? getDatabaseProvider(),
      });
    } else if (
      membership.status !== 'active'
      || membership.userId !== pendingIdentity.id
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        `Membership cannot be finalized from status ${membership.status}.`,
      );
    }
    await identity.activate(pendingIdentity.id);
    const projection = await getActiveTeamMembershipProjection(database, input.organizationId);
    if (projection.observedQuantity > desiredQuantity) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_SIGNED_LIMIT_INVALID',
        'The active membership projection exceeds the confirmed Seat quantity.',
      );
    }

    return {
      stage: 'active',
      membership,
      desiredQuantity,
      observedQuantity: projection.observedQuantity,
      prepareOperation: persistedPrepare,
      executeOperation: (await getTeamSeatOutboxOperation(database, operation.operationId))!,
      requiresBillingApproval: null,
      replayed: operation.status === 'succeeded' || executed.replayed,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}
