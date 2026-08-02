import 'server-only';

import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import {
  LicenseControlPlaneError,
  refreshCommunityLicenseCertificate,
} from './control-plane';
import { getLicenseInstanceId } from './instance';
import { getLicenseStatus } from './index';
import {
  loadCommunityConnectionRecoveryState,
  loadCommunityInstanceToken,
  loadCommunityLicenseRefreshState,
  saveCommunityLicenseRefreshState,
  type CommunityLicenseRefreshState,
} from './storage';
import { TEAM_SEAT_ERROR_CODES } from './team-seat-contract';
import type { LicenseStatus } from './types';

const LOG_PREFIX = '[license/refresh]';
const MAX_POLICY_SECONDS = 7 * 24 * 60 * 60;

export type CommunityLicenseRefreshPolicy = {
  initialDelaySeconds: number;
  intervalSeconds: number;
  refreshAheadSeconds: number;
  minimumScheduleSeconds: number;
  idlePollSeconds: number;
  backoffInitialSeconds: number;
  backoffMaximumSeconds: number;
  backoffJitterRatio: number;
  commercialGraceSeconds: number;
};

export type CommunityLicenseRefreshCycleResult = {
  state: CommunityLicenseRefreshState;
  status: LicenseStatus | null;
  error: LicenseControlPlaneError | null;
  attempted: boolean;
};

type RefreshCycleOptions = {
  fetchImpl?: typeof fetch;
  force?: boolean;
  now?: Date;
  policy?: CommunityLicenseRefreshPolicy;
  random?: () => number;
};

type RefreshRuntime = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  stopped: boolean;
  policy: CommunityLicenseRefreshPolicy;
};

type RefreshRuntimeGlobal = typeof globalThis & {
  __canvasCommunityLicenseRefreshRuntime?: RefreshRuntime;
};

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function resolveCommunityLicenseRefreshPolicy(): CommunityLicenseRefreshPolicy {
  return {
    initialDelaySeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_REFRESH_INITIAL_DELAY_SECONDS',
      5,
      1,
      300,
    ),
    intervalSeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_REFRESH_INTERVAL_SECONDS',
      300,
      30,
      3600,
    ),
    refreshAheadSeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_REFRESH_AHEAD_SECONDS',
      300,
      30,
      3600,
    ),
    minimumScheduleSeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_REFRESH_MINIMUM_SCHEDULE_SECONDS',
      10,
      1,
      300,
    ),
    idlePollSeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_REFRESH_IDLE_POLL_SECONDS',
      300,
      30,
      3600,
    ),
    backoffInitialSeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_REFRESH_BACKOFF_INITIAL_SECONDS',
      15,
      1,
      300,
    ),
    backoffMaximumSeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_REFRESH_BACKOFF_MAX_SECONDS',
      300,
      5,
      3600,
    ),
    backoffJitterRatio: 0.2,
    commercialGraceSeconds: integerEnvironment(
      'CANVAS_TEAM_LICENSE_OFFLINE_GRACE_SECONDS',
      24 * 60 * 60,
      0,
      MAX_POLICY_SECONDS,
    ),
  };
}

function isoAt(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function initialState(
  instanceId: string,
  now: Date,
  phase: CommunityLicenseRefreshState['phase'],
  nextAttemptAt: string | null,
): CommunityLicenseRefreshState {
  return {
    instanceId,
    phase,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt,
    consecutiveFailures: 0,
    lastErrorCode: null,
    retryable: false,
    certificateExpiresAt: null,
    entitlementsVersion: null,
    graceStartedAt: null,
    graceExpiresAt: null,
    updatedAt: now.toISOString(),
  };
}

function successSchedule(
  status: LicenseStatus,
  now: Date,
  policy: CommunityLicenseRefreshPolicy,
): string {
  const minimum = now.getTime() + policy.minimumScheduleSeconds * 1000;
  const regular = now.getTime() + policy.intervalSeconds * 1000;
  const expiresAt = status.expiresAt ? Date.parse(status.expiresAt) : Number.POSITIVE_INFINITY;
  const expiryDriven = expiresAt - policy.refreshAheadSeconds * 1000;
  return isoAt(Math.max(minimum, Math.min(regular, expiryDriven)));
}

export function communityLicenseRefreshBackoffSeconds(
  consecutiveFailures: number,
  policy: CommunityLicenseRefreshPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(20, consecutiveFailures - 1));
  const base = Math.min(
    policy.backoffMaximumSeconds,
    policy.backoffInitialSeconds * (2 ** exponent),
  );
  const jitter = 1 + ((Math.max(0, Math.min(1, random())) * 2) - 1) * policy.backoffJitterRatio;
  return Math.max(
    1,
    Math.min(policy.backoffMaximumSeconds, Math.round(base * jitter)),
  );
}

function graceWindow(
  status: LicenseStatus,
  policy: CommunityLicenseRefreshPolicy,
): { graceStartedAt: string; graceExpiresAt: string } | null {
  if (
    status.hostingMode !== 'community'
    || status.edition !== 'team'
    || status.licenseClass !== 'commercial'
    || !status.expiresAt
    || policy.commercialGraceSeconds <= 0
  ) {
    return null;
  }
  const expiresAt = Date.parse(status.expiresAt);
  if (!Number.isFinite(expiresAt)) return null;
  return {
    graceStartedAt: new Date(expiresAt).toISOString(),
    graceExpiresAt: new Date(expiresAt + policy.commercialGraceSeconds * 1000).toISOString(),
  };
}

function terminalConnectionError(error: LicenseControlPlaneError): boolean {
  return error.code === TEAM_SEAT_ERROR_CODES.tokenInvalid
    || error.code === TEAM_SEAT_ERROR_CODES.tokenInstanceMismatch
    || error.code === TEAM_SEAT_ERROR_CODES.accountRequired;
}

function asRefreshError(error: unknown): LicenseControlPlaneError {
  if (error instanceof LicenseControlPlaneError) return error;
  return new LicenseControlPlaneError(
    redactTeamControlPlaneLogText(
      error instanceof Error ? error.message : 'Community license refresh failed.',
    ),
    500,
    'LICENSE_REFRESH_INTERNAL_ERROR',
    false,
  );
}

export async function runCommunityLicenseRefreshCycle(
  options: RefreshCycleOptions = {},
): Promise<CommunityLicenseRefreshCycleResult> {
  const now = options.now ?? new Date();
  const policy = options.policy ?? resolveCommunityLicenseRefreshPolicy();
  const instanceId = getLicenseInstanceId();
  const existing = await loadCommunityLicenseRefreshState(instanceId);
  const token = await loadCommunityInstanceToken(instanceId);

  if (!token) {
    const recovery = await loadCommunityConnectionRecoveryState(instanceId);
    const nextAttemptAt = isoAt(now.getTime() + policy.idlePollSeconds * 1000);
    const state = await saveCommunityLicenseRefreshState({
      ...(existing ?? initialState(instanceId, now, 'idle', nextAttemptAt)),
      phase: recovery ? 'reconnect_required' : 'idle',
      nextAttemptAt,
      lastErrorCode: recovery ? TEAM_SEAT_ERROR_CODES.tokenInvalid : null,
      retryable: false,
      updatedAt: now.toISOString(),
    });
    return { state, status: null, error: null, attempted: false };
  }

  if (
    !options.force
    && existing?.nextAttemptAt
    && Date.parse(existing.nextAttemptAt) > now.getTime()
  ) {
    return { state: existing, status: null, error: null, attempted: false };
  }

  const statusBeforeRefresh = await getLicenseStatus();
  await saveCommunityLicenseRefreshState({
    ...(existing ?? initialState(instanceId, now, 'refreshing', null)),
    phase: 'refreshing',
    lastAttemptAt: now.toISOString(),
    nextAttemptAt: null,
    updatedAt: now.toISOString(),
  });

  try {
    const refreshed = await refreshCommunityLicenseCertificate({
      fetchImpl: options.fetchImpl,
      now,
    });
    const state = await saveCommunityLicenseRefreshState({
      instanceId,
      phase: 'active',
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      nextAttemptAt: successSchedule(refreshed.status, now, policy),
      consecutiveFailures: 0,
      lastErrorCode: null,
      retryable: false,
      certificateExpiresAt: refreshed.status.expiresAt,
      entitlementsVersion: refreshed.status.entitlementsVersion,
      graceStartedAt: null,
      graceExpiresAt: null,
      updatedAt: now.toISOString(),
    });
    console.info(`${LOG_PREFIX} certificate refreshed`, {
      instanceId,
      edition: refreshed.status.edition,
      entitlementsVersion: refreshed.status.entitlementsVersion,
      expiresAt: refreshed.status.expiresAt,
      nextAttemptAt: state.nextAttemptAt,
    });
    return { state, status: refreshed.status, error: null, attempted: true };
  } catch (caught) {
    const error = asRefreshError(caught);
    const reconnectRequired = terminalConnectionError(error);
    const retryable = error.retryable && !reconnectRequired;
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    const backoffSeconds = retryable
      ? communityLicenseRefreshBackoffSeconds(
          consecutiveFailures,
          policy,
          options.random,
        )
      : policy.idlePollSeconds;
    const grace = retryable ? graceWindow(statusBeforeRefresh, policy) : null;
    const state = await saveCommunityLicenseRefreshState({
      instanceId,
      phase: reconnectRequired ? 'reconnect_required' : retryable ? 'backoff' : 'blocked',
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      nextAttemptAt: isoAt(now.getTime() + backoffSeconds * 1000),
      consecutiveFailures,
      lastErrorCode: error.code,
      retryable,
      certificateExpiresAt: statusBeforeRefresh.expiresAt,
      entitlementsVersion: statusBeforeRefresh.entitlementsVersion,
      graceStartedAt: grace?.graceStartedAt ?? null,
      graceExpiresAt: grace?.graceExpiresAt ?? null,
      updatedAt: now.toISOString(),
    });
    console.warn(`${LOG_PREFIX} certificate refresh failed`, {
      instanceId,
      code: error.code,
      retryable,
      consecutiveFailures,
      nextAttemptAt: state.nextAttemptAt,
      graceExpiresAt: state.graceExpiresAt,
    });
    return { state, status: statusBeforeRefresh, error, attempted: true };
  }
}

function millisecondsUntilNextAttempt(
  state: CommunityLicenseRefreshState,
  policy: CommunityLicenseRefreshPolicy,
): number {
  if (!state.nextAttemptAt) return policy.idlePollSeconds * 1000;
  return Math.max(
    policy.minimumScheduleSeconds * 1000,
    Date.parse(state.nextAttemptAt) - Date.now(),
  );
}

function scheduleRuntimeCycle(runtime: RefreshRuntime, delayMs: number): void {
  if (runtime.stopped) return;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    if (runtime.running || runtime.stopped) return;
    runtime.running = true;
    void runCommunityLicenseRefreshCycle({ policy: runtime.policy })
      .then((result) => {
        scheduleRuntimeCycle(
          runtime,
          millisecondsUntilNextAttempt(result.state, runtime.policy),
        );
      })
      .catch((error) => {
        console.error(`${LOG_PREFIX} runtime cycle crashed`, {
          error: redactTeamControlPlaneLogText(
            error instanceof Error ? error.message : String(error),
          ),
        });
        scheduleRuntimeCycle(runtime, runtime.policy.backoffMaximumSeconds * 1000);
      })
      .finally(() => {
        runtime.running = false;
      });
  }, Math.max(0, delayMs));
  runtime.timer.unref?.();
}

export function initializeCommunityLicenseRefreshRuntime(): {
  started: boolean;
  stop: () => void;
} {
  if (
    process.env.NEXT_PHASE === 'phase-production-build'
    || process.env.CANVAS_TEAM_LICENSE_REFRESH_ENABLED === 'false'
  ) {
    return { started: false, stop: () => {} };
  }
  const globalRuntime = globalThis as RefreshRuntimeGlobal;
  const existing = globalRuntime.__canvasCommunityLicenseRefreshRuntime;
  if (existing && !existing.stopped) {
    return {
      started: false,
      stop: () => {
        existing.stopped = true;
        if (existing.timer) clearTimeout(existing.timer);
      },
    };
  }

  const policy = resolveCommunityLicenseRefreshPolicy();
  const runtime: RefreshRuntime = {
    timer: null,
    running: false,
    stopped: false,
    policy,
  };
  globalRuntime.__canvasCommunityLicenseRefreshRuntime = runtime;
  scheduleRuntimeCycle(runtime, policy.initialDelaySeconds * 1000);
  console.info(`${LOG_PREFIX} background runtime scheduled`, {
    initialDelaySeconds: policy.initialDelaySeconds,
    intervalSeconds: policy.intervalSeconds,
    commercialGraceSeconds: policy.commercialGraceSeconds,
  });
  return {
    started: true,
    stop: () => {
      runtime.stopped = true;
      if (runtime.timer) clearTimeout(runtime.timer);
    },
  };
}
