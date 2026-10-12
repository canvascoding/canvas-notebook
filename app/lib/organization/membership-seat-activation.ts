import 'server-only';

import {
  assertTeamMembershipIdentityAvailable,
  assertTeamMembershipIdentityReactivatable,
} from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { executeCommunityTeamSeatChange } from '@/app/lib/license/control-plane';
import type { TeamSeatExecuteResponse } from '@/app/lib/license/team-seat-contract';
import {
  claimTeamSeatOutboxOperation,
  TeamSeatOutboxError,
} from '@/app/lib/license/team-seat-outbox';
import { initializeUserOnboarding } from '@/app/lib/user-preferences';
import { ensureWorkspaceBootstrapForActor } from '@/app/lib/workspaces/bootstrap-service';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  refreshDirectMembershipSeatAuthorization,
} from './membership-seat-quote';
import {
  completeDirectMembershipActivation,
  getMembershipSeatExecuteRequest,
  getDirectMembershipSeatQuote,
  MembershipOrchestratorError,
  recordDirectMembershipSeatExecutionPending,
  type DirectMembershipSeatQuote,
} from './membership-orchestrator';

import { lockMembershipSeatLifecycle, membershipSeatQuoteNeedsRefresh, recordMembershipSeatExecutionRejection } from './membership-seat-recovery';

export class MembershipSeatActivationError extends Error {
  constructor(
    public readonly code: 'MEMBERSHIP_PASSWORD_INVALID' | 'MEMBERSHIP_SEAT_QUOTE_REFRESH_REQUIRED',
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'MembershipSeatActivationError';
  }
}

export type MembershipSeatActivationResult = {
  quote: DirectMembershipSeatQuote;
  execution: TeamSeatExecuteResponse;
  onboardingInitialized: boolean;
};

export async function executeDirectMembershipActivation(input: {
  organizationId: string;
  membershipId: string;
  actorUserId?: string | null;
  password?: string;
}): Promise<MembershipSeatActivationResult> {
  const approved = await refreshDirectMembershipSeatAuthorization({
    organizationId: input.organizationId,
    membershipId: input.membershipId,
    actorUserId: input.actorUserId,
  });
  if (
    !['approved', 'consumed'].includes(approved.preparation.authorization.status)
    || !approved.activation.executeOperation
  ) {
    throw new MembershipOrchestratorError(
      'MEMBERSHIP_SEAT_NOT_CONFIRMED',
      'The exact Team Seat quote has not been approved yet.',
    );
  }

  if (membershipSeatQuoteNeedsRefresh(approved)) {
    throw new MembershipSeatActivationError('MEMBERSHIP_SEAT_QUOTE_REFRESH_REQUIRED', 'Load a new Seat quote before activating this membership.', 409);
  }

  const membership = approved.activation.membership;
  const reactivation = approved.activation.prepareOperation.dedupeKey.includes(':reactivation:');
  if (!reactivation && (!input.password || input.password.length < 8 || input.password.length > 128)) {
    throw new MembershipSeatActivationError(
      'MEMBERSHIP_PASSWORD_INVALID',
      'The initial password must contain between 8 and 128 characters.',
    );
  }
  if (reactivation && membership.status === 'suspended' && membership.userId) {
    await assertTeamMembershipIdentityReactivatable(
      membership.userId,
      membership.candidateEmail,
    );
  } else {
    await assertTeamMembershipIdentityAvailable(
      membership.candidateEmail,
      membership.userId,
    );
  }

  let executeOperation = approved.activation.executeOperation;
  if (executeOperation.status !== 'succeeded') {
    const database = await openDb();
    try {
      await database.run('BEGIN');
      await lockMembershipSeatLifecycle(database, input.organizationId, input.membershipId);
      const current = await getDirectMembershipSeatQuote({ organizationId: input.organizationId, membershipId: input.membershipId, database });
      if (current.activation.prepareOperation.operationId !== approved.activation.prepareOperation.operationId
        || current.activation.executeOperation?.operationId !== executeOperation.operationId
        || current.activation.membership.status !== membership.status
        || current.activation.membership.userId !== membership.userId) {
        throw new MembershipOrchestratorError('MEMBERSHIP_OPERATION_CONFLICT', 'The membership activation changed before Seat execution.');
      }
      if (membershipSeatQuoteNeedsRefresh({ activation: current.activation, preparation: approved.preparation })) {
        throw new MembershipSeatActivationError('MEMBERSHIP_SEAT_QUOTE_REFRESH_REQUIRED', 'Load a new Seat quote before activating this membership.', 409);
      }
      const claimed = await claimTeamSeatOutboxOperation(database, {
        operationId: executeOperation.operationId,
        allowPending: true,
        allowFailed: true,
      });
      if (!claimed.claimed) {
        throw new TeamSeatOutboxError(
          'TEAM_SEAT_OUTBOX_CONFLICT',
          `Seat execution is already ${claimed.operation.status}.`,
          409,
        );
      }
      executeOperation = claimed.operation;
      await database.run('COMMIT');
    } catch (error) {
      await database.run('ROLLBACK');
      throw error;
    } finally {
      await database.close();
    }
  }
  const execution = await executeCommunityTeamSeatChange(
    getMembershipSeatExecuteRequest(executeOperation),
    { operationId: executeOperation.operationId },
  ).catch(async (error: unknown) => {
    await recordMembershipSeatExecutionRejection({ operation: executeOperation, error });
    throw error;
  });
  if (
    execution.operation.status !== 'applied'
    || execution.operation.effectiveQuantity !== execution.operation.requestedQuantity
    || execution.operation.certificateReissueStatus !== 'issued'
    || !execution.license
  ) {
    const pending = await recordDirectMembershipSeatExecutionPending({
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      executeOperationId: executeOperation.operationId,
      response: execution,
    });
    return {
      quote: {
        activation: pending.activation,
        preparation: approved.preparation,
      },
      execution: pending.execution,
      onboardingInitialized: false,
    };
  }

  const activation = await completeDirectMembershipActivation({
    organizationId: input.organizationId,
    membershipId: input.membershipId,
    executeOperationId: executeOperation.operationId,
    response: execution,
    password: input.password || '',
    actorUserId: input.actorUserId,
  });
  if (reactivation) {
    return {
      quote: {
        activation,
        preparation: approved.preparation,
      },
      execution,
      onboardingInitialized: false,
    };
  }
  await ensureWorkspaceBootstrapForActor(resolveWorkspaceActor({
    id: activation.membership.userId!,
    email: activation.membership.candidateEmail,
    role: activation.membership.role === 'admin' ? 'admin' : 'user',
  }));
  await initializeUserOnboarding(activation.membership.userId!);
  return {
    quote: {
      activation,
      preparation: approved.preparation,
    },
    execution,
    onboardingInitialized: true,
  };
}
