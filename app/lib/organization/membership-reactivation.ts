import 'server-only';

import { assertTeamMembershipIdentityReactivatable } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import {
  executeDirectMembershipActivation,
  type MembershipSeatActivationResult,
} from './membership-seat-activation';
import {
  dispatchDirectMembershipSeatPreparation,
} from './membership-seat-quote';
import {
  beginSuspendedMembershipReactivation,
  MembershipOrchestratorError,
  type DirectMembershipSeatQuote,
} from './membership-orchestrator';
import { getTeamMembershipByUserId } from './team-membership';

async function requireSuspendedMembership(
  organizationId: string,
  userId: string,
  allowActiveReplay = false,
) {
  const database = await openDb();
  try {
    const membership = await getTeamMembershipByUserId(
      database,
      organizationId,
      userId,
    );
    if (
      !membership
      || (
        membership.status !== 'suspended'
        && !(allowActiveReplay && membership.status === 'active')
      )
      || membership.userId !== userId
    ) {
      throw new MembershipOrchestratorError(
        'MEMBERSHIP_OPERATION_CONFLICT',
        'Only a suspended, non-archived Team membership can be reactivated.',
      );
    }
    if (membership.status === 'suspended') {
      await assertTeamMembershipIdentityReactivatable(
        membership.userId,
        membership.candidateEmail,
      );
    }
    return membership;
  } finally {
    await database.close();
  }
}

export async function prepareTeamMembershipReactivation(input: {
  organizationId: string;
  userId: string;
  actorUserId: string;
}): Promise<DirectMembershipSeatQuote> {
  const membership = await requireSuspendedMembership(
    input.organizationId,
    input.userId,
  );
  const activation = await beginSuspendedMembershipReactivation({
    organizationId: input.organizationId,
    membershipId: membership.id,
    actorUserId: input.actorUserId,
  });
  return dispatchDirectMembershipSeatPreparation({
    activation,
    actorUserId: input.actorUserId,
  });
}

export async function executeTeamMembershipReactivation(input: {
  organizationId: string;
  userId: string;
  actorUserId: string;
}): Promise<MembershipSeatActivationResult> {
  const membership = await requireSuspendedMembership(
    input.organizationId,
    input.userId,
    true,
  );
  return executeDirectMembershipActivation({
    organizationId: input.organizationId,
    membershipId: membership.id,
    actorUserId: input.actorUserId,
  });
}
