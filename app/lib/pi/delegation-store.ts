import 'server-only';

import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piDelegations } from '@/app/lib/db/schema';

export type PiDelegationWorkerType = 'ephemeral' | 'managed';
export type PiDelegationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type PiDelegationDeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'skipped';
export type PiDelegationResultStatus = 'ok' | 'timeout' | 'error';
export type PiDelegationRecord = typeof piDelegations.$inferSelect;
export const PI_DELEGATION_LEASE_TIMEOUT_MS = 30_000;
const databaseNowMs = sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
const staleRunLease = sql`${piDelegations.runHeartbeatAt} < ${databaseNowMs} - ${PI_DELEGATION_LEASE_TIMEOUT_MS}`;
const freshRunLease = sql`${piDelegations.runHeartbeatAt} >= ${databaseNowMs} - ${PI_DELEGATION_LEASE_TIMEOUT_MS}`;
const staleDeliveryLease = sql`${piDelegations.deliveryHeartbeatAt} < ${databaseNowMs} - ${PI_DELEGATION_LEASE_TIMEOUT_MS}`;
const freshDeliveryLease = sql`${piDelegations.deliveryHeartbeatAt} >= ${databaseNowMs} - ${PI_DELEGATION_LEASE_TIMEOUT_MS}`;

export type CreatePiDelegationInput = {
  id: string;
  userId: string;
  sourceSessionId: string;
  sourceAgentId: string;
  workerSessionId: string;
  requestedSessionId?: string;
  targetAgentId?: string;
  workerType: PiDelegationWorkerType;
  goal: string;
  context?: string;
  workerRole?: string;
  toolsets: string[];
};

export class ManagedWorkerBusyError extends Error {
  readonly code = 'MANAGED_WORKER_BUSY';

  constructor() {
    super('Managed worker session already has a queued or running task. Wait for it to finish before continuing this session.');
    this.name = 'ManagedWorkerBusyError';
  }
}

function isPostgresUniqueViolation(error: unknown): boolean {
  for (let depth = 0; depth < 5 && error && typeof error === 'object'; depth += 1) {
    const candidate = error as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    error = candidate.cause;
  }
  return false;
}

function parseToolsets(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export function piDelegationToolsets(record: Pick<PiDelegationRecord, 'toolsetsJson'>): string[] {
  return parseToolsets(record.toolsetsJson);
}

export async function createPiDelegation(input: CreatePiDelegationInput): Promise<PiDelegationRecord> {
  const now = new Date();
  let created: PiDelegationRecord | undefined;
  try {
    [created] = await db.insert(piDelegations).values({
      id: input.id,
      userId: input.userId,
      sourceSessionId: input.sourceSessionId,
      sourceAgentId: input.sourceAgentId,
      workerSessionId: input.workerSessionId,
      requestedSessionId: input.requestedSessionId ?? null,
      targetAgentId: input.targetAgentId ?? null,
      workerType: input.workerType,
      goal: input.goal,
      context: input.context ?? null,
      workerRole: input.workerRole ?? null,
      toolsetsJson: JSON.stringify(input.toolsets),
      status: 'queued',
      deliveryStatus: 'pending',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    }).returning();
  } catch (error) {
    if (input.workerType === 'managed' && isPostgresUniqueViolation(error)) {
      const active = await db.query.piDelegations.findFirst({
        where: and(
          eq(piDelegations.userId, input.userId),
          eq(piDelegations.workerSessionId, input.workerSessionId),
          eq(piDelegations.workerType, 'managed'),
          inArray(piDelegations.status, ['queued', 'running']),
        ),
        columns: { id: true },
      });
      if (active) throw new ManagedWorkerBusyError();
    }
    throw error;
  }
  if (!created) {
    throw new Error('Delegation task could not be persisted.');
  }
  return created;
}

export async function getPiDelegation(id: string): Promise<PiDelegationRecord | null> {
  return await db.query.piDelegations.findFirst({
    where: eq(piDelegations.id, id),
  }) ?? null;
}

export async function getOwnedPiDelegation(id: string, userId: string): Promise<PiDelegationRecord | null> {
  return await db.query.piDelegations.findFirst({
    where: and(eq(piDelegations.id, id), eq(piDelegations.userId, userId)),
  }) ?? null;
}

export async function listOwnedPiDelegations(input: {
  userId: string;
  sourceSessionId?: string;
  limit?: number;
}): Promise<PiDelegationRecord[]> {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200));
  return db.query.piDelegations.findMany({
    where: and(
      eq(piDelegations.userId, input.userId),
      ...(input.sourceSessionId ? [eq(piDelegations.sourceSessionId, input.sourceSessionId)] : []),
    ),
    orderBy: [desc(piDelegations.createdAt), desc(piDelegations.id)],
    limit,
  });
}

export async function listQueuedPiDelegations(limit: number): Promise<PiDelegationRecord[]> {
  return db.query.piDelegations.findMany({
    where: eq(piDelegations.status, 'queued'),
    orderBy: [asc(piDelegations.createdAt), asc(piDelegations.id)],
    limit: Math.max(1, limit),
  });
}

export async function listStaleRunningPiDelegations(): Promise<PiDelegationRecord[]> {
  return db.query.piDelegations.findMany({
    where: and(eq(piDelegations.status, 'running'), isNotNull(piDelegations.runOwnerId), staleRunLease),
    orderBy: [asc(piDelegations.startedAt), asc(piDelegations.id)],
  });
}

export async function claimQueuedPiDelegation(id: string, runOwnerId?: string): Promise<PiDelegationRecord | null> {
  const now = new Date();
  const [claimed] = await db.update(piDelegations)
    .set({
      status: 'running',
      runOwnerId: runOwnerId ?? null,
      runHeartbeatAt: runOwnerId ? databaseNowMs : null,
      startedAt: now,
      updatedAt: now,
      attemptCount: sql`${piDelegations.attemptCount} + 1`,
    })
    .where(and(
      eq(piDelegations.id, id),
      eq(piDelegations.status, 'queued'),
    ))
    .returning();
  return claimed ?? null;
}

export async function heartbeatOwnedPiDelegations(input: {
  runOwnerId: string;
  runningIds: string[];
  deliveringIds: string[];
}): Promise<{ runningIds: string[]; cancelRequestedIds: string[]; deliveringIds: string[] }> {
  const running = input.runningIds.length > 0
    ? await db.update(piDelegations)
      .set({ runHeartbeatAt: databaseNowMs })
      .where(and(inArray(piDelegations.id, input.runningIds), eq(piDelegations.status, 'running'), eq(piDelegations.runOwnerId, input.runOwnerId), freshRunLease))
      .returning({ id: piDelegations.id, cancelRequestedAt: piDelegations.cancelRequestedAt })
    : [];
  const delivering = input.deliveringIds.length > 0
    ? await db.update(piDelegations)
      .set({ deliveryHeartbeatAt: databaseNowMs })
      .where(and(inArray(piDelegations.id, input.deliveringIds), eq(piDelegations.deliveryStatus, 'delivering'), eq(piDelegations.deliveryOwnerId, input.runOwnerId), freshDeliveryLease))
      .returning({ id: piDelegations.id })
    : [];
  return {
    runningIds: running.map(row => row.id),
    cancelRequestedIds: running.filter(row => row.cancelRequestedAt !== null).map(row => row.id),
    deliveringIds: delivering.map(row => row.id),
  };
}

export async function updateRunningPiDelegationWorkerSession(
  id: string,
  workerSessionId: string,
  runOwnerId?: string,
): Promise<PiDelegationRecord | null> {
  const [updated] = await db.update(piDelegations)
    .set({ workerSessionId, updatedAt: new Date() })
    .where(and(eq(piDelegations.id, id), eq(piDelegations.status, 'running'), ...(runOwnerId ? [eq(piDelegations.runOwnerId, runOwnerId), freshRunLease] : [])))
    .returning();
  return updated ?? null;
}

export async function completeRunningPiDelegation(input: {
  id: string;
  resultStatus: PiDelegationResultStatus;
  resultText?: string;
  errorText?: string;
  runOwnerId?: string;
  staleRecovery?: boolean;
}): Promise<PiDelegationRecord | null> {
  const now = new Date();
  const nextStatus: PiDelegationStatus = input.resultStatus === 'ok' ? 'completed' : 'failed';
  const [updated] = await db.update(piDelegations)
    .set({
      status: nextStatus,
      resultStatus: input.resultStatus,
      resultText: input.resultText ?? null,
      errorText: input.errorText ?? null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(piDelegations.id, input.id), eq(piDelegations.status, 'running'), isNull(piDelegations.cancelRequestedAt),
      ...(input.runOwnerId ? [eq(piDelegations.runOwnerId, input.runOwnerId)] : []),
      ...(input.staleRecovery ? [isNotNull(piDelegations.runOwnerId), staleRunLease] : []),
      ...(!input.staleRecovery && input.runOwnerId ? [freshRunLease] : []),
    ))
    .returning();
  return updated ?? null;
}

export async function failQueuedPiDelegation(id: string, errorText: string): Promise<PiDelegationRecord | null> {
  const now = new Date();
  const [updated] = await db.update(piDelegations)
    .set({
      status: 'failed',
      resultStatus: 'error',
      errorText,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(piDelegations.id, id), eq(piDelegations.status, 'queued')))
    .returning();
  return updated ?? null;
}

export async function requestPiDelegationCancellation(
  id: string,
  userId: string,
): Promise<PiDelegationRecord | null> {
  const existing = await getOwnedPiDelegation(id, userId);
  if (!existing || (existing.status !== 'queued' && existing.status !== 'running')) {
    return existing;
  }

  const now = new Date();
  if (existing.status === 'queued') {
    const [cancelled] = await db.update(piDelegations)
      .set({
        status: 'cancelled',
        resultStatus: 'error',
        errorText: 'Delegated task was cancelled before it started.',
        cancelRequestedAt: now,
        completedAt: now,
        deliveryStatus: 'skipped',
        updatedAt: now,
      })
      .where(and(
        eq(piDelegations.id, id),
        eq(piDelegations.userId, userId),
        eq(piDelegations.status, 'queued'),
      ))
      .returning();
    return cancelled ?? getOwnedPiDelegation(id, userId);
  }

  const [updated] = await db.update(piDelegations)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(and(
      eq(piDelegations.id, id),
      eq(piDelegations.userId, userId),
      eq(piDelegations.status, 'running'),
    ))
    .returning();
  return updated ?? getOwnedPiDelegation(id, userId);
}

export async function cancelRunningPiDelegation(id: string, errorText: string, runOwnerId?: string): Promise<PiDelegationRecord | null> {
  const now = new Date();
  const [updated] = await db.update(piDelegations)
    .set({
      status: 'cancelled',
      resultStatus: 'error',
      errorText,
      completedAt: now,
      deliveryStatus: 'skipped',
      updatedAt: now,
    })
    .where(and(eq(piDelegations.id, id), eq(piDelegations.status, 'running'), ...(runOwnerId ? [eq(piDelegations.runOwnerId, runOwnerId), freshRunLease] : [])))
    .returning();
  return updated ?? null;
}

export async function updatePiDelegationDelivery(input: {
  id: string;
  status: PiDelegationDeliveryStatus;
  deliveryErrorText?: string;
  deliveryOwnerId?: string;
}): Promise<PiDelegationRecord | null> {
  const now = new Date();
  const [updated] = await db.update(piDelegations)
    .set({
      deliveryStatus: input.status,
      deliveredAt: input.status === 'delivered' ? now : undefined,
      deliveryErrorText: input.deliveryErrorText ?? null,
      updatedAt: now,
    })
    .where(and(eq(piDelegations.id, input.id), ...(input.deliveryOwnerId ? [eq(piDelegations.deliveryOwnerId, input.deliveryOwnerId), freshDeliveryLease] : [])))
    .returning();
  return updated ?? null;
}

export async function listDeliverablePiDelegations(limit: number): Promise<PiDelegationRecord[]> {
  return db.query.piDelegations.findMany({
    where: and(
      inArray(piDelegations.status, ['completed', 'failed']),
      inArray(piDelegations.deliveryStatus, ['pending', 'failed']),
    ),
    orderBy: [asc(piDelegations.completedAt), asc(piDelegations.id)],
    limit: Math.max(1, limit),
  });
}

export async function claimPiDelegationDelivery(id: string, deliveryOwnerId?: string): Promise<PiDelegationRecord | null> {
  const [claimed] = await db.update(piDelegations)
    .set({
      deliveryStatus: 'delivering',
      deliveryOwnerId: deliveryOwnerId ?? null,
      deliveryHeartbeatAt: deliveryOwnerId ? databaseNowMs : null,
      deliveryErrorText: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(piDelegations.id, id),
      inArray(piDelegations.status, ['completed', 'failed']),
      or(
        eq(piDelegations.deliveryStatus, 'pending'),
        eq(piDelegations.deliveryStatus, 'failed'),
      ),
    ))
    .returning();
  return claimed ?? null;
}

/** A requested stop survives the owner's crash and is never replayed. */
export async function cancelInterruptedPiDelegations(): Promise<PiDelegationRecord[]> {
  const now = new Date();
  return db.update(piDelegations)
    .set({
      status: 'cancelled',
      resultStatus: 'error',
      errorText: 'Delegated task was cancelled after its worker stopped responding.',
      completedAt: now,
      deliveryStatus: 'skipped',
      updatedAt: now,
    })
    .where(and(
      eq(piDelegations.status, 'running'),
      isNotNull(piDelegations.runOwnerId),
      isNotNull(piDelegations.cancelRequestedAt),
      staleRunLease,
    ))
    .returning();
}

/** A crashed worker may already have caused external side effects. Never replay it. */
export async function failInterruptedPiDelegations(): Promise<PiDelegationRecord[]> {
  const interrupted = await db.query.piDelegations.findMany({
    where: and(eq(piDelegations.status, 'running'), isNotNull(piDelegations.runOwnerId), isNull(piDelegations.cancelRequestedAt), staleRunLease),
    columns: { id: true },
  });
  if (interrupted.length === 0) return [];

  const now = new Date();
  return await db.update(piDelegations)
    .set({
      status: 'failed',
      resultStatus: 'error',
      errorText: 'Delegated task was interrupted by a process restart. Start a new task to continue.',
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      inArray(piDelegations.id, interrupted.map((record) => record.id)),
      eq(piDelegations.status, 'running'),
      isNotNull(piDelegations.runOwnerId),
      isNull(piDelegations.cancelRequestedAt),
      staleRunLease,
    ))
    .returning();
}

export async function recoverInterruptedPiDelegationDeliveries(): Promise<number> {
  const interrupted = await db.query.piDelegations.findMany({
    where: and(eq(piDelegations.deliveryStatus, 'delivering'), isNotNull(piDelegations.deliveryOwnerId), staleDeliveryLease),
    columns: { id: true },
  });
  if (interrupted.length === 0) return 0;

  const changed = await db.update(piDelegations)
    .set({
      deliveryStatus: 'skipped',
      deliveryErrorText: 'Completion delivery was interrupted and its receipt is uncertain. Inspect the task result before sending again.',
      updatedAt: new Date(),
    })
    .where(and(
      inArray(piDelegations.id, interrupted.map((record) => record.id)),
      eq(piDelegations.deliveryStatus, 'delivering'),
      isNotNull(piDelegations.deliveryOwnerId),
      staleDeliveryLease,
    ))
    .returning({ id: piDelegations.id });
  return changed.length;
}
