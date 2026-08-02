import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { openDb } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import {
  createTeamSeatSnapshotRequest,
  TEAM_SEAT_ERROR_CODES,
  TEAM_SEAT_PROTOCOL_VERSION,
  type TeamSeatSnapshotRequest,
  type TeamSeatSnapshotResponse,
} from './team-seat-contract';
import {
  claimDueTeamMembershipSnapshotOperations,
  getLatestTeamMembershipSnapshotOperation,
  getTeamMembershipSyncState,
  recordTeamMembershipProjectionChange,
  recordTeamSeatSnapshotAcknowledgement,
  requeueTeamMembershipSnapshotOperation,
  scheduleTeamSeatOutboxRetry,
  teamSeatMemberHash,
  teamSeatSnapshotHash,
  type TeamSeatOutboxOperation,
} from './team-seat-outbox';
import { submitCommunityTeamMembershipSnapshot } from './control-plane';
import {
  registerTeamMembershipSyncSignal,
} from './team-membership-sync-signal';
import {
  getActiveTeamMembershipProjection,
} from '@/app/lib/organization/team-membership';

const LOG_PREFIX = '[license/team-membership-sync]';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_TRIGGER_DELAY_MS = 100;
const DEFAULT_RETRY_BASE_MS = 15_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;

type TeamMembershipSyncDatabase = Pick<
  SqlConnection,
  'all' | 'get' | 'run' | 'close'
>;

type TeamMembershipSnapshotSender = (
  request: TeamSeatSnapshotRequest,
  operationId: string,
) => Promise<TeamSeatSnapshotResponse>;

type TeamMembershipSyncRuntime = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
  stopped: boolean;
  intervalMs: number;
};

type TeamMembershipSyncRuntimeGlobal = typeof globalThis & {
  __canvasTeamMembershipSyncRuntime?: TeamMembershipSyncRuntime;
};

export type TeamMembershipSnapshotSyncResult = {
  organizations: number;
  generated: number;
  requeued: number;
  attempted: number;
  acknowledged: number;
  deferred: number;
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

function snapshotContentHash(input: {
  revision: number;
  observedQuantity: number;
  roleSummary: Record<string, number>;
  membershipIds: string[];
  organizationId: string;
}): string {
  return teamSeatSnapshotHash({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    revision: input.revision,
    observedQuantity: input.observedQuantity,
    roleSummary: input.roleSummary,
    memberHashes: input.membershipIds
      .map((membershipId) => teamSeatMemberHash(input.organizationId, membershipId))
      .sort(),
    generatedAt: new Date(0).toISOString(),
    notebookVersion: null,
  });
}

async function organizationIds(
  database: Pick<SqlConnection, 'all'>,
): Promise<string[]> {
  const rows = await database.all(`
    SELECT organization_id
    FROM canvas_organization_settings
    UNION
    SELECT organization_id
    FROM team_membership_sync_state
    ORDER BY organization_id ASC
  `) as Array<{ organization_id: string }>;
  return rows
    .map((row) => row.organization_id?.trim())
    .filter((organizationId): organizationId is string => Boolean(organizationId));
}

async function rollbackQuietly(
  database: Pick<SqlConnection, 'run'>,
): Promise<void> {
  try {
    await database.run('ROLLBACK');
  } catch {
    // Preserve the original transaction error.
  }
}

async function withSyncTransaction<T>(
  database: Pick<SqlConnection, 'run'>,
  provider: DatabaseProvider,
  operation: () => Promise<T>,
): Promise<T> {
  await database.run(provider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = await operation();
    await database.run('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(database);
    throw error;
  }
}

async function ensureSnapshotOperation(
  database: TeamMembershipSyncDatabase,
  input: {
    organizationId: string;
    now: number;
    forceReport: boolean;
    databaseProvider: DatabaseProvider;
  },
): Promise<'unchanged' | 'generated' | 'requeued'> {
  return withSyncTransaction(database, input.databaseProvider, async () => {
    const projection = await getActiveTeamMembershipProjection(
      database,
      input.organizationId,
    );
    if (projection.observedQuantity < 1 || projection.members.length < 1) {
      return 'unchanged';
    }
    const [state, latest] = await Promise.all([
      getTeamMembershipSyncState(database, input.organizationId),
      getLatestTeamMembershipSnapshotOperation(database, input.organizationId),
    ]);
    const currentHash = snapshotContentHash({
      revision: state?.currentRevision ?? 0,
      observedQuantity: projection.observedQuantity,
      roleSummary: projection.roleSummary,
      membershipIds: projection.members.map((member) => member.membershipId),
      organizationId: input.organizationId,
    });
    let latestRequest: TeamSeatSnapshotRequest | null = null;
    if (latest) {
      try {
        latestRequest = createTeamSeatSnapshotRequest(
          JSON.parse(latest.requestJson) as TeamSeatSnapshotRequest,
        );
      } catch {
        latestRequest = null;
      }
    }
    const localStateChanged = (
      !state
      || !latest
      || !latestRequest
      || latest.membershipRevision !== state.currentRevision
      || latestRequest.snapshotHash !== currentHash
      || state.currentObservedQuantity !== projection.observedQuantity
    );
    if (localStateChanged) {
      await recordTeamMembershipProjectionChange(database, {
        organizationId: input.organizationId,
        membershipId: projection.members[0].membershipId,
        operationType: 'reconcile',
        projection,
        now: input.now,
      });
      return 'generated';
    }
    const reportDue = state.nextReportAt !== null && state.nextReportAt <= input.now;
    if (
      (input.forceReport || reportDue)
      && (latest.status === 'succeeded' || latest.status === 'failed')
    ) {
      await requeueTeamMembershipSnapshotOperation(database, {
        operationId: latest.operationId,
        now: input.now,
      });
      return 'requeued';
    }
    return 'unchanged';
  });
}

function retryDelay(operation: TeamSeatOutboxOperation): number {
  return Math.min(
    DEFAULT_RETRY_MAX_MS,
    DEFAULT_RETRY_BASE_MS * (2 ** Math.min(operation.attemptCount, 6)),
  );
}

function errorDetails(error: unknown): {
  code: string;
  message: string;
} {
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string'
      ? error.code
      : TEAM_SEAT_ERROR_CODES.temporaryUnavailable;
    const message = error instanceof Error
      ? error.message
      : 'The membership snapshot could not be synchronized.';
    return { code, message };
  }
  return {
    code: TEAM_SEAT_ERROR_CODES.temporaryUnavailable,
    message: 'The membership snapshot could not be synchronized.',
  };
}

export async function runTeamMembershipSnapshotSyncCycle(options: {
  database?: TeamMembershipSyncDatabase;
  databaseProvider?: DatabaseProvider;
  sendSnapshot?: TeamMembershipSnapshotSender;
  entitlementsVersion?: number | null;
  now?: number;
  forceReport?: boolean;
  leaseMs?: number;
  limit?: number;
} = {}): Promise<TeamMembershipSnapshotSyncResult> {
  const database = options.database ?? await openDb();
  const closeDatabase = options.database === undefined;
  const now = options.now ?? Date.now();
  const databaseProvider = options.databaseProvider ?? getDatabaseProvider();
  const sender = options.sendSnapshot ?? (
    (request, operationId) => submitCommunityTeamMembershipSnapshot(
      request,
      { operationId, now: new Date(now) },
    )
  );
  const result: TeamMembershipSnapshotSyncResult = {
    organizations: 0,
    generated: 0,
    requeued: 0,
    attempted: 0,
    acknowledged: 0,
    deferred: 0,
  };
  try {
    const organizations = await organizationIds(database);
    result.organizations = organizations.length;
    for (const organizationId of organizations) {
      const ensured = await ensureSnapshotOperation(database, {
        organizationId,
        now,
        forceReport: options.forceReport === true,
        databaseProvider,
      });
      if (ensured === 'generated') result.generated += 1;
      if (ensured === 'requeued') result.requeued += 1;
    }

    const operations = await claimDueTeamMembershipSnapshotOperations(database, {
      now,
      leaseMs: options.leaseMs,
      limit: options.limit,
    });
    for (const operation of operations) {
      result.attempted += 1;
      try {
        const request = createTeamSeatSnapshotRequest(
          JSON.parse(operation.requestJson) as TeamSeatSnapshotRequest,
        );
        const response = await sender(request, operation.operationId);
        await recordTeamSeatSnapshotAcknowledgement(database, {
          organizationId: operation.organizationId,
          operationId: operation.operationId,
          response,
          entitlementsVersion: options.entitlementsVersion,
          now,
          databaseProvider,
        });
        result.acknowledged += 1;
      } catch (error) {
        const details = errorDetails(error);
        await scheduleTeamSeatOutboxRetry(database, {
          operationId: operation.operationId,
          errorCode: details.code,
          error: details.message,
          retryAt: now + retryDelay(operation),
          now,
        });
        result.deferred += 1;
        console.warn(`${LOG_PREFIX} snapshot deferred`, {
          organizationId: operation.organizationId,
          operationId: operation.operationId,
          code: details.code,
          retryAt: new Date(now + retryDelay(operation)).toISOString(),
        });
      }
    }
    return result;
  } finally {
    if (closeDatabase) await database.close();
  }
}

function scheduleRuntime(
  runtime: TeamMembershipSyncRuntime,
  delayMs: number,
  forceReport = false,
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
    void runTeamMembershipSnapshotSyncCycle({ forceReport })
      .catch((error) => {
        console.error(`${LOG_PREFIX} runtime cycle failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        runtime.running = false;
        const pending = runtime.pending;
        runtime.pending = false;
        scheduleRuntime(runtime, pending ? 0 : runtime.intervalMs, false);
      });
  }, Math.max(0, delayMs));
  runtime.timer.unref?.();
}

export function triggerTeamMembershipSnapshotSync(): boolean {
  const runtime = (globalThis as TeamMembershipSyncRuntimeGlobal)
    .__canvasTeamMembershipSyncRuntime;
  if (!runtime || runtime.stopped) return false;
  if (runtime.running) runtime.pending = true;
  else scheduleRuntime(runtime, DEFAULT_TRIGGER_DELAY_MS, false);
  return true;
}

export function initializeTeamMembershipSnapshotSyncRuntime(): {
  started: boolean;
  trigger: () => void;
  stop: () => void;
} {
  if (
    process.env.NEXT_PHASE === 'phase-production-build'
    || process.env.CANVAS_TEAM_MEMBERSHIP_SYNC_ENABLED === 'false'
  ) {
    return { started: false, trigger: () => {}, stop: () => {} };
  }
  const globalRuntime = globalThis as TeamMembershipSyncRuntimeGlobal;
  const existing = globalRuntime.__canvasTeamMembershipSyncRuntime;
  if (existing && !existing.stopped) {
    return {
      started: false,
      trigger: () => { triggerTeamMembershipSnapshotSync(); },
      stop: () => {
        existing.stopped = true;
        if (existing.timer) clearTimeout(existing.timer);
      },
    };
  }

  const runtime: TeamMembershipSyncRuntime = {
    timer: null,
    running: false,
    pending: false,
    stopped: false,
    intervalMs: integerEnvironment(
      'CANVAS_TEAM_MEMBERSHIP_SYNC_INTERVAL_SECONDS',
      DEFAULT_INTERVAL_MS / 1_000,
      15,
      24 * 60 * 60,
    ) * 1_000,
  };
  globalRuntime.__canvasTeamMembershipSyncRuntime = runtime;
  registerTeamMembershipSyncSignal(() => {
    triggerTeamMembershipSnapshotSync();
  });
  const initialDelayMs = integerEnvironment(
    'CANVAS_TEAM_MEMBERSHIP_SYNC_INITIAL_DELAY_SECONDS',
    DEFAULT_INITIAL_DELAY_MS / 1_000,
    1,
    300,
  ) * 1_000;
  scheduleRuntime(runtime, initialDelayMs, true);
  console.info(`${LOG_PREFIX} background runtime scheduled`, {
    initialDelayMs,
    intervalMs: runtime.intervalMs,
  });
  return {
    started: true,
    trigger: () => { triggerTeamMembershipSnapshotSync(); },
    stop: () => {
      runtime.stopped = true;
      if (runtime.timer) clearTimeout(runtime.timer);
      registerTeamMembershipSyncSignal(null);
    },
  };
}
