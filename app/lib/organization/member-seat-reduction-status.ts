import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import {
  parseTeamSeatOperation,
  parseTeamSeatPrepareResponse,
} from '@/app/lib/license/team-seat-contract';

export type MemberSeatReductionStatus = {
  userId: string;
  state: 'pending' | 'completed' | 'failed';
  phase: 'prepare' | 'execute';
  errorCode: string | null;
};

export const MAX_MEMBER_SEAT_REDUCTION_STATUS_USERS = 100;

type PrepareRow = {
  user_id: string;
  membership_id: string;
  membership_revision: number | null;
  status: string;
  request_json: string;
  response_json: string | null;
  last_error_code: string | null;
};

type ExecuteRow = {
  operation_id: string;
  membership_id: string;
  membership_revision: number | null;
  status: string;
  request_json: string;
  response_json: string | null;
  last_error_code: string | null;
};

type PreparedChain = {
  row: PrepareRow;
  authorizationId: string;
  desiredQuantity: number;
};

function readRecord(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function safeErrorCode(value: string | null, fallback: string | null): string | null {
  return value && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : fallback;
}

function statusFor(
  row: PrepareRow,
  state: MemberSeatReductionStatus['state'],
  phase: MemberSeatReductionStatus['phase'],
  errorCode: string | null = null,
): MemberSeatReductionStatus {
  return { userId: row.user_id, state, phase, errorCode };
}

function confirmedExecution(chain: PreparedChain, execute: ExecuteRow): boolean {
  const request = readRecord(execute.request_json);
  const response = readRecord(execute.response_json);
  if (
    !request
    || request.authorizationId !== chain.authorizationId
    || request.operationType !== 'member_remove'
    || typeof request.operationKey !== 'string'
    || !response
  ) return false;
  try {
    const operation = parseTeamSeatOperation(response.operation);
    const license = response.license;
    return (
      operation.operationType === 'member_remove'
      && operation.operationKey === request.operationKey
      && operation.status === 'applied'
      && operation.requestedQuantity === chain.desiredQuantity
      && operation.effectiveQuantity === chain.desiredQuantity
      && operation.certificateReissueStatus === 'issued'
      && license !== null
      && typeof license === 'object'
      && !Array.isArray(license)
      && (license as Record<string, unknown>).certificatePersisted === true
    );
  } catch {
    return false;
  }
}

/** Reads the selected users' current removal chains without exposing billing payloads. */
export async function getMemberSeatReductionStatuses(
  database: Pick<SqlConnection, 'all'>,
  input: { organizationId: string; userIds: string[] },
): Promise<MemberSeatReductionStatus[]> {
  if (input.userIds.length > MAX_MEMBER_SEAT_REDUCTION_STATUS_USERS) {
    throw new RangeError('At most 100 users can be checked for Seat reduction status.');
  }
  const userIds = [...new Set(input.userIds.filter((userId) => userId.length > 0))];
  if (userIds.length === 0) return [];
  const placeholders = userIds.map((_, index) => `$${index + 2}`).join(', ');
  const rows = await database.all(`
    SELECT
      membership.user_id,
      membership.id AS membership_id,
      preparation.membership_revision,
      preparation.status,
      preparation.request_json,
      preparation.response_json,
      preparation.last_error_code
    FROM team_memberships AS membership
    JOIN LATERAL (
      SELECT membership_revision, status, request_json, response_json, last_error_code
      FROM team_seat_outbox
      WHERE organization_id = membership.organization_id
        AND membership_id = membership.id
        AND operation_kind = 'seat_prepare'
        AND operation_type = 'member_remove'
        AND created_at >= COALESCE(membership.activated_at, membership.created_at)
      ORDER BY membership_revision DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    ) AS preparation ON TRUE
    WHERE membership.organization_id = $1
      AND membership.user_id IN (${placeholders})
      AND membership.status IN ('suspended', 'removed')
  `, [input.organizationId, ...userIds]) as PrepareRow[];

  const statuses = new Map<string, MemberSeatReductionStatus>();
  const chains: PreparedChain[] = [];
  for (const row of rows) {
    if (row.status === 'failed' || row.status === 'canceled') {
      statuses.set(row.user_id, statusFor(row, 'failed', 'prepare', safeErrorCode(
        row.last_error_code,
        row.status === 'canceled' ? 'TEAM_SEAT_REDUCTION_CANCELED' : 'TEAM_SEAT_REDUCTION_FAILED',
      )));
      continue;
    }
    if (row.status !== 'succeeded') {
      statuses.set(row.user_id, statusFor(row, 'pending', 'prepare', safeErrorCode(row.last_error_code, null)));
      continue;
    }
    try {
      const request = readRecord(row.request_json);
      const prepared = parseTeamSeatPrepareResponse(readRecord(row.response_json));
      const desiredQuantity = request?.desiredQuantity;
      if (
        !request
        || request.triggerType !== 'member_remove'
        || request.externalReference !== row.membership_id
        || typeof desiredQuantity !== 'number'
        || !Number.isSafeInteger(desiredQuantity)
        || desiredQuantity < 1
        || prepared.quote.quantityAfter !== desiredQuantity
        || prepared.authorization.quantityAfter !== desiredQuantity
        || prepared.quote.quoteHash !== prepared.authorization.quoteHash
      ) throw new Error('Invalid persisted Seat preparation.');
      if (prepared.authorization.status !== 'approved') {
        statuses.set(row.user_id, statusFor(row, 'pending', 'prepare'));
        continue;
      }
      chains.push({ row, authorizationId: prepared.authorization.authorizationId, desiredQuantity });
      statuses.set(row.user_id, statusFor(row, 'pending', 'execute'));
    } catch {
      statuses.set(row.user_id, statusFor(row, 'failed', 'prepare', 'MEMBERSHIP_SEAT_RESPONSE_INVALID'));
    }
  }

  if (chains.length > 0) {
    const authorizationIds = [...new Set(chains.map((chain) => chain.authorizationId))];
    const executePlaceholders = authorizationIds.map((_, index) => `$${index + 2}`).join(', ');
    const executes = await database.all(`
      SELECT operation_id, membership_id, membership_revision, status,
        request_json, response_json, last_error_code
      FROM team_seat_outbox
      WHERE organization_id = $1
        AND operation_kind = 'seat_execute'
        AND operation_type = 'member_remove'
        AND operation_id IN (${executePlaceholders})
    `, [input.organizationId, ...authorizationIds]) as ExecuteRow[];
    for (const chain of chains) {
      const execute = executes.find((candidate) => (
        candidate.operation_id === chain.authorizationId
        && candidate.membership_id === chain.row.membership_id
        && candidate.membership_revision === chain.row.membership_revision
      ));
      if (!execute) continue;
      if (execute.status === 'failed' || execute.status === 'canceled') {
        statuses.set(chain.row.user_id, statusFor(chain.row, 'failed', 'execute', safeErrorCode(
          execute.last_error_code,
          execute.status === 'canceled' ? 'TEAM_SEAT_REDUCTION_CANCELED' : 'TEAM_SEAT_REDUCTION_FAILED',
        )));
      } else if (execute.status === 'succeeded') {
        statuses.set(chain.row.user_id, confirmedExecution(chain, execute)
          ? statusFor(chain.row, 'completed', 'execute')
          : statusFor(chain.row, 'failed', 'execute', 'MEMBERSHIP_SEAT_NOT_CONFIRMED'));
      } else {
        statuses.set(chain.row.user_id, statusFor(
          chain.row, 'pending', 'execute', safeErrorCode(execute.last_error_code, null),
        ));
      }
    }
  }
  return userIds.flatMap((userId) => {
    const status = statuses.get(userId);
    return status ? [status] : [];
  });
}
