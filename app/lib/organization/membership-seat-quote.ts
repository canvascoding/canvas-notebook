import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import {
  getCommunityTeamSeatQuoteStatus,
  prepareCommunityTeamSeatChange,
} from '@/app/lib/license/control-plane';
import { getCommunityTeamSeatApprovalUrl } from '@/app/lib/license/instance';
import { parseTeamSeatPrepareResponse } from '@/app/lib/license/team-seat-contract';
import {
  claimTeamSeatOutboxOperation,
  getTeamSeatOutboxOperation,
  TeamSeatOutboxError,
  type TeamSeatOutboxOperation,
} from '@/app/lib/license/team-seat-outbox';
import { lockMembershipSeatLifecycle, membershipSeatQuoteNeedsRefresh } from './membership-seat-recovery';
import { getTeamMembershipById } from './team-membership';
import {
  getDirectMembershipSeatQuote,
  getMembershipSeatPrepareRequest,
  recordDirectMembershipSeatAuthorizationStatus,
  recordDirectMembershipSeatPreparation,
  type DirectMembershipSeatQuote,
  type MembershipActivation,
} from './membership-orchestrator';

async function claimSeatPreparation(
  operation: TeamSeatOutboxOperation,
  providedDatabase?: Pick<SqlConnection, 'get' | 'all' | 'run' | 'close'>,
): Promise<TeamSeatOutboxOperation> {
  const database = providedDatabase ?? await openDb();
  try {
    await database.run('BEGIN');
    if (!operation.membershipId) throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_CONFLICT', 'Seat preparation requires a membership.', 409);
    await lockMembershipSeatLifecycle(database, operation.organizationId, operation.membershipId);
    const membership = await getTeamMembershipById(database, operation.organizationId, operation.membershipId);
    const current = await getTeamSeatOutboxOperation(database, operation.operationId);
    const latest = await database.get(`
      SELECT operation_id FROM team_seat_outbox WHERE organization_id = $1 AND membership_id = $2 AND operation_kind = 'seat_prepare'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `, [operation.organizationId, operation.membershipId]) as { operation_id: string } | undefined;
    const validLifecycle = membership && (operation.operationType === 'member_remove'
      ? ['removed', 'suspended'].includes(membership.status)
      : (['approval_required', 'billing_pending'].includes(membership.status) && membership.userId === null)
        || (membership.status === 'suspended' && membership.userId !== null && operation.dedupeKey.includes(':reactivation:')));
    if (!current || !validLifecycle || (operation.operationType !== 'member_remove' && latest?.operation_id !== operation.operationId)
      || ['TEAM_SEAT_QUOTE_SUPERSEDED', 'TEAM_SEAT_ACTIVATION_CANCELLED'].includes(current.lastErrorCode || '')) {
      throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_CONFLICT', 'Seat preparation was cancelled, superseded, or belongs to an earlier membership lifecycle.', 409);
    }
    if (current.status === 'succeeded') {
      await database.run('COMMIT');
      return current;
    }
    const claimed = await claimTeamSeatOutboxOperation(database, {
      operationId: operation.operationId, allowPending: true, allowFailed: true,
    });
    if (!claimed.claimed) throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_CONFLICT', `Seat preparation is already ${claimed.operation.status}.`, 409);
    await database.run('COMMIT');
    return claimed.operation;
  } catch (error) {
    await database.run('ROLLBACK');
    throw error;
  } finally {
    if (!providedDatabase) await database.close();
  }
}

export type MembershipSeatQuotePayload = {
  stage: MembershipActivation['stage'];
  membershipId: string;
  prepareOperationId: string;
  desiredQuantity: number;
  observedQuantity: number;
  replayed: boolean;
  refreshRequired: boolean;
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
  database?: Pick<SqlConnection, 'get' | 'all' | 'run' | 'close'>;
  prepareSeatChange?: typeof prepareCommunityTeamSeatChange;
}): Promise<DirectMembershipSeatQuote> {
  const prepareOperation = await claimSeatPreparation(input.activation.prepareOperation, input.database);
  const response = prepareOperation.responseJson
    ? parseTeamSeatPrepareResponse(
      JSON.parse(prepareOperation.responseJson),
    )
    : await (input.prepareSeatChange ?? prepareCommunityTeamSeatChange)(
      getMembershipSeatPrepareRequest(prepareOperation),
      { operationId: prepareOperation.operationId },
    );
  const activation = await recordDirectMembershipSeatPreparation({
    database: input.database,
    organizationId: input.activation.membership.organizationId,
    membershipId: input.activation.membership.id,
    prepareOperationId: prepareOperation.operationId,
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
    { operationId: stored.activation.prepareOperation.operationId },
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
    refreshRequired: membershipSeatQuoteNeedsRefresh(value),
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
