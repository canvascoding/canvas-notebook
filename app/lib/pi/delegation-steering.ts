import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piDelegations, piDelegationSteering } from '@/app/lib/db/schema';
import { authorizePiDelegationInspection } from '@/app/lib/pi/delegation-progress';
import { PI_DELEGATION_LEASE_TIMEOUT_MS } from '@/app/lib/pi/delegation-store';

export type PiDelegationSteeringStatus = 'accepted' | 'claimed' | 'delivered' | 'missed';
export type PiDelegationSteeringReceipt = {
  id: string;
  delegationId: string;
  status: PiDelegationSteeringStatus;
  createdAt: Date;
  claimedAt: Date | null;
  deliveredAt: Date | null;
  missedAt: Date | null;
};
export type PiDelegationSteeringCommand = PiDelegationSteeringReceipt & {
  message: string;
  runOwnerId: string;
};

const MAX_STEERING_CHARS = 4_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 160;
const databaseNowMs = sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
const freshRunLease = sql`${piDelegations.runHeartbeatAt} >= ${databaseNowMs} - ${PI_DELEGATION_LEASE_TIMEOUT_MS}`;

function receipt(row: typeof piDelegationSteering.$inferSelect): PiDelegationSteeringReceipt {
  return {
    id: row.id,
    delegationId: row.delegationId,
    status: row.status as PiDelegationSteeringStatus,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    deliveredAt: row.deliveredAt,
    missedAt: row.missedAt,
  };
}

function normalizedMessage(message: string): string {
  const value = message.trim();
  if (!value || value.length > MAX_STEERING_CHARS) {
    throw new Error(`Steering message must contain 1-${MAX_STEERING_CHARS} characters.`);
  }
  return value;
}

function normalizedIdempotencyKey(key: string): string {
  const value = key.trim();
  if (!value || value.length > MAX_IDEMPOTENCY_KEY_CHARS || !/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    throw new Error('Invalid steering idempotency key.');
  }
  return value;
}

/** Accept at most one copy of a correction for one live execution lease. */
export async function acceptPiDelegationSteering(input: {
  delegationId: string;
  userId: string;
  sourceSessionId: string;
  idempotencyKey: string;
  message: string;
}): Promise<PiDelegationSteeringReceipt> {
  const message = normalizedMessage(input.message);
  const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
  await authorizePiDelegationInspection({
    delegationId: input.delegationId,
    userId: input.userId,
    sourceSessionId: input.sourceSessionId,
  });

  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(piDelegations)
      .where(and(
        eq(piDelegations.id, input.delegationId),
        eq(piDelegations.userId, input.userId),
        eq(piDelegations.sourceSessionId, input.sourceSessionId),
      ))
      .for('update');
    if (!task) throw new Error('Delegation not found.');

    const [previous] = await tx.select().from(piDelegationSteering)
      .where(and(
        eq(piDelegationSteering.delegationId, task.id),
        eq(piDelegationSteering.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    if (previous) {
      if (previous.message !== message || previous.userId !== input.userId || previous.sourceSessionId !== input.sourceSessionId) {
        throw new Error('Steering idempotency key was already used with another instruction.');
      }
      return receipt(previous);
    }

    const [liveTask] = await tx.select({ runOwnerId: piDelegations.runOwnerId })
      .from(piDelegations)
      .where(and(
        eq(piDelegations.id, task.id),
        eq(piDelegations.status, 'running'),
        sql`${piDelegations.cancelRequestedAt} IS NULL`,
        sql`${piDelegations.runOwnerId} IS NOT NULL`,
        freshRunLease,
      ));
    if (!liveTask?.runOwnerId) throw new Error('Delegated task is no longer running. Start a follow-up task instead.');

    const now = new Date();
    const [created] = await tx.insert(piDelegationSteering).values({
      id: `steer-${randomUUID()}`,
      delegationId: task.id,
      userId: input.userId,
      sourceSessionId: input.sourceSessionId,
      runOwnerId: liveTask.runOwnerId,
      idempotencyKey,
      message,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!created) throw new Error('Steering instruction could not be accepted.');
    return receipt(created);
  });
}

/** The owning worker takes the oldest correction; no other process can take it. */
export async function claimNextPiDelegationSteering(input: {
  delegationId: string;
  userId: string;
  runOwnerId: string;
}): Promise<PiDelegationSteeringCommand | null> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select({ id: piDelegations.id }).from(piDelegations)
      .where(and(
        eq(piDelegations.id, input.delegationId),
        eq(piDelegations.userId, input.userId),
        eq(piDelegations.status, 'running'),
        eq(piDelegations.runOwnerId, input.runOwnerId),
        sql`${piDelegations.cancelRequestedAt} IS NULL`,
        freshRunLease,
      ))
      .for('update');
    if (!task) return null;

    const [next] = await tx.select().from(piDelegationSteering)
      .where(and(
        eq(piDelegationSteering.delegationId, task.id),
        eq(piDelegationSteering.userId, input.userId),
        eq(piDelegationSteering.runOwnerId, input.runOwnerId),
        eq(piDelegationSteering.status, 'accepted'),
      ))
      .orderBy(asc(piDelegationSteering.createdAt), asc(piDelegationSteering.id))
      .limit(1)
      .for('update');
    if (!next) return null;

    const [claimed] = await tx.update(piDelegationSteering)
      .set({ status: 'claimed', claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(piDelegationSteering.id, next.id), eq(piDelegationSteering.status, 'accepted')))
      .returning();
    return claimed ? { ...receipt(claimed), message: claimed.message, runOwnerId: claimed.runOwnerId } : null;
  });
}

/** Confirm only after the SDK emitted this user message and its child checkpoint committed. */
export async function confirmPiDelegationSteeringDelivered(input: {
  id: string;
  delegationId: string;
  userId: string;
  runOwnerId: string;
}): Promise<PiDelegationSteeringReceipt | null> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select({ id: piDelegations.id }).from(piDelegations)
      .where(and(
        eq(piDelegations.id, input.delegationId),
        eq(piDelegations.userId, input.userId),
        eq(piDelegations.status, 'running'),
        eq(piDelegations.runOwnerId, input.runOwnerId),
        freshRunLease,
      ))
      .for('update');
    if (!task) return null;

    const [confirmed] = await tx.update(piDelegationSteering)
      .set({ status: 'delivered', deliveredAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(piDelegationSteering.id, input.id),
        eq(piDelegationSteering.delegationId, task.id),
        eq(piDelegationSteering.userId, input.userId),
        eq(piDelegationSteering.runOwnerId, input.runOwnerId),
        eq(piDelegationSteering.status, 'claimed'),
      ))
      .returning();
    if (confirmed) return receipt(confirmed);

    const [previous] = await tx.select().from(piDelegationSteering)
      .where(and(
        eq(piDelegationSteering.id, input.id),
        eq(piDelegationSteering.delegationId, task.id),
        eq(piDelegationSteering.userId, input.userId),
        eq(piDelegationSteering.runOwnerId, input.runOwnerId),
        eq(piDelegationSteering.status, 'delivered'),
      ))
      .limit(1);
    return previous ? receipt(previous) : null;
  });
}

/** Call after a terminal task transition; unfinished corrections are explicit misses. */
export async function markUndeliveredPiDelegationSteeringMissed(input: {
  delegationId: string;
  userId: string;
}): Promise<number> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select({ id: piDelegations.id, status: piDelegations.status })
      .from(piDelegations)
      .where(and(eq(piDelegations.id, input.delegationId), eq(piDelegations.userId, input.userId)))
      .for('update');
    if (!task || task.status === 'running' || task.status === 'queued') return 0;
    const changed = await tx.update(piDelegationSteering)
      .set({ status: 'missed', missedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(piDelegationSteering.delegationId, task.id),
        eq(piDelegationSteering.userId, input.userId),
        inArray(piDelegationSteering.status, ['accepted', 'claimed']),
      ))
      .returning({ id: piDelegationSteering.id });
    return changed.length;
  });
}

export async function readAuthorizedPiDelegationSteeringReceipt(input: {
  id: string;
  delegationId: string;
  userId: string;
  sourceSessionId: string;
}): Promise<PiDelegationSteeringReceipt | null> {
  await authorizePiDelegationInspection({
    delegationId: input.delegationId,
    userId: input.userId,
    sourceSessionId: input.sourceSessionId,
  });
  const [row] = await db.select().from(piDelegationSteering)
    .where(and(
      eq(piDelegationSteering.id, input.id),
      eq(piDelegationSteering.delegationId, input.delegationId),
      eq(piDelegationSteering.userId, input.userId),
      eq(piDelegationSteering.sourceSessionId, input.sourceSessionId),
    ))
    .limit(1);
  return row ? receipt(row) : null;
}
