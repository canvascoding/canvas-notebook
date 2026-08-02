import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { openDb } from '@/app/lib/db';
import {
  executeCommunityTeamSeatChange,
  prepareCommunityTeamSeatChange,
  refreshCommunityLicenseCertificate,
} from './control-plane';
import {
  claimDueTeamSeatWorkOperations,
  getTeamSeatOutboxOperation,
  recordTeamSeatOutboxOperationFailure,
  recordTeamSeatOutboxOperationSuccess,
  scheduleTeamSeatOutboxRetry,
  TeamSeatOutboxError,
  type TeamSeatOutboxOperation,
} from './team-seat-outbox';
import {
  classifyTeamSeatOutboxFailure,
  teamSeatOutboxRetryDelay,
} from './team-seat-outbox-errors';
import {
  registerTeamSeatOutboxWorkerSignal,
} from './team-seat-outbox-worker-signal';
import {
  getMembershipSeatExecuteRequest,
  getMembershipSeatPrepareRequest,
  recordDirectMembershipSeatExecutionApplied,
  recordDirectMembershipSeatExecutionPending,
  recordDirectMembershipSeatPreparation,
} from '@/app/lib/organization/membership-orchestrator';

const LOG_PREFIX = '[license/team-seat-outbox-worker]';
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_INITIAL_DELAY_MS = 3_000;
const DEFAULT_TRIGGER_DELAY_MS = 1_250;
const DEFAULT_LEASE_MS = 60_000;

type TeamSeatOutboxWorkerDatabase = Pick<
  SqlConnection,
  'all' | 'get' | 'run' | 'close'
>;

type TeamSeatOutboxDispatcher = (
  operation: TeamSeatOutboxOperation,
  database: TeamSeatOutboxWorkerDatabase,
  now: number,
) => Promise<void>;

type TeamSeatOutboxWorkerRuntime = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
  stopped: boolean;
  intervalMs: number;
  leaseMs: number;
};

type TeamSeatOutboxWorkerGlobal = typeof globalThis & {
  __canvasTeamSeatOutboxWorkerRuntime?: TeamSeatOutboxWorkerRuntime;
};

export type TeamSeatOutboxWorkerResult = {
  claimed: number;
  succeeded: number;
  deferred: number;
  failed: number;
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

async function dispatchTeamSeatOutboxOperation(
  operation: TeamSeatOutboxOperation,
  database: TeamSeatOutboxWorkerDatabase,
  now: number,
): Promise<void> {
  if (operation.operationKind === 'seat_prepare') {
    if (!operation.membershipId) {
      throw new TeamSeatOutboxError(
        'TEAM_SEAT_OUTBOX_CONFLICT',
        'A Seat preparation requires a persisted membership reference.',
      );
    }
    const response = await prepareCommunityTeamSeatChange(
      getMembershipSeatPrepareRequest(operation),
      { operationId: operation.operationId, now: new Date(now) },
    );
    await recordDirectMembershipSeatPreparation({
      organizationId: operation.organizationId,
      membershipId: operation.membershipId,
      prepareOperationId: operation.operationId,
      response,
      actorUserId: null,
      database,
      now,
    });
    return;
  }

  if (operation.operationKind === 'seat_execute') {
    if (!operation.membershipId) {
      throw new TeamSeatOutboxError(
        'TEAM_SEAT_OUTBOX_CONFLICT',
        'A Seat execution requires a persisted membership reference.',
      );
    }
    const response = await executeCommunityTeamSeatChange(
      getMembershipSeatExecuteRequest(operation),
      { operationId: operation.operationId, now: new Date(now) },
    );
    if (
      response.operation.status === 'applied'
      && response.operation.effectiveQuantity === response.operation.requestedQuantity
      && response.operation.certificateReissueStatus === 'issued'
      && response.license
    ) {
      await recordDirectMembershipSeatExecutionApplied({
        organizationId: operation.organizationId,
        membershipId: operation.membershipId,
        executeOperationId: operation.operationId,
        response,
        database,
        now,
      });
    } else {
      await recordDirectMembershipSeatExecutionPending({
        organizationId: operation.organizationId,
        membershipId: operation.membershipId,
        executeOperationId: operation.operationId,
        response,
        database,
        now,
      });
    }
    return;
  }

  if (operation.operationKind === 'license_refresh') {
    const refreshed = await refreshCommunityLicenseCertificate({
      operationId: operation.operationId,
      now: new Date(now),
    });
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: operation.operationId,
      response: {
        details: refreshed.details,
        licenseState: refreshed.status.licenseState,
        licensed: refreshed.status.licensed,
        seatLimit: refreshed.status.seatLimit,
      },
      now,
    });
    return;
  }

  throw new TeamSeatOutboxError(
    'TEAM_SEAT_OUTBOX_CONFLICT',
    `Unsupported Team Seat outbox kind: ${operation.operationKind}`,
  );
}

export async function runTeamSeatOutboxWorkerCycle(options: {
  database?: TeamSeatOutboxWorkerDatabase;
  dispatchOperation?: TeamSeatOutboxDispatcher;
  now?: number;
  leaseMs?: number;
  limit?: number;
  pendingDelayMs?: number;
} = {}): Promise<TeamSeatOutboxWorkerResult> {
  const database = options.database ?? await openDb();
  const closeDatabase = options.database === undefined;
  const now = options.now ?? Date.now();
  const result: TeamSeatOutboxWorkerResult = {
    claimed: 0,
    succeeded: 0,
    deferred: 0,
    failed: 0,
  };
  try {
    const operations = await claimDueTeamSeatWorkOperations(database, {
      now,
      leaseMs: options.leaseMs,
      limit: options.limit,
      pendingDelayMs: options.pendingDelayMs,
    });
    result.claimed = operations.length;
    for (const operation of operations) {
      try {
        await (options.dispatchOperation ?? dispatchTeamSeatOutboxOperation)(
          operation,
          database,
          now,
        );
        const persisted = await getTeamSeatOutboxOperation(
          database,
          operation.operationId,
        );
        if (persisted?.status === 'failed') result.failed += 1;
        else if (persisted?.status === 'retry_wait') result.deferred += 1;
        else if (persisted?.status === 'succeeded') result.succeeded += 1;
      } catch (error) {
        const failure = classifyTeamSeatOutboxFailure(error);
        if (failure.terminal) {
          await recordTeamSeatOutboxOperationFailure(database, {
            operationId: operation.operationId,
            errorCode: failure.code,
            error: failure.message,
            now,
          });
          result.failed += 1;
          console.warn(`${LOG_PREFIX} operation failed terminally`, {
            operationId: operation.operationId,
            operationKind: operation.operationKind,
            code: failure.code,
          });
        } else {
          const retryDelay = teamSeatOutboxRetryDelay(
            operation,
            failure.retryAfterMs,
          );
          const retry = await scheduleTeamSeatOutboxRetry(database, {
            operationId: operation.operationId,
            errorCode: failure.code,
            error: failure.message,
            retryAt: now + retryDelay,
            now,
          });
          if (retry.status === 'failed') result.failed += 1;
          else result.deferred += 1;
          console.warn(
            `${LOG_PREFIX} operation ${retry.status === 'failed' ? 'exhausted' : 'deferred'}`,
            {
            operationId: operation.operationId,
            operationKind: operation.operationKind,
            code: failure.code,
              retryAt: retry.nextAttemptAt === null
                ? null
                : new Date(retry.nextAttemptAt).toISOString(),
            },
          );
        }
      }
    }
    return result;
  } finally {
    if (closeDatabase) await database.close();
  }
}

function scheduleRuntime(
  runtime: TeamSeatOutboxWorkerRuntime,
  delayMs: number,
): void {
  if (runtime.stopped) return;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    if (runtime.running || runtime.stopped) {
      runtime.pending = true;
      return;
    }
    runtime.running = true;
    void runTeamSeatOutboxWorkerCycle({ leaseMs: runtime.leaseMs })
      .catch((error) => {
        console.error(`${LOG_PREFIX} runtime cycle failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        runtime.running = false;
        const pending = runtime.pending;
        runtime.pending = false;
        scheduleRuntime(runtime, pending ? 0 : runtime.intervalMs);
      });
  }, Math.max(0, delayMs));
  runtime.timer.unref?.();
}

export function triggerTeamSeatOutboxWorker(): boolean {
  const runtime = (globalThis as TeamSeatOutboxWorkerGlobal)
    .__canvasTeamSeatOutboxWorkerRuntime;
  if (!runtime || runtime.stopped) return false;
  if (runtime.running) runtime.pending = true;
  else scheduleRuntime(runtime, DEFAULT_TRIGGER_DELAY_MS);
  return true;
}

export function initializeTeamSeatOutboxWorkerRuntime(): {
  started: boolean;
  trigger: () => void;
  stop: () => void;
} {
  if (
    process.env.NEXT_PHASE === 'phase-production-build'
    || process.env.CANVAS_TEAM_SEAT_OUTBOX_WORKER_ENABLED === 'false'
  ) {
    return { started: false, trigger: () => {}, stop: () => {} };
  }
  const globalRuntime = globalThis as TeamSeatOutboxWorkerGlobal;
  const existing = globalRuntime.__canvasTeamSeatOutboxWorkerRuntime;
  if (existing && !existing.stopped) {
    return {
      started: false,
      trigger: () => { triggerTeamSeatOutboxWorker(); },
      stop: () => {
        existing.stopped = true;
        if (existing.timer) clearTimeout(existing.timer);
      },
    };
  }
  const runtime: TeamSeatOutboxWorkerRuntime = {
    timer: null,
    running: false,
    pending: false,
    stopped: false,
    intervalMs: integerEnvironment(
      'CANVAS_TEAM_SEAT_OUTBOX_WORKER_INTERVAL_SECONDS',
      DEFAULT_INTERVAL_MS / 1_000,
      5,
      60 * 60,
    ) * 1_000,
    leaseMs: integerEnvironment(
      'CANVAS_TEAM_SEAT_OUTBOX_LEASE_SECONDS',
      DEFAULT_LEASE_MS / 1_000,
      10,
      60 * 60,
    ) * 1_000,
  };
  globalRuntime.__canvasTeamSeatOutboxWorkerRuntime = runtime;
  registerTeamSeatOutboxWorkerSignal(() => {
    triggerTeamSeatOutboxWorker();
  });
  const initialDelayMs = integerEnvironment(
    'CANVAS_TEAM_SEAT_OUTBOX_WORKER_INITIAL_DELAY_SECONDS',
    DEFAULT_INITIAL_DELAY_MS / 1_000,
    1,
    300,
  ) * 1_000;
  scheduleRuntime(runtime, initialDelayMs);
  console.info(`${LOG_PREFIX} background runtime scheduled`, {
    initialDelayMs,
    intervalMs: runtime.intervalMs,
    leaseMs: runtime.leaseMs,
  });
  return {
    started: true,
    trigger: () => { triggerTeamSeatOutboxWorker(); },
    stop: () => {
      runtime.stopped = true;
      if (runtime.timer) clearTimeout(runtime.timer);
      registerTeamSeatOutboxWorkerSignal(null);
    },
  };
}
