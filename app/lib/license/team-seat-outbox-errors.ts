import 'server-only';

import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import { LicenseControlPlaneError } from './control-plane';
import {
  TEAM_SEAT_ERROR_CODES,
  TeamSeatContractError,
} from './team-seat-contract';
import type { TeamSeatOutboxOperation } from './team-seat-outbox';

const DEFAULT_RETRY_BASE_MS = 15_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;

export type TeamSeatOutboxFailure = {
  code: string;
  message: string;
  terminal: boolean;
  retryAfterMs: number | null;
};

export function classifyTeamSeatOutboxFailure(
  error: unknown,
): TeamSeatOutboxFailure {
  const message = redactTeamControlPlaneLogText(
    error instanceof Error
      ? error.message
      : 'The Team Seat operation could not be completed.',
  ).slice(0, 2_000);

  if (error instanceof LicenseControlPlaneError) {
    return {
      code: error.code,
      message,
      terminal: !error.retryable || error.category !== 'temporary',
      retryAfterMs: error.retryAfterSeconds === null
        ? null
        : Math.max(0, error.retryAfterSeconds * 1_000),
    };
  }
  if (error instanceof TeamSeatContractError) {
    return {
      code: error.code,
      message,
      terminal: true,
      retryAfterMs: null,
    };
  }

  const namedError = error && typeof error === 'object'
    && 'name' in error && typeof error.name === 'string'
    ? error.name
    : '';
  const code = error && typeof error === 'object'
    && 'code' in error && typeof error.code === 'string'
    ? error.code
    : TEAM_SEAT_ERROR_CODES.temporaryUnavailable;
  const retryable = error && typeof error === 'object'
    && 'retryable' in error && error.retryable === true;
  const status = error && typeof error === 'object'
    && 'status' in error && typeof error.status === 'number'
    ? error.status
    : null;
  const terminal = (
    namedError === 'MembershipOrchestratorError'
    || namedError === 'TeamSeatOutboxError'
    || (!retryable && status !== null && status >= 400 && status < 500)
  );
  return {
    code,
    message,
    terminal,
    retryAfterMs: null,
  };
}

export function teamSeatOutboxRetryDelay(
  operation: Pick<TeamSeatOutboxOperation, 'attemptCount'>,
  requestedDelayMs: number | null = null,
): number {
  if (requestedDelayMs !== null) {
    return Math.min(DEFAULT_RETRY_MAX_MS, Math.max(0, requestedDelayMs));
  }
  return Math.min(
    DEFAULT_RETRY_MAX_MS,
    DEFAULT_RETRY_BASE_MS * (2 ** Math.min(operation.attemptCount, 6)),
  );
}
