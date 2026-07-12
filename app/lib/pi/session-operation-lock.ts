import {
  type KeyedOperationLease,
  withKeyedOperationLease,
  withKeyedOperationLock,
} from '@/app/lib/concurrency/keyed-operation-lock';

export type PiSessionOperationLease = KeyedOperationLease;

function sessionOperationKey(sessionId: string, userId: string): string {
  return JSON.stringify([userId, sessionId]);
}

/**
 * Serializes operations that may start or replace a live runtime for one
 * user-owned session. The lock intentionally spans asynchronous preparation:
 * a model change cannot pass its idle check while a prompt is preparing, and
 * a prompt cannot obtain the old runtime while a model change is being saved.
 */
export async function withPiSessionOperationLock<T>(
  sessionId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedOperationLock('pi-session', sessionOperationKey(sessionId, userId), operation);
}

export async function withQuarantinablePiSessionOperationLock<T>(
  sessionId: string,
  userId: string,
  operation: (lease: PiSessionOperationLease) => Promise<T>,
): Promise<T> {
  return withKeyedOperationLease('pi-session', sessionOperationKey(sessionId, userId), operation);
}
