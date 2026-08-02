import 'server-only';

import {
  getCommunityTeamSeatQuoteStatus,
  prepareCommunityTeamSeatChange,
} from '@/app/lib/license/control-plane';
import { getCommunityTeamSeatApprovalUrl } from '@/app/lib/license/instance';
import { parseTeamSeatPrepareResponse } from '@/app/lib/license/team-seat-contract';
import {
  getDirectMembershipSeatQuote,
  getMembershipSeatPrepareRequest,
  recordDirectMembershipSeatAuthorizationStatus,
  recordDirectMembershipSeatPreparation,
  type DirectMembershipSeatQuote,
  type MembershipActivation,
} from './membership-orchestrator';

export type MembershipSeatQuotePayload = {
  stage: MembershipActivation['stage'];
  membershipId: string;
  prepareOperationId: string;
  desiredQuantity: number;
  observedQuantity: number;
  replayed: boolean;
  quote: {
    id: string;
    quantityBefore: number;
    quantityAfter: number;
    quantityDelta: number;
    unitAmountCents: number;
    currency: string;
    billingInterval: 'month';
    immediateAmountCents: number | null;
    recurringAmountCents: number;
    provider: string | null;
    nonBillable: boolean;
    status: string;
    expiresAt: string;
  };
  approval: {
    required: boolean;
    status: string;
    canApprove: boolean;
    url: string | null;
  };
};

export async function dispatchDirectMembershipSeatPreparation(input: {
  activation: MembershipActivation;
  actorUserId?: string | null;
}): Promise<DirectMembershipSeatQuote> {
  const response = input.activation.prepareOperation.responseJson
    ? parseTeamSeatPrepareResponse(
      JSON.parse(input.activation.prepareOperation.responseJson),
    )
    : await prepareCommunityTeamSeatChange(
      getMembershipSeatPrepareRequest(input.activation.prepareOperation),
    );
  const activation = await recordDirectMembershipSeatPreparation({
    organizationId: input.activation.membership.organizationId,
    membershipId: input.activation.membership.id,
    prepareOperationId: input.activation.prepareOperation.operationId,
    response,
    actorUserId: input.actorUserId,
  });
  return {
    activation,
    preparation: response,
  };
}

export async function refreshDirectMembershipSeatAuthorization(input: {
  organizationId: string;
  membershipId: string;
  actorUserId?: string | null;
}): Promise<DirectMembershipSeatQuote> {
  const stored = await getDirectMembershipSeatQuote({
    organizationId: input.organizationId,
    membershipId: input.membershipId,
  });
  const response = await getCommunityTeamSeatQuoteStatus(
    stored.preparation.quote.quoteId,
  );
  return recordDirectMembershipSeatAuthorizationStatus({
    organizationId: input.organizationId,
    membershipId: input.membershipId,
    response,
    actorUserId: input.actorUserId,
  });
}

export function membershipSeatQuotePayload(
  value: DirectMembershipSeatQuote,
  canApprove: boolean,
): MembershipSeatQuotePayload {
  const quote = value.preparation.quote;
  const authorization = value.preparation.authorization;
  const approvalRequired = value.preparation.requiresBillingApproval;
  return {
    stage: value.activation.stage,
    membershipId: value.activation.membership.id,
    prepareOperationId: value.activation.prepareOperation.operationId,
    desiredQuantity: value.activation.desiredQuantity,
    observedQuantity: value.activation.observedQuantity,
    replayed: value.activation.replayed,
    quote: {
      id: quote.quoteId,
      quantityBefore: quote.quantityBefore,
      quantityAfter: quote.quantityAfter,
      quantityDelta: quote.quantityDelta,
      unitAmountCents: quote.unitAmountCents,
      currency: quote.currency,
      billingInterval: quote.billingInterval,
      immediateAmountCents: quote.immediateAmountCents,
      recurringAmountCents: quote.recurringAmountCents,
      provider: quote.provider || null,
      nonBillable: quote.nonBillable === true,
      status: quote.status || 'active',
      expiresAt: quote.expiresAt,
    },
    approval: {
      required: approvalRequired,
      status: authorization.status,
      canApprove,
      url: approvalRequired && canApprove
        ? getCommunityTeamSeatApprovalUrl(quote.quoteId)
        : null,
    },
  };
}
