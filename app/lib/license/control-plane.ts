import 'server-only';

import { randomUUID } from 'node:crypto';

import { activateLicenseCert, getLicenseControlPlaneUrl } from './index';
import { licenseActivationFailureCode } from './error-codes';
import { getLicenseInstanceId } from './instance';
import {
  createTeamSeatClaimPollRequest,
  createTeamSeatClaimStartRequest,
  parseTeamSeatClaimPollResult,
  parseTeamSeatClaimStart,
  parseTeamSeatErrorPayload,
  TEAM_SEAT_ERROR_CODES,
  TeamSeatContractError,
} from './team-seat-contract';
import {
  requireTeamSeatCommunityClaimRollout,
  TeamSeatRolloutError,
} from './team-seat-rollout';
import {
  getCommunityInstanceTokenStatus,
  loadCommunityClaimSession,
  loadStoredLicenseCert,
  removeCommunityClaimSession,
  saveCommunityClaimSession,
  saveCommunityInstanceToken,
  updateCommunityClaimSession,
  type CommunityClaimSessionSecret,
  type CommunityInstanceTokenStatus,
} from './storage';
import type { LicenseStatus } from './types';

export class LicenseControlPlaneError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'LicenseControlPlaneError';
  }
}

async function postLicenseControlPlane(
  path: string,
  body: Record<string, unknown>,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    unreachableCode?: string;
  },
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  try {
    const response = await (options?.fetchImpl ?? fetch)(`${getLicenseControlPlaneUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { response, payload };
  } catch (error) {
    throw new LicenseControlPlaneError(
      error instanceof Error ? error.message : 'The license service is unavailable.',
      503,
      options?.unreachableCode ?? 'LICENSE_CONTROL_PLANE_UNREACHABLE',
      true,
    );
  }
}

export type CommunityLicenseRegistration = {
  status: string;
  expiresAt: string | null;
};

export async function requestCommunityLicenseRegistration(input: {
  email: string;
  activationUrl: string;
  marketingOptIn: boolean;
}): Promise<CommunityLicenseRegistration> {
  const instanceId = getLicenseInstanceId();
  const { response, payload } = await postLicenseControlPlane('/v1/license/register', {
    email: input.email,
    instanceId,
    activationUrl: input.activationUrl,
    marketingOptIn: input.marketingOptIn,
  });
  if (!response.ok) {
    throw new LicenseControlPlaneError(
      typeof payload.error === 'string' ? payload.error : 'License registration failed.',
      response.status,
      typeof payload.code === 'string' ? payload.code : 'LICENSE_REGISTRATION_FAILED',
    );
  }
  return {
    status: typeof payload.status === 'string' ? payload.status : 'issued',
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
  };
}

export async function activateInstanceLicense(key: string): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();
  const { response, payload } = await postLicenseControlPlane('/v1/license/activate', {
    key,
    instanceId,
  });
  const certificate = typeof payload.license === 'string' ? payload.license : null;
  if (!response.ok || !certificate) {
    const message = typeof payload.error === 'string' ? payload.error : 'License activation failed.';
    throw new LicenseControlPlaneError(
      message,
      response.status || 400,
      typeof payload.code === 'string' ? payload.code : licenseActivationFailureCode(message),
    );
  }
  try {
    return await activateLicenseCert(certificate);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'License activation failed.';
    throw new LicenseControlPlaneError(
      message,
      message.includes('invalid for this instance') ? 400 : 503,
      message.includes('invalid for this instance') ? 'LICENSE_INVALID' : 'LICENSE_CONTROL_PLANE_UNREACHABLE',
    );
  }
}

export type CommunityLicenseClaimPending = {
  state: 'authorization_pending';
  claimId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  nextPollAt: string;
  retryAfterSeconds: number;
  lastErrorCode: string | null;
};

export type CommunityLicenseClaimConnected = {
  state: 'connected';
  claimId: string | null;
  organizationId: string | null;
  token: CommunityInstanceTokenStatus;
};

export type CommunityLicenseClaimIdle = {
  state: 'idle' | 'canceled';
  claimId: string | null;
};

export type CommunityLicenseClaimPublicStatus =
  | CommunityLicenseClaimPending
  | CommunityLicenseClaimConnected
  | CommunityLicenseClaimIdle;

type CommunityClaimClientOptions = {
  fetchImpl?: typeof fetch;
  now?: Date;
};

const COMMUNITY_CLAIM_START_PATH = '/v1/license/claim/v1/start';
const COMMUNITY_CLAIM_POLL_PATH = '/v1/license/claim/v1/poll';
const MAX_CLAIM_BACKOFF_SECONDS = 300;
let communityClaimOperationQueue: Promise<void> = Promise.resolve();

async function withCommunityClaimOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = communityClaimOperationQueue;
  let release = () => {};
  communityClaimOperationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function nowFrom(options?: CommunityClaimClientOptions): Date {
  return options?.now ? new Date(options.now) : new Date();
}

function retryAfterSeconds(session: CommunityClaimSessionSecret, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(session.nextPollAt) - now.getTime()) / 1000));
}

function publicPending(
  session: CommunityClaimSessionSecret,
  now: Date,
): CommunityLicenseClaimPending {
  return {
    state: 'authorization_pending',
    claimId: session.claimId,
    userCode: session.userCode,
    verificationUrl: session.verificationUrl,
    expiresAt: session.expiresAt,
    pollIntervalSeconds: session.pollIntervalSeconds,
    nextPollAt: session.nextPollAt,
    retryAfterSeconds: retryAfterSeconds(session, now),
    lastErrorCode: session.lastErrorCode,
  };
}

function claimErrorFromResponse(
  response: Response,
  payload: Record<string, unknown>,
): LicenseControlPlaneError {
  try {
    const parsed = parseTeamSeatErrorPayload(payload);
    return new LicenseControlPlaneError(
      parsed.error,
      response.status,
      parsed.code,
      parsed.retryable,
    );
  } catch {
    return new LicenseControlPlaneError(
      typeof payload.error === 'string' ? payload.error : 'The Community claim request failed.',
      response.status || 502,
      typeof payload.code === 'string' ? payload.code : TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      response.status === 429 || response.status >= 500,
    );
  }
}

function contractResponseError(error: unknown): LicenseControlPlaneError {
  if (error instanceof TeamSeatContractError) {
    return new LicenseControlPlaneError(
      `The Control Plane returned an invalid Team Seat response at ${error.path}.`,
      502,
      error.code,
      false,
    );
  }
  throw error;
}

function localClaimError(
  message: string,
  status: number,
  code: string,
): LicenseControlPlaneError {
  return new LicenseControlPlaneError(message, status, code, false);
}

async function claimCertificate(instanceId: string): Promise<string> {
  const environmentCertificate = process.env.CANVAS_LICENSE_CERT?.trim();
  const certificate = environmentCertificate || await loadStoredLicenseCert(instanceId);
  if (!certificate) {
    throw localClaimError(
      'A Community license must be activated before it can be connected.',
      409,
      TEAM_SEAT_ERROR_CODES.subjectNotFound,
    );
  }
  return certificate;
}

function isTerminalClaimError(error: LicenseControlPlaneError): boolean {
  return error.code === TEAM_SEAT_ERROR_CODES.claimExpired
    || error.code === TEAM_SEAT_ERROR_CODES.claimConflict
    || error.code === TEAM_SEAT_ERROR_CODES.claimReplay
    || error.code === TEAM_SEAT_ERROR_CODES.tokenInvalid
    || error.code === TEAM_SEAT_ERROR_CODES.tokenInstanceMismatch
    || error.code === TEAM_SEAT_ERROR_CODES.protocolUnsupported
    || error.code === TEAM_SEAT_ERROR_CODES.featureDisabled;
}

function nextBackoffSeconds(session: CommunityClaimSessionSecret): number {
  const exponent = Math.min(session.consecutiveFailures, 6);
  return Math.min(
    MAX_CLAIM_BACKOFF_SECONDS,
    Math.max(session.pollIntervalSeconds, session.pollIntervalSeconds * (2 ** exponent)),
  );
}

async function recordClaimPollFailure(
  session: CommunityClaimSessionSecret,
  error: LicenseControlPlaneError,
  now: Date,
): Promise<LicenseControlPlaneError> {
  const backoffSeconds = nextBackoffSeconds(session);
  const expiry = Date.parse(session.expiresAt);
  const nextPollAt = new Date(Math.min(
    expiry,
    now.getTime() + backoffSeconds * 1000,
  )).toISOString();
  await updateCommunityClaimSession(session.claimId, {
    ...session,
    consecutiveFailures: session.consecutiveFailures + 1,
    nextPollAt,
    lastPolledAt: now.toISOString(),
    lastErrorCode: error.code,
    updatedAt: now.toISOString(),
  });
  return new LicenseControlPlaneError(
    error.message,
    error.status,
    error.code,
    true,
    Math.max(0, Math.ceil((Date.parse(nextPollAt) - now.getTime()) / 1000)),
  );
}

export async function getCommunityLicenseClaimStatus(
  options?: CommunityClaimClientOptions,
): Promise<CommunityLicenseClaimPublicStatus> {
  const instanceId = getLicenseInstanceId();
  const token = await getCommunityInstanceTokenStatus(instanceId);
  const session = await loadCommunityClaimSession(instanceId);
  if (token.configured) {
    if (session) await removeCommunityClaimSession(session.claimId);
    return {
      state: 'connected',
      claimId: session?.claimId ?? null,
      organizationId: null,
      token,
    };
  }
  if (!session) return { state: 'idle', claimId: null };
  const now = nowFrom(options);
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    await removeCommunityClaimSession(session.claimId);
    return { state: 'idle', claimId: null };
  }
  return publicPending(session, now);
}

export async function startCommunityLicenseClaim(
  options?: CommunityClaimClientOptions,
): Promise<CommunityLicenseClaimPending> {
  return withCommunityClaimOperationLock(async () => {
    requireTeamSeatCommunityClaimRollout();
    const instanceId = getLicenseInstanceId();
    const now = nowFrom(options);
    const token = await getCommunityInstanceTokenStatus(instanceId);
    if (token.configured) {
      throw localClaimError(
        'This Notebook instance is already connected to the Control Plane.',
        409,
        TEAM_SEAT_ERROR_CODES.claimConflict,
      );
    }
    const existing = await loadCommunityClaimSession(instanceId);
    if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
      return publicPending(existing, now);
    }
    if (existing) await removeCommunityClaimSession(existing.claimId);

    const certificate = await claimCertificate(instanceId);
    const { response, payload } = await postLicenseControlPlane(
      COMMUNITY_CLAIM_START_PATH,
      createTeamSeatClaimStartRequest({
        licenseCertificate: certificate,
        instanceId,
      }),
      {
        fetchImpl: options?.fetchImpl,
        unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      },
    );
    if (!response.ok) throw claimErrorFromResponse(response, payload);

    let claim;
    try {
      claim = parseTeamSeatClaimStart(payload.claim);
    } catch (error) {
      throw contractResponseError(error);
    }
    if (Date.parse(claim.expiresAt) <= now.getTime()) {
      throw localClaimError(
        'The Control Plane returned an already expired Community claim.',
        502,
        TEAM_SEAT_ERROR_CODES.claimExpired,
      );
    }

    const timestamp = now.toISOString();
    const session = await saveCommunityClaimSession({
      claimId: `community-claim-${randomUUID()}`,
      instanceId,
      deviceCode: claim.deviceCode,
      userCode: claim.userCode,
      verificationUrl: claim.verificationUrl,
      expiresAt: claim.expiresAt,
      pollIntervalSeconds: claim.pollIntervalSeconds,
      consecutiveFailures: 0,
      nextPollAt: timestamp,
      startedAt: timestamp,
      lastPolledAt: null,
      lastErrorCode: null,
      updatedAt: timestamp,
    });
    return publicPending(session, now);
  });
}

export async function pollCommunityLicenseClaim(
  claimId: string,
  options?: CommunityClaimClientOptions,
): Promise<CommunityLicenseClaimPending | CommunityLicenseClaimConnected> {
  return withCommunityClaimOperationLock(async () => {
    requireTeamSeatCommunityClaimRollout();
    const instanceId = getLicenseInstanceId();
    const now = nowFrom(options);
    const session = await loadCommunityClaimSession(instanceId);
    if (!session || session.claimId !== claimId) {
      const token = await getCommunityInstanceTokenStatus(instanceId);
      if (token.configured) {
        return {
          state: 'connected',
          claimId,
          organizationId: null,
          token,
        };
      }
      throw localClaimError(
        'The Community claim session was not found.',
        404,
        TEAM_SEAT_ERROR_CODES.claimExpired,
      );
    }
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      await removeCommunityClaimSession(session.claimId);
      throw localClaimError(
        'The Community claim session has expired.',
        410,
        TEAM_SEAT_ERROR_CODES.claimExpired,
      );
    }
    if (Date.parse(session.nextPollAt) > now.getTime()) {
      return publicPending(session, now);
    }

    let response: Response;
    let payload: Record<string, unknown>;
    try {
      ({ response, payload } = await postLicenseControlPlane(
        COMMUNITY_CLAIM_POLL_PATH,
        createTeamSeatClaimPollRequest(session.deviceCode),
        {
          fetchImpl: options?.fetchImpl,
          unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
        },
      ));
    } catch (error) {
      if (error instanceof LicenseControlPlaneError && error.retryable) {
        throw await recordClaimPollFailure(session, error, now);
      }
      throw error;
    }
    if (!response.ok) {
      const error = claimErrorFromResponse(response, payload);
      if (isTerminalClaimError(error)) {
        await removeCommunityClaimSession(session.claimId);
        throw error;
      }
      if (error.retryable) throw await recordClaimPollFailure(session, error, now);
      throw error;
    }

    let result;
    try {
      result = parseTeamSeatClaimPollResult(payload.claim);
    } catch (error) {
      throw contractResponseError(error);
    }
    if (result.status === 'authorization_pending') {
      const expiresAt = new Date(Math.min(
        Date.parse(session.expiresAt),
        Date.parse(result.expiresAt),
      )).toISOString();
      const next: CommunityClaimSessionSecret = {
        ...session,
        expiresAt,
        pollIntervalSeconds: result.pollIntervalSeconds,
        consecutiveFailures: 0,
        nextPollAt: new Date(now.getTime() + result.pollIntervalSeconds * 1000).toISOString(),
        lastPolledAt: now.toISOString(),
        lastErrorCode: null,
        updatedAt: now.toISOString(),
      };
      await updateCommunityClaimSession(session.claimId, next);
      return publicPending(next, now);
    }
    if (result.instanceId !== instanceId) {
      await removeCommunityClaimSession(session.claimId);
      throw localClaimError(
        'The claimed Community token belongs to another Notebook instance.',
        409,
        TEAM_SEAT_ERROR_CODES.tokenInstanceMismatch,
      );
    }

    const token = await saveCommunityInstanceToken({
      instanceId: result.instanceId,
      instanceToken: result.instanceToken,
      tokenType: result.tokenType,
      scopes: result.scopes,
      expiresAt: result.expiresAt,
      now,
    });
    await removeCommunityClaimSession(session.claimId);
    return {
      state: 'connected',
      claimId: session.claimId,
      organizationId: result.organizationId,
      token,
    };
  });
}

export async function cancelCommunityLicenseClaim(
  claimId: string,
): Promise<CommunityLicenseClaimIdle> {
  return withCommunityClaimOperationLock(async () => {
    const session = await loadCommunityClaimSession(getLicenseInstanceId());
    if (session && session.claimId !== claimId) {
      throw localClaimError(
        'The Community claim session changed before cancellation.',
        409,
        TEAM_SEAT_ERROR_CODES.claimConflict,
      );
    }
    if (session) await removeCommunityClaimSession(session.claimId);
    return { state: 'canceled', claimId };
  });
}

export function communityLicenseClaimErrorPayload(
  error: LicenseControlPlaneError | TeamSeatRolloutError,
) {
  return {
    success: false,
    error: error.message,
    code: error.code,
    retryable: error instanceof LicenseControlPlaneError ? error.retryable : false,
    retryAfterSeconds: error instanceof LicenseControlPlaneError
      ? error.retryAfterSeconds
      : null,
  };
}
