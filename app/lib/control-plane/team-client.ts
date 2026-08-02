import 'server-only';

import { randomUUID } from 'node:crypto';

import packageJson from '@/package.json';
import { TEAM_SEAT_PROTOCOL_VERSION } from '@/app/lib/license/team-seat-contract';

export const TEAM_CONTROL_PLANE_PROTOCOL_HEADER = 'X-Canvas-Team-Seat-Protocol';
export const TEAM_CONTROL_PLANE_OPERATION_HEADER = 'X-Canvas-Operation-Id';
export const TEAM_CONTROL_PLANE_VERSION_HEADER = 'X-Canvas-Notebook-Version';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 5;
const MEMBER_HASH_PATTERN = /\b[a-f0-9]{64}\b/giu;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu;

export type TeamControlPlaneFailureCategory =
  | 'authentication'
  | 'business'
  | 'temporary';

export type TeamControlPlaneLogger = {
  warn: (metadata: Record<string, unknown>, message: string) => void;
};

export type TeamControlPlaneResponse = {
  response: Response;
  payload: Record<string, unknown>;
  operationId: string;
  attemptCount: number;
};

export class TeamControlPlaneTransportError extends Error {
  constructor(
    message: string,
    public readonly operationId: string,
    public readonly attemptCount: number,
  ) {
    super(redactTeamControlPlaneLogText(message));
    this.name = 'TeamControlPlaneTransportError';
  }
}

export function classifyTeamControlPlaneStatus(
  status: number,
): TeamControlPlaneFailureCategory {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return 'temporary';
  }
  return 'business';
}

export function redactTeamControlPlaneLogText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(MEMBER_HASH_PATTERN, '[member-hash-redacted]');
}

function redactKnownSecret(value: string, secret: string | undefined): string {
  const redacted = redactTeamControlPlaneLogText(value);
  return secret ? redacted.replaceAll(secret, '[redacted]') : redacted;
}

function defaultLogger(): TeamControlPlaneLogger {
  return {
    warn(metadata, message) {
      console.warn(`[license/team-control-plane] ${message}`, metadata);
    },
  };
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function retryDelayMs(input: {
  attempt: number;
  response?: Response;
  backoffMs: number;
  maxBackoffMs: number;
}): number {
  const requested = input.response ? retryAfterMs(input.response) : null;
  if (requested !== null) return Math.min(requested, input.maxBackoffMs);
  return Math.min(
    input.maxBackoffMs,
    input.backoffMs * (2 ** Math.max(0, input.attempt - 1)),
  );
}

function normalizedAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(value)) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.min(MAX_ATTEMPTS, value));
}

function normalizedDelay(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function requestHeaders(input: {
  instanceToken?: string;
  operationId: string;
}): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    [TEAM_CONTROL_PLANE_PROTOCOL_HEADER]: TEAM_SEAT_PROTOCOL_VERSION,
    [TEAM_CONTROL_PLANE_OPERATION_HEADER]: input.operationId,
    [TEAM_CONTROL_PLANE_VERSION_HEADER]: packageJson.version || '0.0.0',
  });
  if (input.instanceToken) {
    headers.set('Authorization', `Bearer ${input.instanceToken}`);
  }
  return headers;
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function requestTeamControlPlane(input: {
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  instanceToken?: string;
  operationId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  logger?: TeamControlPlaneLogger;
}): Promise<TeamControlPlaneResponse> {
  const operationId = input.operationId?.trim() || randomUUID();
  const maxAttempts = normalizedAttempts(input.maxAttempts);
  const backoffMs = normalizedDelay(input.backoffMs, DEFAULT_BACKOFF_MS);
  const maxBackoffMs = normalizedDelay(input.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS);
  const timeoutMs = normalizedDelay(input.timeoutMs, DEFAULT_TIMEOUT_MS);
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const logger = input.logger ?? defaultLogger();
  const url = `${input.baseUrl}${input.path}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: input.method,
        headers: requestHeaders({
          instanceToken: input.instanceToken,
          operationId,
        }),
        ...(input.method === 'POST'
          ? { body: JSON.stringify(input.body ?? {}) }
          : {}),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = redactKnownSecret(
        error instanceof Error ? error.message : 'The Team license service is unavailable.',
        input.instanceToken,
      );
      if (attempt >= maxAttempts) {
        throw new TeamControlPlaneTransportError(message, operationId, attempt);
      }
      const delayMs = retryDelayMs({
        attempt,
        backoffMs,
        maxBackoffMs,
      });
      logger.warn({
        operationId,
        endpoint: input.path,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        category: 'temporary',
      }, message);
      await sleep(delayMs);
      continue;
    }

    if (
      classifyTeamControlPlaneStatus(response.status) === 'temporary'
      && attempt < maxAttempts
    ) {
      const delayMs = retryDelayMs({
        attempt,
        response,
        backoffMs,
        maxBackoffMs,
      });
      await response.body?.cancel().catch(() => undefined);
      logger.warn({
        operationId,
        endpoint: input.path,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        status: response.status,
        category: 'temporary',
      }, 'Temporary Control Plane response; retrying the same operation.');
      await sleep(delayMs);
      continue;
    }

    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      response,
      payload,
      operationId,
      attemptCount: attempt,
    };
  }

  throw new TeamControlPlaneTransportError(
    'The Team license service is unavailable.',
    operationId,
    maxAttempts,
  );
}
