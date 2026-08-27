import 'server-only';

import { randomUUID } from 'node:crypto';

import packageJson from '@/package.json';
import {
  classifyTeamControlPlaneStatus,
  redactTeamControlPlaneLogText,
  requestTeamControlPlane,
  type TeamControlPlaneFailureCategory,
} from '@/app/lib/control-plane/team-client';
import { activateLicenseCert, getLicenseControlPlaneUrl } from './index';
import { licenseActivationFailureCode } from './error-codes';
import { getLicenseInstanceId } from './instance';
import { LicenseCertificateValidationError } from './jwt';
import { logLicenseError } from './logging';
import {
  loadPendingLicenseEmailActivation,
  removePendingLicenseEmailActivation,
  type PendingLicenseEmailActivation,
} from './email-activation-storage';
import {
  getCommunityTeamRuntimeReadiness,
  withCommunityTeamVersionReadiness,
  type TeamRuntimeReadinessStatus,
} from './team-runtime-readiness';
import {
  createTeamSeatClaimPollRequest,
  createTeamSeatClaimStartRequest,
  createTeamSeatPreflightRequest,
  parseTeamSeatPrepareResponse,
  parseTeamSeatQuoteStatusResponse,
  parseTeamSeatExecuteResponse,
  parseTeamSeatSnapshotResponse,
  createTeamSeatTokenLifecycleRequest,
  parseTeamSeatClaimPollResult,
  parseTeamSeatClaimStart,
  parseTeamSeatErrorPayload,
  parseTeamSeatLicenseRefresh,
  parseTeamSeatPreflightResponse,
  parseTeamSeatTokenRotation,
  TEAM_SEAT_ERROR_CODES,
  TeamSeatContractError,
  type TeamSeatCommunityPreflightResponse,
  type TeamSeatLicenseRefresh,
  type TeamSeatPrepareRequest,
  type TeamSeatPrepareResponse,
  type TeamSeatQuoteStatusResponse,
  type TeamSeatExecuteRequest,
  type TeamSeatExecuteResponse,
  type TeamSeatSnapshotRequest,
  type TeamSeatSnapshotResponse,
} from './team-seat-contract';
import {
  requireTeamSeatClientRollout,
  requireTeamSeatCommunityClaimRollout,
  TeamSeatRolloutError,
} from './team-seat-rollout';
import {
  getCommunityInstanceTokenStatus,
  loadCommunityClaimSession,
  loadCommunityConnectionRecoveryState,
  loadCommunityInstanceToken,
  loadStoredLicenseCert,
  markCommunityConnectionReconnectRequired,
  removeCommunityClaimSession,
  rotateCommunityInstanceToken,
  saveCommunityClaimSession,
  saveCommunityInstanceToken,
  updateCommunityClaimSession,
  type CommunityClaimSessionSecret,
  type CommunityConnectionRecoveryReason,
  type CommunityInstanceTokenStatus,
  CommunityInstanceTokenStorageError,
  LicenseCertificateStorageError,
} from './storage';
import { signalTeamMembershipSnapshotSync } from './team-membership-sync-signal';
import type { LicenseStatus } from './types';

export class LicenseControlPlaneError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds: number | null = null,
    public readonly category: TeamControlPlaneFailureCategory | 'contract' =
      classifyTeamControlPlaneStatus(status),
  ) {
    super(redactTeamControlPlaneLogText(message));
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
    authorization?: {
      tokenType: 'Bearer';
      token: string;
    };
    operationId?: string;
    maxAttempts?: number;
  },
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  try {
    const result = await requestTeamControlPlane({
      baseUrl: getLicenseControlPlaneUrl(),
      path,
      method: 'POST',
      body,
      instanceToken: options?.authorization?.token,
      operationId: options?.operationId,
      fetchImpl: options?.fetchImpl,
      timeoutMs: options?.timeoutMs,
      maxAttempts: options?.maxAttempts ?? 1,
    });
    return { response: result.response, payload: result.payload };
  } catch (error) {
    logLicenseError('[license/control-plane]', 'Control Plane POST request failed', {
      endpoint: path,
      unreachableCode: options?.unreachableCode ?? 'LICENSE_CONTROL_PLANE_UNREACHABLE',
    }, error, {
      knownSecrets: options?.authorization ? [options.authorization.token] : [],
    });
    const message = error instanceof Error
      ? error.message
      : 'The license service is unavailable.';
    throw new LicenseControlPlaneError(
      message,
      503,
      options?.unreachableCode ?? 'LICENSE_CONTROL_PLANE_UNREACHABLE',
      true,
      null,
      'temporary',
    );
  }
}

async function getLicenseControlPlane(
  path: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    unreachableCode?: string;
    authorization: {
      tokenType: 'Bearer';
      token: string;
    };
    operationId?: string;
    maxAttempts?: number;
  },
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  try {
    const result = await requestTeamControlPlane({
      baseUrl: getLicenseControlPlaneUrl(),
      path,
      method: 'GET',
      instanceToken: options.authorization.token,
      operationId: options.operationId,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts ?? 1,
    });
    return { response: result.response, payload: result.payload };
  } catch (error) {
    logLicenseError('[license/control-plane]', 'Control Plane GET request failed', {
      endpoint: path,
      unreachableCode: options.unreachableCode ?? 'LICENSE_CONTROL_PLANE_UNREACHABLE',
    }, error, {
      knownSecrets: [options.authorization.token],
    });
    const message = error instanceof Error
      ? error.message
      : 'The license service is unavailable.';
    throw new LicenseControlPlaneError(
      message,
      503,
      options.unreachableCode ?? 'LICENSE_CONTROL_PLANE_UNREACHABLE',
      true,
      null,
      'temporary',
    );
  }
}

export type CommunityLicenseRegistration = {
  status: string;
  expiresAt: string | null;
  activation: Pick<
    PendingLicenseEmailActivation,
    'activationId' | 'pollToken' | 'expiresAt' | 'pollIntervalSeconds'
  > | null;
};

function parseCommunityLicenseRegistrationActivation(value: unknown): CommunityLicenseRegistration['activation'] {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LicenseControlPlaneError('License registration returned an invalid activation request.', 502, 'LICENSE_EMAIL_ACTIVATION_CONTRACT_INVALID', false, null, 'contract');
  }
  const activation = value as Record<string, unknown>;
  if (
    typeof activation.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(activation.id)
    || typeof activation.pollToken !== 'string'
    || !/^lep_[0-9a-f]{64}$/u.test(activation.pollToken)
    || typeof activation.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(activation.expiresAt))
    || typeof activation.pollIntervalSeconds !== 'number'
    || !Number.isSafeInteger(activation.pollIntervalSeconds)
    || activation.pollIntervalSeconds < 1
    || activation.pollIntervalSeconds > 300
  ) {
    throw new LicenseControlPlaneError('License registration returned an invalid activation request.', 502, 'LICENSE_EMAIL_ACTIVATION_CONTRACT_INVALID', false, null, 'contract');
  }
  return {
    activationId: activation.id,
    pollToken: activation.pollToken,
    expiresAt: activation.expiresAt,
    pollIntervalSeconds: activation.pollIntervalSeconds,
  };
}

export async function requestCommunityLicenseRegistration(input: {
  email: string;
  activationUrl: string;
  marketingOptIn: boolean;
}, options?: {
  fetchImpl?: typeof fetch;
}): Promise<CommunityLicenseRegistration> {
  const instanceId = getLicenseInstanceId();
  const { response, payload } = await postLicenseControlPlane('/v1/license/register', {
    email: input.email,
    instanceId,
    activationUrl: input.activationUrl,
    marketingOptIn: input.marketingOptIn,
  }, { fetchImpl: options?.fetchImpl });
  if (!response.ok) {
    const message = typeof payload.error === 'string'
      ? redactTeamControlPlaneLogText(payload.error, [input.email])
      : 'License registration failed.';
    throw new LicenseControlPlaneError(
      message,
      response.status,
      typeof payload.code === 'string' ? payload.code : 'LICENSE_REGISTRATION_FAILED',
    );
  }
  return {
    status: typeof payload.status === 'string' ? payload.status : 'issued',
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
    activation: parseCommunityLicenseRegistrationActivation(payload.activation),
  };
}

export type CommunityLicenseEmailActivationStatus =
  | { state: 'idle' }
  | {
      state: 'authorization_pending';
      expiresAt: string;
      pollIntervalSeconds: number;
    }
  | {
      state: 'activated';
      license: LicenseStatus;
    };

function pendingEmailActivationStatus(pending: PendingLicenseEmailActivation): CommunityLicenseEmailActivationStatus {
  return {
    state: 'authorization_pending',
    expiresAt: pending.expiresAt,
    pollIntervalSeconds: pending.pollIntervalSeconds,
  };
}

export async function pollPendingLicenseEmailActivation(options?: {
  fetchImpl?: typeof fetch;
}): Promise<CommunityLicenseEmailActivationStatus> {
  const pending = await loadPendingLicenseEmailActivation();
  if (!pending) return { state: 'idle' };
  const instanceId = getLicenseInstanceId();
  if (pending.instanceId !== instanceId) {
    await removePendingLicenseEmailActivation();
    throw new LicenseControlPlaneError(
      'The stored license activation belongs to another instance.',
      409,
      'LICENSE_EMAIL_ACTIVATION_INSTANCE_MISMATCH',
    );
  }
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    await removePendingLicenseEmailActivation();
    throw new LicenseControlPlaneError(
      'The license activation request has expired.',
      410,
      'LICENSE_EMAIL_ACTIVATION_EXPIRED',
    );
  }

  let response: Response;
  let payload: Record<string, unknown>;
  try {
    const result = await requestTeamControlPlane({
      baseUrl: getLicenseControlPlaneUrl(),
      path: '/v1/license/activation/v1/poll',
      method: 'POST',
      body: {
        activationId: pending.activationId,
        pollToken: pending.pollToken,
        instanceId,
      },
      fetchImpl: options?.fetchImpl,
      maxAttempts: 1,
    });
    response = result.response;
    payload = result.payload;
  } catch (error) {
    logLicenseError('[license/email-activation]', 'Control Plane activation poll failed', {
      endpoint: '/v1/license/activation/v1/poll',
    }, error, {
      knownSecrets: [pending.pollToken],
    });
    throw new LicenseControlPlaneError(
      'The license service is unavailable.',
      503,
      'LICENSE_CONTROL_PLANE_UNREACHABLE',
      true,
      null,
      'temporary',
    );
  }

  const activation = payload.activation && typeof payload.activation === 'object' && !Array.isArray(payload.activation)
    ? payload.activation as Record<string, unknown>
    : null;
  const errorCode = typeof payload.code === 'string' ? payload.code : 'LICENSE_EMAIL_ACTIVATION_FAILED';
  if (response.status === 429 && errorCode === 'LICENSE_EMAIL_ACTIVATION_PENDING') {
    return pendingEmailActivationStatus(pending);
  }
  if (!response.ok) {
    if ([401, 404, 409, 410].includes(response.status)) {
      await removePendingLicenseEmailActivation();
    }
    const message = typeof payload.error === 'string'
      ? redactTeamControlPlaneLogText(payload.error, [pending.pollToken])
      : 'License activation failed.';
    throw new LicenseControlPlaneError(
      message,
      response.status,
      errorCode,
      payload.retryable === true,
    );
  }
  if (activation?.status === 'authorization_pending') {
    return {
      state: 'authorization_pending',
      expiresAt: typeof activation.expiresAt === 'string' ? activation.expiresAt : pending.expiresAt,
      pollIntervalSeconds: typeof activation.pollIntervalSeconds === 'number'
        ? activation.pollIntervalSeconds
        : pending.pollIntervalSeconds,
    };
  }
  if (activation?.status !== 'activated' || typeof activation.license !== 'string') {
    throw new LicenseControlPlaneError(
      'The license service returned an invalid activation response.',
      502,
      'LICENSE_EMAIL_ACTIVATION_CONTRACT_INVALID',
      false,
      null,
      'contract',
    );
  }
  try {
    const license = await activateLicenseCert(activation.license);
    await removePendingLicenseEmailActivation();
    return { state: 'activated', license };
  } catch (error) {
    if (
      error instanceof LicenseCertificateValidationError
      || error instanceof LicenseCertificateStorageError
    ) {
      throw new LicenseControlPlaneError(error.message, 400, error.code);
    }
    throw new LicenseControlPlaneError(
      'The activated license could not be stored.',
      503,
      'LICENSE_EMAIL_ACTIVATION_STORAGE_FAILED',
    );
  }
}

export async function activateInstanceLicense(key: string): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();
  const { response, payload } = await postLicenseControlPlane('/v1/license/activate', {
    key,
    instanceId,
  });
  const certificate = typeof payload.license === 'string' ? payload.license : null;
  if (!response.ok || !certificate) {
    const message = typeof payload.error === 'string'
      ? redactTeamControlPlaneLogText(payload.error, [key])
      : 'License activation failed.';
    throw new LicenseControlPlaneError(
      message,
      response.status || 400,
      typeof payload.code === 'string' ? payload.code : licenseActivationFailureCode(message),
    );
  }
  try {
    return await activateLicenseCert(certificate);
  } catch (error) {
    if (
      error instanceof LicenseCertificateValidationError
      || error instanceof LicenseCertificateStorageError
    ) {
      throw new LicenseControlPlaneError(error.message, 400, error.code);
    }
    const message = error instanceof Error ? error.message : 'License activation failed.';
    throw new LicenseControlPlaneError(
      message,
      503,
      'LICENSE_CONTROL_PLANE_UNREACHABLE',
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
  token: CommunityInstanceConnectionStatus;
};

export type CommunityInstanceConnectionStatus = Pick<
  CommunityInstanceTokenStatus,
  'configured' | 'expiresAt' | 'expired'
>;

export type CommunityLicenseClaimIdle = {
  state: 'idle' | 'canceled';
  claimId: string | null;
};

export type CommunityLicenseClaimReconnectRequired = {
  state: 'reconnect_required';
  claimId: null;
  reason: CommunityConnectionRecoveryReason;
  detectedAt: string;
  coreUnaffected: true;
  teamAccessPolicy: 'signed_certificate_until_expiry';
};

export type CommunityLicenseClaimPublicStatus =
  | CommunityLicenseClaimPending
  | CommunityLicenseClaimConnected
  | CommunityLicenseClaimReconnectRequired
  | CommunityLicenseClaimIdle;

type CommunityClaimClientOptions = {
  fetchImpl?: typeof fetch;
  now?: Date;
};

const COMMUNITY_CLAIM_START_PATH = '/v1/license/claim/v1/start';
const COMMUNITY_CLAIM_POLL_PATH = '/v1/license/claim/v1/poll';
const COMMUNITY_TEAM_PREFLIGHT_PATH = '/v1/license/community/v1/team/preflight';
const COMMUNITY_SEAT_PREPARE_PATH = '/v1/license/community/v1/seats/prepare';
const COMMUNITY_SEAT_EXECUTE_PATH = '/v1/license/community/v1/seats/execute';
const COMMUNITY_SEAT_QUOTE_PATH = '/v1/license/community/v1/seats/quotes';
const COMMUNITY_SEAT_SNAPSHOT_PATH = '/v1/license/community/v1/seats/snapshot';
const COMMUNITY_TOKEN_ROTATE_PATH = '/v1/license/community/v1/token/rotate';
const COMMUNITY_LICENSE_REFRESH_PATH = '/v1/license/community/v1/refresh';
const MAX_CLAIM_BACKOFF_SECONDS = 300;
let communityClaimOperationQueue: Promise<void> = Promise.resolve();

async function requireCommunitySeatToken(
  scope: 'seat:prepare' | 'seat:execute' | 'seat:snapshot',
  now = new Date(),
) {
  const instanceId = getLicenseInstanceId();
  const token = await loadCommunityInstanceToken(instanceId);
  if (!token) {
    throw localClaimError(
      'Connect this Community license before changing Team Seats.',
      409,
      TEAM_SEAT_ERROR_CODES.accountRequired,
    );
  }
  if (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime()) {
    await markCommunityConnectionReconnectRequired({
      instanceId,
      expectedToken: token.instanceToken,
      reason: 'expired',
      now,
    });
    throw localClaimError(
      'The Community instance connection expired and must be restored.',
      401,
      TEAM_SEAT_ERROR_CODES.tokenInvalid,
    );
  }
  if (!token.scopes.includes(scope)) {
    throw localClaimError(
      `The Community instance connection does not permit ${scope}.`,
      403,
      TEAM_SEAT_ERROR_CODES.tokenScopeDenied,
    );
  }
  return { instanceId, token };
}

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

export function publicCommunityInstanceTokenStatus(
  status: CommunityInstanceTokenStatus,
): CommunityInstanceConnectionStatus {
  return {
    configured: status.configured,
    expiresAt: status.expiresAt,
    expired: status.expired,
  };
}

function claimErrorFromResponse(
  response: Response,
  payload: Record<string, unknown>,
): LicenseControlPlaneError {
  try {
    const parsed = parseTeamSeatErrorPayload(payload);
    return new LicenseControlPlaneError(
      redactTeamControlPlaneLogText(parsed.error),
      response.status,
      parsed.code,
      parsed.retryable,
      null,
      classifyTeamControlPlaneStatus(response.status),
    );
  } catch {
    return new LicenseControlPlaneError(
      typeof payload.error === 'string'
        ? redactTeamControlPlaneLogText(payload.error)
        : 'The Community claim request failed.',
      response.status || 502,
      typeof payload.code === 'string' ? payload.code : TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      response.status === 429 || response.status >= 500,
      null,
      classifyTeamControlPlaneStatus(response.status),
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
      null,
      'contract',
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

function reconnectReasonFor(
  error: LicenseControlPlaneError,
): CommunityConnectionRecoveryReason | null {
  if (error.code === TEAM_SEAT_ERROR_CODES.tokenInvalid) return 'revoked';
  if (error.code === TEAM_SEAT_ERROR_CODES.tokenInstanceMismatch) return 'invalid';
  return null;
}

async function recordRejectedCommunityToken(
  error: LicenseControlPlaneError,
  input: { instanceId: string; instanceToken: string },
): Promise<void> {
  const reason = reconnectReasonFor(error);
  if (!reason) return;
  try {
    await markCommunityConnectionReconnectRequired({
      instanceId: input.instanceId,
      expectedToken: input.instanceToken,
      reason,
    });
  } catch (storageError) {
    if (
      storageError instanceof CommunityInstanceTokenStorageError
      && storageError.code === 'TOKEN_ROTATION_CONFLICT'
    ) {
      return;
    }
    throw storageError;
  }
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
  if (token.configured && token.expired) {
    const recovery = await markCommunityConnectionReconnectRequired({
      instanceId,
      reason: 'expired',
      now: nowFrom(options),
    });
    return {
      state: 'reconnect_required',
      claimId: null,
      reason: recovery.reason,
      detectedAt: recovery.detectedAt,
      coreUnaffected: true,
      teamAccessPolicy: 'signed_certificate_until_expiry',
    };
  }
  if (token.configured) {
    if (session) await removeCommunityClaimSession(session.claimId);
    return {
      state: 'connected',
      claimId: session?.claimId ?? null,
      organizationId: null,
      token: publicCommunityInstanceTokenStatus(token),
    };
  }
  if (!session) {
    const recovery = await loadCommunityConnectionRecoveryState(instanceId);
    return recovery
      ? {
          state: 'reconnect_required',
          claimId: null,
          reason: recovery.reason,
          detectedAt: recovery.detectedAt,
          coreUnaffected: true,
          teamAccessPolicy: 'signed_certificate_until_expiry',
        }
      : { state: 'idle', claimId: null };
  }
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
    if (token.configured && !token.expired) {
      throw localClaimError(
        'This Notebook instance is already connected to the Control Plane.',
        409,
        TEAM_SEAT_ERROR_CODES.claimConflict,
      );
    }
    if (token.configured) {
      await markCommunityConnectionReconnectRequired({
        instanceId,
        reason: 'expired',
        now,
      });
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
          token: publicCommunityInstanceTokenStatus(token),
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
    signalTeamMembershipSnapshotSync({ forceReport: true });
    return {
      state: 'connected',
      claimId: session.claimId,
      organizationId: result.organizationId,
      token: publicCommunityInstanceTokenStatus(token),
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

export type CommunityTeamUpgradeRuntimeSnapshot = {
  notebookVersion: string;
  databaseEngine: 'postgres' | 'sqlite' | 'other';
  teamReady: boolean;
};

type CommunityTeamUpgradePreflightOptions = {
  fetchImpl?: typeof fetch;
  runtime?: CommunityTeamUpgradeRuntimeSnapshot;
  runtimeReadiness?: TeamRuntimeReadinessStatus;
};

function runtimeSnapshot(
  readiness: TeamRuntimeReadinessStatus,
): CommunityTeamUpgradeRuntimeSnapshot {
  return {
    notebookVersion: packageJson.version || '0.0.0',
    databaseEngine: readiness.databaseEngine,
    teamReady: readiness.ready,
  };
}

export async function getCommunityTeamUpgradeRuntimeSnapshot():
Promise<CommunityTeamUpgradeRuntimeSnapshot> {
  return runtimeSnapshot(await getCommunityTeamRuntimeReadiness());
}

export type CommunityTeamUpgradePreflight = Omit<
  TeamSeatCommunityPreflightResponse,
  'runtime' | 'blockers'
> & {
  runtime: TeamSeatCommunityPreflightResponse['runtime'] & {
    readiness: TeamRuntimeReadinessStatus;
  };
  blockers: Array<{ code: string; message: string }>;
};

export async function getCommunityTeamUpgradePreflight(
  options?: CommunityTeamUpgradePreflightOptions,
): Promise<CommunityTeamUpgradePreflight> {
  requireTeamSeatClientRollout();
  const instanceId = getLicenseInstanceId();
  const token = await loadCommunityInstanceToken(instanceId);
  if (!token) {
    throw localClaimError(
      'Connect this Community license to a verified Control Plane account first.',
      409,
      TEAM_SEAT_ERROR_CODES.accountRequired,
    );
  }
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
    await markCommunityConnectionReconnectRequired({
      instanceId,
      expectedToken: token.instanceToken,
      reason: 'expired',
    });
    throw localClaimError(
      'The Community instance connection has expired and must be restored.',
      401,
      TEAM_SEAT_ERROR_CODES.tokenInvalid,
    );
  }
  if (!token.scopes.includes('seat:prepare')) {
    throw localClaimError(
      'The Community instance connection does not permit Team upgrade checks.',
      403,
      TEAM_SEAT_ERROR_CODES.tokenScopeDenied,
    );
  }

  const localReadiness = options?.runtimeReadiness
    ?? await getCommunityTeamRuntimeReadiness();
  const runtime = options?.runtime ?? runtimeSnapshot(localReadiness);
  const { response, payload } = await postLicenseControlPlane(
    COMMUNITY_TEAM_PREFLIGHT_PATH,
    createTeamSeatPreflightRequest(runtime),
    {
      fetchImpl: options?.fetchImpl,
      unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      authorization: {
        tokenType: token.tokenType,
        token: token.instanceToken,
      },
      maxAttempts: 3,
    },
  );
  if (!response.ok) {
    const error = claimErrorFromResponse(response, payload);
    await recordRejectedCommunityToken(error, {
      instanceId,
      instanceToken: token.instanceToken,
    });
    throw error;
  }

  try {
    const preflight = parseTeamSeatPreflightResponse(payload.preflight);
    if (preflight.license.instanceId !== instanceId) {
      throw localClaimError(
        'The Control Plane returned Team readiness for another Notebook instance.',
        409,
        TEAM_SEAT_ERROR_CODES.instanceMismatch,
      );
    }
    if (
      preflight.runtime.notebookVersion !== runtime.notebookVersion
      || preflight.runtime.databaseEngine !== runtime.databaseEngine
      || preflight.runtime.teamReady !== runtime.teamReady
    ) {
      throw new TeamSeatContractError(
        TEAM_SEAT_ERROR_CODES.invalidRequest,
        'The Control Plane preflight runtime does not match the submitted Notebook runtime.',
        'preflight.runtime',
      );
    }
    const readiness = withCommunityTeamVersionReadiness(localReadiness, {
      current: preflight.runtime.notebookVersion,
      minimum: preflight.runtime.minimumNotebookVersion,
      supported: preflight.runtime.versionSupported,
    });
    const blockers = [
      ...preflight.blockers,
      ...readiness.blockers,
    ];
    const ready = preflight.ready && readiness.ready;
    return {
      ...preflight,
      ready,
      nextAction: ready ? preflight.nextAction : 'resolve_blockers',
      runtime: {
        ...preflight.runtime,
        readiness,
      },
      blockers,
    };
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) throw error;
    throw contractResponseError(error);
  }
}

export async function prepareCommunityTeamSeatChange(
  request: TeamSeatPrepareRequest,
  options?: { fetchImpl?: typeof fetch; now?: Date; operationId?: string },
): Promise<TeamSeatPrepareResponse> {
  requireTeamSeatClientRollout();
  const { instanceId, token } = await requireCommunitySeatToken(
    'seat:prepare',
    options?.now,
  );
  const { response, payload } = await postLicenseControlPlane(
    COMMUNITY_SEAT_PREPARE_PATH,
    { ...request },
    {
      fetchImpl: options?.fetchImpl,
      unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      authorization: {
        tokenType: token.tokenType,
        token: token.instanceToken,
      },
      operationId: options?.operationId,
      maxAttempts: 3,
    },
  );
  if (!response.ok) {
    const error = claimErrorFromResponse(response, payload);
    await recordRejectedCommunityToken(error, {
      instanceId,
      instanceToken: token.instanceToken,
    });
    throw error;
  }
  try {
    return parseTeamSeatPrepareResponse(payload);
  } catch (error) {
    throw contractResponseError(error);
  }
}

export async function getCommunityTeamSeatQuoteStatus(
  quoteId: string,
  options?: { fetchImpl?: typeof fetch; now?: Date; operationId?: string },
): Promise<TeamSeatQuoteStatusResponse> {
  requireTeamSeatClientRollout();
  const { instanceId, token } = await requireCommunitySeatToken(
    'seat:prepare',
    options?.now,
  );
  const { response, payload } = await getLicenseControlPlane(
    `${COMMUNITY_SEAT_QUOTE_PATH}/${encodeURIComponent(quoteId)}`,
    {
      fetchImpl: options?.fetchImpl,
      unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      authorization: {
        tokenType: token.tokenType,
        token: token.instanceToken,
      },
      operationId: options?.operationId ?? quoteId,
      maxAttempts: 3,
    },
  );
  if (!response.ok) {
    const error = claimErrorFromResponse(response, payload);
    await recordRejectedCommunityToken(error, {
      instanceId,
      instanceToken: token.instanceToken,
    });
    throw error;
  }
  try {
    return parseTeamSeatQuoteStatusResponse(payload);
  } catch (error) {
    throw contractResponseError(error);
  }
}

export async function executeCommunityTeamSeatChange(
  request: TeamSeatExecuteRequest,
  options?: { fetchImpl?: typeof fetch; now?: Date; operationId?: string },
): Promise<TeamSeatExecuteResponse> {
  requireTeamSeatClientRollout();
  const { instanceId, token } = await requireCommunitySeatToken(
    'seat:execute',
    options?.now,
  );
  const { response, payload } = await postLicenseControlPlane(
    COMMUNITY_SEAT_EXECUTE_PATH,
    { ...request },
    {
      fetchImpl: options?.fetchImpl,
      unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      authorization: {
        tokenType: token.tokenType,
        token: token.instanceToken,
      },
      operationId: options?.operationId ?? request.operationKey,
      maxAttempts: 3,
    },
  );
  if (!response.ok) {
    const error = claimErrorFromResponse(response, payload);
    await recordRejectedCommunityToken(error, {
      instanceId,
      instanceToken: token.instanceToken,
    });
    throw error;
  }
  try {
    return parseTeamSeatExecuteResponse(payload);
  } catch (error) {
    throw contractResponseError(error);
  }
}

export async function submitCommunityTeamMembershipSnapshot(
  request: TeamSeatSnapshotRequest,
  options?: { fetchImpl?: typeof fetch; now?: Date; operationId?: string },
): Promise<TeamSeatSnapshotResponse> {
  requireTeamSeatClientRollout();
  const { instanceId, token } = await requireCommunitySeatToken(
    'seat:snapshot',
    options?.now,
  );
  const { response, payload } = await postLicenseControlPlane(
    COMMUNITY_SEAT_SNAPSHOT_PATH,
    { ...request },
    {
      fetchImpl: options?.fetchImpl,
      unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      authorization: {
        tokenType: token.tokenType,
        token: token.instanceToken,
      },
      operationId: options?.operationId,
      maxAttempts: 3,
    },
  );
  if (!response.ok) {
    const error = claimErrorFromResponse(response, payload);
    await recordRejectedCommunityToken(error, {
      instanceId,
      instanceToken: token.instanceToken,
    });
    throw error;
  }
  try {
    return parseTeamSeatSnapshotResponse(payload);
  } catch (error) {
    throw contractResponseError(error);
  }
}

export type CommunityLicenseRefreshResult = {
  status: LicenseStatus;
  details: TeamSeatLicenseRefresh['details'];
};

export async function refreshCommunityLicenseCertificate(
  options?: { fetchImpl?: typeof fetch; now?: Date; operationId?: string },
): Promise<CommunityLicenseRefreshResult> {
  const instanceId = getLicenseInstanceId();
  const token = await loadCommunityInstanceToken(instanceId);
  if (!token) {
    throw localClaimError(
      'Connect this Community license before automatic refresh can run.',
      409,
      TEAM_SEAT_ERROR_CODES.accountRequired,
    );
  }
  const now = options?.now ?? new Date();
  if (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime()) {
    await markCommunityConnectionReconnectRequired({
      instanceId,
      expectedToken: token.instanceToken,
      reason: 'expired',
      now,
    });
    throw localClaimError(
      'The Community instance connection expired and must be restored.',
      401,
      TEAM_SEAT_ERROR_CODES.tokenInvalid,
    );
  }
  if (!token.scopes.includes('license:refresh')) {
    throw localClaimError(
      'The Community instance connection does not permit license refresh.',
      403,
      TEAM_SEAT_ERROR_CODES.tokenScopeDenied,
    );
  }

  const { response, payload } = await postLicenseControlPlane(
    COMMUNITY_LICENSE_REFRESH_PATH,
    createTeamSeatTokenLifecycleRequest(),
    {
      fetchImpl: options?.fetchImpl,
      unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      authorization: {
        tokenType: token.tokenType,
        token: token.instanceToken,
      },
      operationId: options?.operationId,
      maxAttempts: 3,
    },
  );
  if (!response.ok) {
    const error = claimErrorFromResponse(response, payload);
    await recordRejectedCommunityToken(error, {
      instanceId,
      instanceToken: token.instanceToken,
    });
    throw error;
  }

  let refreshed: TeamSeatLicenseRefresh;
  try {
    refreshed = parseTeamSeatLicenseRefresh(payload, 'refresh');
  } catch (error) {
    throw contractResponseError(error);
  }
  if (refreshed.details.instanceId !== instanceId) {
    throw localClaimError(
      'The Control Plane refreshed a license for another Notebook instance.',
      409,
      TEAM_SEAT_ERROR_CODES.instanceMismatch,
    );
  }

  try {
    const status = await activateLicenseCert(refreshed.license, {
      licenseId: refreshed.details.id,
      instanceId: refreshed.details.instanceId,
      plan: refreshed.details.plan,
      status: refreshed.details.status,
      hostingMode: refreshed.details.hostingMode,
      edition: refreshed.details.edition,
      licenseClass: refreshed.details.licenseClass,
      licenseEnvironment: refreshed.details.licenseEnvironment,
      entitlementsVersion: refreshed.details.entitlementsVersion,
    });
    return { status, details: refreshed.details };
  } catch (error) {
    if (
      error instanceof LicenseCertificateValidationError
      || error instanceof LicenseCertificateStorageError
    ) {
      throw new LicenseControlPlaneError(
        error.message,
        error instanceof LicenseCertificateStorageError ? 409 : 502,
        error.code,
        false,
      );
    }
    throw error;
  }
}

export async function rotateCommunityLicenseConnection(
  options?: { fetchImpl?: typeof fetch; now?: Date },
): Promise<CommunityLicenseClaimConnected> {
  requireTeamSeatClientRollout();
  const instanceId = getLicenseInstanceId();
  const token = await loadCommunityInstanceToken(instanceId);
  if (!token) {
    throw localClaimError(
      'No Community instance connection is available to rotate.',
      409,
      TEAM_SEAT_ERROR_CODES.accountRequired,
    );
  }
  const now = options?.now ?? new Date();
  if (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime()) {
    await markCommunityConnectionReconnectRequired({
      instanceId,
      expectedToken: token.instanceToken,
      reason: 'expired',
      now,
    });
    throw localClaimError(
      'The Community instance connection expired and must be restored.',
      401,
      TEAM_SEAT_ERROR_CODES.tokenInvalid,
    );
  }
  if (!token.scopes.includes('token:rotate')) {
    throw localClaimError(
      'The Community instance connection does not permit token rotation.',
      403,
      TEAM_SEAT_ERROR_CODES.tokenScopeDenied,
    );
  }

  const { response, payload } = await postLicenseControlPlane(
    COMMUNITY_TOKEN_ROTATE_PATH,
    createTeamSeatTokenLifecycleRequest(),
    {
      fetchImpl: options?.fetchImpl,
      unreachableCode: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
      authorization: {
        tokenType: token.tokenType,
        token: token.instanceToken,
      },
    },
  );
  if (!response.ok) {
    const error = claimErrorFromResponse(response, payload);
    await recordRejectedCommunityToken(error, {
      instanceId,
      instanceToken: token.instanceToken,
    });
    throw error;
  }

  let rotated;
  try {
    rotated = parseTeamSeatTokenRotation(payload.token);
  } catch (error) {
    throw contractResponseError(error);
  }
  if (rotated.instanceId !== instanceId) {
    await markCommunityConnectionReconnectRequired({
      instanceId,
      expectedToken: token.instanceToken,
      reason: 'invalid',
      now,
    });
    throw localClaimError(
      'The rotated Community token belongs to another Notebook instance.',
      409,
      TEAM_SEAT_ERROR_CODES.tokenInstanceMismatch,
    );
  }

  let status: CommunityInstanceTokenStatus;
  try {
    status = await rotateCommunityInstanceToken({
      instanceId,
      previousToken: token.instanceToken,
      instanceToken: rotated.instanceToken,
      tokenType: rotated.tokenType,
      scopes: rotated.scopes,
      expiresAt: rotated.expiresAt,
      now,
    });
  } catch (error) {
    const current = await loadCommunityInstanceToken(instanceId).catch(() => null);
    if (current?.instanceToken === rotated.instanceToken) {
      status = await getCommunityInstanceTokenStatus(instanceId);
    } else {
      await markCommunityConnectionReconnectRequired({
        instanceId,
        expectedToken: token.instanceToken,
        reason: 'rotation_failed',
        now,
      }).catch(() => undefined);
      throw error;
    }
  }
  return {
    state: 'connected',
    claimId: null,
    organizationId: null,
    token: publicCommunityInstanceTokenStatus(status),
  };
}

export function communityLicenseClaimErrorPayload(
  error: LicenseControlPlaneError | TeamSeatRolloutError,
) {
  logLicenseError('[license/community]', 'Community Team operation was rejected', {
    code: error.code,
    status: error instanceof LicenseControlPlaneError ? error.status : error.statusCode,
    retryable: error instanceof LicenseControlPlaneError ? error.retryable : false,
    flow: error instanceof TeamSeatRolloutError ? error.flow : 'control_plane',
  }, error);
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
