import 'server-only';

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piDelegations } from '@/app/lib/db/schema';

export type PiDelegationWorkerType = 'ephemeral' | 'managed';
export type PiDelegationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type PiDelegationDeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'skipped';
export type PiDelegationResultStatus = 'ok' | 'timeout' | 'error';
export type PiDelegationRecord = typeof piDelegations.$inferSelect;

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
  const [created] = await db.insert(piDelegations).values({
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

export async function claimQueuedPiDelegation(id: string): Promise<PiDelegationRecord | null> {
  const now = new Date();
  const [claimed] = await db.update(piDelegations)
    .set({
      status: 'running',
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

export async function updateRunningPiDelegationWorkerSession(
  id: string,
  workerSessionId: string,
): Promise<PiDelegationRecord | null> {
  const [updated] = await db.update(piDelegations)
    .set({ workerSessionId, updatedAt: new Date() })
    .where(and(eq(piDelegations.id, id), eq(piDelegations.status, 'running')))
    .returning();
  return updated ?? null;
}

export async function completeRunningPiDelegation(input: {
  id: string;
  resultStatus: PiDelegationResultStatus;
  resultText?: string;
  errorText?: string;
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
    .where(and(eq(piDelegations.id, input.id), eq(piDelegations.status, 'running')))
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

export async function cancelRunningPiDelegation(id: string, errorText: string): Promise<PiDelegationRecord | null> {
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
    .where(and(eq(piDelegations.id, id), eq(piDelegations.status, 'running')))
    .returning();
  return updated ?? null;
}

export async function updatePiDelegationDelivery(input: {
  id: string;
  status: PiDelegationDeliveryStatus;
  deliveryErrorText?: string;
}): Promise<PiDelegationRecord | null> {
  const now = new Date();
  const [updated] = await db.update(piDelegations)
    .set({
      deliveryStatus: input.status,
      deliveredAt: input.status === 'delivered' ? now : undefined,
      deliveryErrorText: input.deliveryErrorText ?? null,
      updatedAt: now,
    })
    .where(eq(piDelegations.id, input.id))
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

export async function claimPiDelegationDelivery(id: string): Promise<PiDelegationRecord | null> {
  const [claimed] = await db.update(piDelegations)
    .set({
      deliveryStatus: 'delivering',
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

export async function requeueInterruptedPiDelegations(): Promise<number> {
  const interrupted = await db.query.piDelegations.findMany({
    where: eq(piDelegations.status, 'running'),
    columns: { id: true },
  });
  if (interrupted.length === 0) return 0;

  await db.update(piDelegations)
    .set({
      status: 'queued',
      startedAt: null,
      updatedAt: new Date(),
    })
    .where(inArray(piDelegations.id, interrupted.map((record) => record.id)));
  return interrupted.length;
}

export async function recoverInterruptedPiDelegationDeliveries(): Promise<number> {
  const interrupted = await db.query.piDelegations.findMany({
    where: eq(piDelegations.deliveryStatus, 'delivering'),
    columns: { id: true },
  });
  if (interrupted.length === 0) return 0;

  await db.update(piDelegations)
    .set({
      deliveryStatus: 'failed',
      deliveryErrorText: 'Completion delivery was interrupted and will be retried.',
      updatedAt: new Date(),
    })
    .where(inArray(piDelegations.id, interrupted.map((record) => record.id)));
  return interrupted.length;
}
