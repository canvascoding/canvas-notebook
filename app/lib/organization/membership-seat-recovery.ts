import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { getCommunityTeamSeatQuoteStatus, LicenseControlPlaneError, retireCommunityTeamSeatQuote } from '@/app/lib/license/control-plane';
import {
  parseTeamSeatPrepareResponse,
  parseTeamSeatQuoteStatusResponse,
  type TeamSeatPrepareResponse,
  type TeamSeatQuoteStatusResponse,
} from '@/app/lib/license/team-seat-contract';
import { getTeamSeatOutboxOperation, recordTeamSeatOutboxOperationFailure, type TeamSeatOutboxOperation } from '@/app/lib/license/team-seat-outbox';
import type { DirectMembershipSeatQuote } from './membership-orchestrator';
import { getTeamMembershipById, lockTeamMembershipProjection } from './team-membership';

type RecoveryDatabase = Pick<SqlConnection, 'get' | 'all' | 'run'>;
export type SeatQuoteStatusReader = (quoteId: string, operationId: string) => Promise<unknown>;
export type SeatQuoteRevoker = (quoteId: string, input: {
  authorizationId: string; quoteHash: string; reason: 'activation_refresh' | 'activation_cancel';
}, operationId: string) => Promise<unknown>;
type QuoteProof = {
  operationId: string;
  responseJson: string;
  preparation: TeamSeatPrepareResponse;
  current: TeamSeatQuoteStatusResponse;
};
export type MembershipSeatRecoveryProof = QuoteProof[];

const SAFE_FAILURES = new Set([
  'TEAM_SEAT_QUOTE_STALE',
  'TEAM_SEAT_AUTHORIZATION_EXPIRED',
  'TEAM_SEAT_AUTHORIZATION_REPLAY',
  'TEAM_SEAT_RECONCILIATION_REQUIRED',
  'TEAM_SEAT_QUOTE_SUPERSEDED',
  'TEAM_SEAT_ACTIVATION_CANCELLED',
]);

export class MembershipSeatRecoveryConflict extends Error {
  constructor() {
    super('The Seat change is running, already consumed, or has an uncertain result. Reconcile it before replacing or cancelling activation.');
    this.name = 'MembershipSeatRecoveryConflict';
  }
}

export function isTerminalSeatQuoteFailure(operation: TeamSeatOutboxOperation | null): boolean {
  return Boolean(operation && operation.status === 'failed'
    && operation.completedAt !== null && operation.nextAttemptAt === null
    && operation.responseJson === null && operation.controlPlaneOperationId === null
    && operation.lastErrorCode && SAFE_FAILURES.has(operation.lastErrorCode));
}

export function membershipSeatQuoteNeedsRefresh(value: DirectMembershipSeatQuote, now = Date.now()): boolean {
  if (value.activation.membership.status === 'active'
    || value.preparation.authorization.status === 'consumed'
    || value.preparation.authorization.consumedAt) return false;
  return isTerminalSeatQuoteFailure(value.activation.executeOperation)
    || ['expired', 'revoked'].includes(value.preparation.quote.status || '')
    || ['expired', 'revoked'].includes(value.preparation.authorization.status)
    || Date.parse(value.preparation.authorization.expiresAt) <= now
    || Date.parse(value.preparation.quote.expiresAt || '') <= now;
}

export async function lockMembershipSeatLifecycle(database: RecoveryDatabase, organizationId: string, membershipId: string): Promise<void> {
  await lockTeamMembershipProjection(database, organizationId);
  await database.get('SELECT id FROM team_memberships WHERE organization_id = $1 AND id = $2 FOR UPDATE', [organizationId, membershipId]);
}

export async function recordMembershipSeatExecutionRejection(input: {
  operation: TeamSeatOutboxOperation;
  error: unknown;
  database?: SqlConnection;
  now?: number;
}): Promise<boolean> {
  const { operation, error } = input;
  if (!(error instanceof LicenseControlPlaneError) || error.status !== 409 || error.retryable || error.category !== 'business'
    || !['TEAM_SEAT_QUOTE_STALE', 'TEAM_SEAT_AUTHORIZATION_EXPIRED'].includes(error.code)
    || !operation.membershipId || operation.operationKind !== 'seat_execute'
    || !['member_create', 'invitation_accept'].includes(operation.operationType || '')) return false;
  const database = input.database ?? await openDb();
  try {
    await database.run('BEGIN');
    try {
      await lockMembershipSeatLifecycle(database, operation.organizationId, operation.membershipId);
      await database.get('SELECT operation_id FROM team_seat_outbox WHERE operation_id = $1 FOR UPDATE', [operation.operationId]);
      const current = await getTeamSeatOutboxOperation(database, operation.operationId);
      const sameClaim = current && current.organizationId === operation.organizationId
        && current.membershipId === operation.membershipId && current.status === 'processing'
        && current.operationKind === operation.operationKind && current.operationType === operation.operationType
        && current.requestHash === operation.requestHash && current.requestJson === operation.requestJson
        && current.lastAttemptAt === operation.lastAttemptAt && current.attemptCount === operation.attemptCount
        && current.nextAttemptAt === operation.nextAttemptAt && current.updatedAt === operation.updatedAt
        && current.responseJson === null && current.controlPlaneOperationId === null;
      if (sameClaim) await recordTeamSeatOutboxOperationFailure(database, {
        operationId: operation.operationId, errorCode: error.code, error: error.message, now: input.now,
      });
      await database.run('COMMIT');
      return Boolean(sameClaim);
    } catch (failure) {
      await database.run('ROLLBACK');
      throw failure;
    }
  } finally {
    if (!input.database) await database.close();
  }
}

async function membershipSeatRecoverySince(database: RecoveryDatabase, organizationId: string, membershipId: string): Promise<number> {
  const membership = await getTeamMembershipById(database, organizationId, membershipId);
  if (!membership) throw new MembershipSeatRecoveryConflict();
  if (membership.userId !== null) {
    if (membership.status !== 'suspended' || membership.suspendedAt === null) throw new MembershipSeatRecoveryConflict();
    return membership.suspendedAt;
  }
  if (!['approval_required', 'billing_pending'].includes(membership.status) || membership.activatedAt !== null) {
    throw new MembershipSeatRecoveryConflict();
  }
  return 0;
}

export async function readMembershipSeatRecoveryProof(
  database: RecoveryDatabase,
  organizationId: string,
  membershipId: string,
  readStatus: SeatQuoteStatusReader = (quoteId, operationId) => getCommunityTeamSeatQuoteStatus(quoteId, { operationId }),
): Promise<MembershipSeatRecoveryProof> {
  const since = await membershipSeatRecoverySince(database, organizationId, membershipId);
  const rows = await database.all(`
    SELECT operation_id, response_json FROM team_seat_outbox
    WHERE organization_id = $1 AND membership_id = $2
      AND operation_kind = 'seat_prepare' AND operation_type IN ('member_create', 'invitation_accept')
      AND response_json IS NOT NULL AND created_at >= $3
    ORDER BY created_at, id
  `, [organizationId, membershipId, since]) as Array<{ operation_id: string; response_json: string }>;
  return Promise.all(rows.map(async (row) => {
    const preparation = parseTeamSeatPrepareResponse(JSON.parse(row.response_json));
    const current = parseTeamSeatQuoteStatusResponse(await readStatus(preparation.quote.quoteId, row.operation_id));
    if (current.quote.quoteId !== preparation.quote.quoteId
      || current.quote.quoteHash !== preparation.quote.quoteHash
      || current.authorization.authorizationId !== preparation.authorization.authorizationId
      || current.authorization.quoteId !== preparation.quote.quoteId
      || current.authorization.quoteHash !== preparation.quote.quoteHash
      || current.authorization.quantityBefore !== preparation.authorization.quantityBefore
      || current.authorization.quantityAfter !== preparation.authorization.quantityAfter
      || current.authorization.expiresAt !== preparation.authorization.expiresAt) {
      throw new MembershipSeatRecoveryConflict();
    }
    return { operationId: row.operation_id, responseJson: row.response_json, preparation, current };
  }));
}

async function readRecoverableMembershipSeatWork(
  database: RecoveryDatabase,
  input: { organizationId: string; membershipId: string; proof: MembershipSeatRecoveryProof; requireRetired?: boolean },
): Promise<TeamSeatOutboxOperation[]> {
  if (input.proof.some((item) => item.current.authorization.status === 'consumed' || item.current.authorization.consumedAt
    || (input.requireRetired && item.current.authorization.status !== 'revoked'))) throw new MembershipSeatRecoveryConflict();
  const since = await membershipSeatRecoverySince(database, input.organizationId, input.membershipId);
  const rows = await database.all(`
    SELECT operation_id FROM team_seat_outbox
    WHERE organization_id = $1 AND membership_id = $2
      AND operation_kind IN ('seat_prepare', 'seat_execute')
      AND operation_type IN ('member_create', 'invitation_accept') AND created_at >= $3
    ORDER BY id FOR UPDATE
  `, [input.organizationId, input.membershipId, since]) as Array<{ operation_id: string }>;
  const retire: TeamSeatOutboxOperation[] = [];
  for (const row of rows) {
    const operation = (await getTeamSeatOutboxOperation(database, row.operation_id))!;
    const untouched = operation.status === 'pending' && operation.attemptCount === 0
      && operation.lastAttemptAt === null && operation.responseJson === null
      && operation.controlPlaneOperationId === null;
    if (operation.operationKind === 'seat_prepare') {
      if (operation.status === 'succeeded') {
        const known = input.proof.find((item) => item.operationId === operation.operationId && item.responseJson === operation.responseJson);
        if (!known) throw new MembershipSeatRecoveryConflict();
        continue;
      }
      if (operation.status === 'failed' && operation.attemptCount === 0 && operation.lastAttemptAt === null
        && operation.responseJson === null && operation.controlPlaneOperationId === null
        && ['TEAM_SEAT_QUOTE_SUPERSEDED', 'TEAM_SEAT_ACTIVATION_CANCELLED'].includes(operation.lastErrorCode || '')) continue;
      if (!untouched) throw new MembershipSeatRecoveryConflict();
      retire.push(operation);
      continue;
    }
    const request = JSON.parse(operation.requestJson) as { authorizationId?: string; operationKey?: string; operationType?: string };
    const proof = input.proof.find((item) => item.preparation.authorization.authorizationId === request.authorizationId);
    const persisted = proof ? await getTeamSeatOutboxOperation(database, proof.operationId) : null;
    if (!proof || !persisted || persisted.responseJson !== proof.responseJson
      || persisted.status !== 'succeeded'
      || operation.operationId !== request.authorizationId || request.operationKey !== request.authorizationId
      || request.operationType !== operation.operationType || operation.operationType !== persisted.operationType
      || proof.current.authorization.status === 'consumed' || proof.current.authorization.consumedAt
      || !['pending', 'approved', 'expired', 'revoked'].includes(proof.current.authorization.status)
      || (!untouched && !isTerminalSeatQuoteFailure(operation))) {
      throw new MembershipSeatRecoveryConflict();
    }
    if (untouched) retire.push(operation);
  }
  return retire;
}

export async function validateMembershipSeatRecoveryWork(database: RecoveryDatabase, input: {
  organizationId: string; membershipId: string; proof: MembershipSeatRecoveryProof;
}): Promise<void> {
  await readRecoverableMembershipSeatWork(database, input);
}

export async function retireUnconsumedMembershipSeatWork(
  database: RecoveryDatabase,
  input: { organizationId: string; membershipId: string; proof: MembershipSeatRecoveryProof; reason: 'superseded' | 'cancelled'; now: number },
): Promise<void> {
  const retire = await readRecoverableMembershipSeatWork(database, { ...input, requireRetired: true });
  for (const operation of retire) {
    await database.run(`
      UPDATE team_seat_outbox SET status = 'failed', next_attempt_at = NULL,
        last_error_code = $1, last_error = $2, completed_at = $3, updated_at = $3
      WHERE operation_id = $4 AND status = 'pending' AND last_attempt_at IS NULL AND attempt_count = 0
    `, [input.reason === 'superseded' ? 'TEAM_SEAT_QUOTE_SUPERSEDED' : 'TEAM_SEAT_ACTIVATION_CANCELLED',
      input.reason === 'superseded' ? 'Replaced by an explicitly requested current Seat quote.' : 'Activation cancelled before Seat execution.',
      input.now, operation.operationId]);
  }
}

export async function revokeMembershipSeatAuthorizations(
  proof: MembershipSeatRecoveryProof,
  reason: 'activation_refresh' | 'activation_cancel',
  revokeQuote: SeatQuoteRevoker = (quoteId, request, operationId) => retireCommunityTeamSeatQuote(quoteId, request, { operationId }),
): Promise<MembershipSeatRecoveryProof> {
  const revoked: MembershipSeatRecoveryProof = [];
  for (const item of proof) {
    const current = parseTeamSeatQuoteStatusResponse(await revokeQuote(item.preparation.quote.quoteId, {
      authorizationId: item.preparation.authorization.authorizationId,
      quoteHash: item.preparation.quote.quoteHash,
      reason,
    }, item.operationId));
    if (current.quote.quoteId !== item.preparation.quote.quoteId
      || current.quote.quoteHash !== item.preparation.quote.quoteHash
      || current.authorization.authorizationId !== item.preparation.authorization.authorizationId
      || current.authorization.quoteHash !== item.preparation.quote.quoteHash
      || current.authorization.quoteId !== item.preparation.quote.quoteId
      || current.authorization.quantityBefore !== item.preparation.authorization.quantityBefore
      || current.authorization.quantityAfter !== item.preparation.authorization.quantityAfter
      || current.authorization.expiresAt !== item.preparation.authorization.expiresAt
      || current.authorization.status !== 'revoked' || current.authorization.consumedAt
      || current.quote.status !== 'revoked') throw new MembershipSeatRecoveryConflict();
    revoked.push({ ...item, current });
  }
  return revoked;
}
