import 'server-only';

import { assertTeamMembershipIdentityAvailable } from '@/app/lib/auth';
import { executeCommunityTeamSeatChange } from '@/app/lib/license/control-plane';
import type { TeamSeatExecuteResponse } from '@/app/lib/license/team-seat-contract';
import { initializeUserOnboarding } from '@/app/lib/user-preferences';
import { ensureWorkspaceBootstrapForActor } from '@/app/lib/workspaces/bootstrap-service';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  refreshDirectMembershipSeatAuthorization,
} from './membership-seat-quote';
import {
  completeDirectMembershipActivation,
  getMembershipSeatExecuteRequest,
  MembershipOrchestratorError,
  recordDirectMembershipSeatExecutionPending,
  type DirectMembershipSeatQuote,
} from './membership-orchestrator';

export class MembershipSeatActivationError extends Error {
  constructor(
    public readonly code: 'MEMBERSHIP_PASSWORD_INVALID',
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
  password: string;
}): Promise<MembershipSeatActivationResult> {
  if (input.password.length < 8 || input.password.length > 128) {
    throw new MembershipSeatActivationError(
      'MEMBERSHIP_PASSWORD_INVALID',
      'The initial password must contain between 8 and 128 characters.',
    );
  }

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

  const membership = approved.activation.membership;
  await assertTeamMembershipIdentityAvailable(
    membership.candidateEmail,
    membership.userId,
  );

  const execution = await executeCommunityTeamSeatChange(
    getMembershipSeatExecuteRequest(approved.activation.executeOperation),
  );
  if (
    execution.operation.status !== 'applied'
    || execution.operation.effectiveQuantity !== execution.operation.requestedQuantity
    || execution.operation.certificateReissueStatus !== 'issued'
    || !execution.license
  ) {
    const pending = await recordDirectMembershipSeatExecutionPending({
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      executeOperationId: approved.activation.executeOperation.operationId,
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
    executeOperationId: approved.activation.executeOperation.operationId,
    response: execution,
    password: input.password,
    actorUserId: input.actorUserId,
  });
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
