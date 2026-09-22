import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piMessageDeliveryReceipts, piMessages, piSessions } from '@/app/lib/db/schema';

export class MessageDeliveryError extends Error {
  get statusCode() { return this.code === 'INVALID_CLIENT_MESSAGE_ID' ? 400 : 409; }
  constructor(readonly code: 'MESSAGE_ID_CONFLICT' | 'MESSAGE_DELIVERY_UNCERTAIN' | 'INVALID_CLIENT_MESSAGE_ID', message: string) {
    super(message);
    this.name = 'MessageDeliveryError';
  }
}

type RuntimeReceiptState = { token: string; accepted: Set<string> };
const receiptGlobal = globalThis as typeof globalThis & {
  __canvasMessageReceiptRuntimes?: WeakMap<object, RuntimeReceiptState>;
};
const runtimeStates = receiptGlobal.__canvasMessageReceiptRuntimes ??= new WeakMap<object, RuntimeReceiptState>();

function runtimeState(runtime: object): RuntimeReceiptState {
  let state = runtimeStates.get(runtime);
  if (!state) {
    state = { token: randomUUID(), accepted: new Set() };
    runtimeStates.set(runtime, state);
  }
  return state;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Called inside the session operation lock, after authorization and preparation.
 * A receipt prevents duplicate dispatch even if the socket acknowledgement is lost.
 * Runtime loss before transcript persistence is explicitly uncertain: never silently
 * acknowledge or re-execute a possibly already executed prompt/tool operation.
 */
export async function withMessageDeliveryReceipt<T>(input: {
  sessionId: string;
  userId: string;
  runtime: { getStatus: () => T };
  message: { content: unknown; clientMessageId?: unknown };
  context?: unknown;
  mode?: 'message' | 'steer';
  dispatch: () => T | Promise<T>;
}): Promise<T> {
  const rawId = input.message.clientMessageId;
  if (rawId === undefined) return input.dispatch();
  if (typeof rawId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawId)) {
    throw new MessageDeliveryError('INVALID_CLIENT_MESSAGE_ID', 'A valid client message ID is required.');
  }
  const [session] = await db.select({ id: piSessions.id }).from(piSessions).where(and(
    eq(piSessions.sessionId, input.sessionId), eq(piSessions.userId, input.userId),
  )).limit(1);
  if (!session) throw new Error('Session not found.');

  // Exclude timestamps and runtime-resolved context: a transport retry can have a new
  // timestamp, and workspace metadata may have refreshed since the first attempt.
  const payloadHash = createHash('sha256').update(canonicalJson({
    content: input.message.content, context: input.context ?? null, mode: input.mode ?? 'message',
  })).digest('hex');
  const state = runtimeState(input.runtime);
  const acceptedKey = `${session.id}:${rawId}`;
  const condition = and(eq(piMessageDeliveryReceipts.piSessionDbId, session.id), eq(piMessageDeliveryReceipts.clientMessageId, rawId));
  const [existingReceipt] = await db.select().from(piMessageDeliveryReceipts).where(condition).limit(1);
  const findPersistedMessage = async () => (await db.select({ id: piMessages.id }).from(piMessages).where(and(
    eq(piMessages.piSessionDbId, session.id), eq(piMessages.role, 'user'),
    sql`${piMessages.content}::jsonb ->> 'clientMessageId' = ${rawId}`,
  )).limit(1))[0];
  // Older mobile clients already persisted message IDs before admission receipts
  // existed. Their original context cannot be verified, so never dispatch them again.
  if (!existingReceipt && await findPersistedMessage()) {
    throw new MessageDeliveryError('MESSAGE_DELIVERY_UNCERTAIN',
      'This message ID already exists in the chat history, but its original delivery context cannot be verified. Check the chat before sending it again.');
  }
  const now = new Date();
  const claimed = existingReceipt ? undefined : (await db.insert(piMessageDeliveryReceipts).values({
    piSessionDbId: session.id, clientMessageId: rawId, payloadHash,
    runtimeToken: state.token, state: 'dispatching', createdAt: now, updatedAt: now,
  }).onConflictDoNothing().returning())[0];
  if (!claimed) {
    const receipt = existingReceipt ?? (await db.select().from(piMessageDeliveryReceipts).where(condition).limit(1))[0];
    if (!receipt || receipt.payloadHash !== payloadHash) {
      throw new MessageDeliveryError('MESSAGE_ID_CONFLICT', 'This message ID was already used for different content or context.');
    }
    if (receipt.runtimeToken === state.token && (receipt.state === 'accepted' || state.accepted.has(acceptedKey))) {
      return input.runtime.getStatus();
    }
    const persisted = await findPersistedMessage();
    if (persisted) return input.runtime.getStatus();
    throw new MessageDeliveryError('MESSAGE_DELIVERY_UNCERTAIN',
      'Delivery of this message is uncertain after the chat runtime changed. Check the chat before sending it again.');
  }

  // Any exception after dispatch begins remains conservatively reserved. Retrying
  // an unknown partial failure must not run the same tools a second time.
  const result = await input.dispatch();
  state.accepted.add(acceptedKey);
  await db.update(piMessageDeliveryReceipts).set({ state: 'accepted', updatedAt: new Date() }).where(condition);
  return result;
}
