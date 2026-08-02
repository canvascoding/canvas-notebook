import 'server-only';

import {
  getCommunityTeamSeatQuoteStatus,
} from '@/app/lib/license/control-plane';
import {
  assertOrganizationSeatProjectionNotOverLimit,
} from '@/app/lib/license/seat-limit';
import {
  dispatchDirectMembershipSeatPreparation,
  refreshDirectMembershipSeatAuthorization,
} from './membership-seat-quote';
import {
  beginDirectMembershipSeatRequote,
  beginInvitationMembershipActivation,
  getDirectMembershipSeatQuote,
  recordDirectMembershipSeatAuthorizationStatus,
  type DirectMembershipSeatQuote,
} from './membership-orchestrator';
import {
  acceptTeamMembershipInvitation,
  type TeamMembershipInvitation,
} from './team-invitations';

export type AcceptedInvitationSeatState = {
  invitation: TeamMembershipInvitation;
  quote: DirectMembershipSeatQuote;
  replayed: boolean;
};

export async function prepareAcceptedInvitationSeat(input: {
  token: string;
  requestId: string;
  refreshQuote?: boolean;
}): Promise<AcceptedInvitationSeatState> {
  const accepted = await acceptTeamMembershipInvitation({
    token: input.token,
    requestId: input.requestId,
  });
  await assertOrganizationSeatProjectionNotOverLimit({
    organizationId: accepted.invitation.organizationId,
  });
  const activation = accepted.membership.status === 'approval_required'
    ? await beginInvitationMembershipActivation({
      organizationId: accepted.invitation.organizationId,
      membershipId: accepted.membership.id,
      invitationId: accepted.invitation.id,
    })
    : null;
  let quote: DirectMembershipSeatQuote;
  if (activation && !activation.prepareOperation.responseJson) {
    quote = await dispatchDirectMembershipSeatPreparation({
      activation,
      actorUserId: null,
    });
  } else if (!input.refreshQuote) {
    quote = await refreshDirectMembershipSeatAuthorization({
      organizationId: accepted.invitation.organizationId,
      membershipId: accepted.membership.id,
      actorUserId: null,
    });
  } else {
    const stored = await getDirectMembershipSeatQuote({
      organizationId: accepted.invitation.organizationId,
      membershipId: accepted.membership.id,
    });
    const currentResponse = await getCommunityTeamSeatQuoteStatus(
      stored.preparation.quote.quoteId,
      { operationId: stored.activation.prepareOperation.operationId },
    );
    const current = await recordDirectMembershipSeatAuthorizationStatus({
      organizationId: accepted.invitation.organizationId,
      membershipId: accepted.membership.id,
      response: currentResponse,
      actorUserId: null,
    });
    if (['approved', 'consumed'].includes(current.preparation.authorization.status)) {
      quote = current;
    } else {
      const requote = await beginDirectMembershipSeatRequote({
        organizationId: accepted.invitation.organizationId,
        membershipId: accepted.membership.id,
        staleQuoteId: stored.preparation.quote.quoteId,
        currentResponse,
        actorUserId: null,
      });
      quote = await dispatchDirectMembershipSeatPreparation({
        activation: requote,
        actorUserId: null,
      });
    }
  }
  return {
    invitation: accepted.invitation,
    quote,
    replayed: accepted.replayed,
  };
}
