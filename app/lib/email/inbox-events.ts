import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailAccounts, emailInboxEvents, workspaceEmailMailboxes } from '@/app/lib/db/schema';
import {
  resolveProviderMessageIdentity,
  type ProviderMessageIdentity,
} from '@/app/lib/email/provider-message-identity';

type InboxMessage = {
  id: string;
  threadId?: string;
  date?: string;
  folder?: string;
  hasAttachments?: boolean;
  uid?: string;
  uidValidity?: string;
};

type EmailInboxEvent = typeof emailInboxEvents.$inferSelect;

type PollMailbox = {
  id: string;
  workspaceId: string;
  createdAt: Date;
  accountId: string;
  userId: string;
};

export type EmailInboxPollResult = {
  checked: number;
  created: number;
  duplicate: number;
  historical: number;
  failed: number;
};

function normalizedMessage(value: unknown, listUidValidity?: unknown): InboxMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const uid = typeof record.uid === 'number' && Number.isSafeInteger(record.uid)
    ? String(record.uid)
    : typeof record.uid === 'string' ? record.uid.trim() : '';
  const rawUidValidity = record.uidValidity ?? listUidValidity;
  const uidValidity = typeof rawUidValidity === 'number' && Number.isSafeInteger(rawUidValidity)
    ? String(rawUidValidity)
    : typeof rawUidValidity === 'string' ? rawUidValidity.trim() : '';
  return {
    id,
    threadId: typeof record.threadId === 'string' ? record.threadId.trim() || undefined : undefined,
    date: typeof record.date === 'string' ? record.date : undefined,
    folder: typeof record.folder === 'string' ? record.folder : undefined,
    hasAttachments: record.hasAttachments === true,
    uid: uid || undefined,
    uidValidity: uidValidity || undefined,
  };
}

function receivedAt(message: InboxMessage, fallback: Date): Date {
  const parsed = message.date ? new Date(message.date) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
}

function idempotencyKey(mailboxId: string, providerMessageId: string): string {
  return createHash('sha256').update(`${mailboxId}:${providerMessageId}`).digest('hex');
}

function inboxEventMetadata(message: InboxMessage, identity: ProviderMessageIdentity): string {
  return JSON.stringify({
    folder: identity.folder,
    hasAttachments: Boolean(message.hasAttachments),
    ...(identity.isImap ? {
      identityVersion: 1,
      uid: identity.uid,
      uidValidity: identity.uidValidity,
    } : {}),
  });
}

function parseInboxEventMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function legacyInboxEventMatches(
  event: EmailInboxEvent,
  message: InboxMessage,
  identity: ProviderMessageIdentity,
  messageReceivedAt: Date,
): boolean {
  if (!identity.isImap || !identity.legacyId || event.providerMessageId !== identity.legacyId) return false;
  if (event.receivedAt.getTime() !== messageReceivedAt.getTime()) return false;
  const threadId = message.threadId?.trim();
  if (!threadId || event.providerThreadId !== threadId) return false;

  const metadata = parseInboxEventMetadata(event.metadataJson);
  if (!metadata || metadata.folder !== identity.folder) return false;
  if (Boolean(metadata.hasAttachments) !== Boolean(message.hasAttachments)) return false;
  if (typeof metadata.uid === 'string' && metadata.uid !== identity.uid) return false;
  if (typeof metadata.uidValidity === 'string' && metadata.uidValidity !== identity.uidValidity) return false;
  return true;
}

async function migrateMatchingLegacyInboxEvent(input: {
  mailboxId: string;
  message: InboxMessage;
  identity: ProviderMessageIdentity;
  messageReceivedAt: Date;
  canonicalKey: string;
  metadataJson: string;
  now: Date;
}): Promise<boolean> {
  const legacyId = input.identity.legacyId;
  if (!input.identity.isImap || !legacyId || legacyId === input.identity.canonicalId) return false;
  const legacyKey = idempotencyKey(input.mailboxId, legacyId);
  const legacy = await db.query.emailInboxEvents.findFirst({
    where: and(
      eq(emailInboxEvents.mailboxId, input.mailboxId),
      eq(emailInboxEvents.idempotencyKey, legacyKey),
    ),
  });
  if (!legacy || !legacyInboxEventMatches(legacy, input.message, input.identity, input.messageReceivedAt)) {
    return false;
  }

  try {
    const migrated = await db
      .update(emailInboxEvents)
      .set({
        providerMessageId: input.identity.canonicalId,
        idempotencyKey: input.canonicalKey,
        metadataJson: input.metadataJson,
        updatedAt: input.now,
      })
      .where(and(
        eq(emailInboxEvents.id, legacy.id),
        eq(emailInboxEvents.idempotencyKey, legacyKey),
      ))
      .returning({ id: emailInboxEvents.id });
    return migrated.length > 0;
  } catch (error) {
    const canonical = await db.query.emailInboxEvents.findFirst({
      where: and(
        eq(emailInboxEvents.mailboxId, input.mailboxId),
        eq(emailInboxEvents.idempotencyKey, input.canonicalKey),
      ),
      columns: { id: true },
    });
    if (canonical) return true;
    throw error;
  }
}

async function listActiveMailboxes(limit: number): Promise<PollMailbox[]> {
  const rows = await db
    .select({
      id: workspaceEmailMailboxes.id,
      workspaceId: workspaceEmailMailboxes.workspaceId,
      createdAt: workspaceEmailMailboxes.createdAt,
      accountId: emailAccounts.id,
      userId: emailAccounts.userId,
    })
    .from(workspaceEmailMailboxes)
    .innerJoin(emailAccounts, eq(emailAccounts.id, workspaceEmailMailboxes.emailAccountId))
    .where(and(eq(workspaceEmailMailboxes.status, 'active'), eq(emailAccounts.status, 'active')))
    .limit(limit);
  return rows;
}

export async function pollWorkspaceMailboxInboxEvents(options: {
  now?: Date;
  limit?: number;
  fetchMessages?: (mailbox: PollMailbox) => Promise<unknown[]>;
} = {}): Promise<EmailInboxPollResult> {
  const now = options.now || new Date();
  const mailboxes = await listActiveMailboxes(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const result: EmailInboxPollResult = { checked: 0, created: 0, duplicate: 0, historical: 0, failed: 0 };

  for (const mailbox of mailboxes) {
    result.checked += 1;
    try {
      const rawMessages = options.fetchMessages
        ? await options.fetchMessages(mailbox)
        : await (async () => {
            const { listEmailMessages } = await import('@/app/lib/email/service');
            const listed = await listEmailMessages(mailbox.userId, {
              accountId: mailbox.accountId,
              folder: 'INBOX',
              limit: 50,
            }, { enforceReadPolicy: true, workspaceId: mailbox.workspaceId }) as {
              messages?: unknown[];
              uidValidity?: unknown;
            };
            return (listed.messages || []).map((message) => {
              if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
              const record = message as Record<string, unknown>;
              return record.uidValidity === undefined && listed.uidValidity !== undefined
                ? { ...record, uidValidity: listed.uidValidity }
                : message;
            });
          })();
      for (const rawMessage of rawMessages) {
        const message = normalizedMessage(rawMessage);
        if (!message) continue;
        const messageReceivedAt = receivedAt(message, now);
        if (messageReceivedAt.getTime() < mailbox.createdAt.getTime()) {
          result.historical += 1;
          continue;
        }
        const identity = resolveProviderMessageIdentity(message);
        const key = idempotencyKey(mailbox.id, identity.canonicalId);
        const metadataJson = inboxEventMetadata(message, identity);
        const existing = await db.query.emailInboxEvents.findFirst({
          where: and(eq(emailInboxEvents.mailboxId, mailbox.id), eq(emailInboxEvents.idempotencyKey, key)),
          columns: { id: true },
        });
        if (existing) {
          result.duplicate += 1;
          continue;
        }
        if (await migrateMatchingLegacyInboxEvent({
          mailboxId: mailbox.id,
          message,
          identity,
          messageReceivedAt,
          canonicalKey: key,
          metadataJson,
          now,
        })) {
          result.duplicate += 1;
          continue;
        }
        const inserted = await db.insert(emailInboxEvents).values({
          id: `email-event-${randomUUID()}`,
          mailboxId: mailbox.id,
          workspaceId: mailbox.workspaceId,
          providerMessageId: identity.canonicalId,
          providerThreadId: message.threadId || null,
          idempotencyKey: key,
          eventType: 'message_received',
          receivedAt: messageReceivedAt,
          processedAt: null,
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: null,
          errorCode: null,
          caseId: null,
          metadataJson,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing().returning({ id: emailInboxEvents.id });
        if (inserted.length > 0) result.created += 1;
        else result.duplicate += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.warn('[EmailInboxPoll] Failed to poll mailbox', mailbox.id, error instanceof Error ? error.message : error);
    }
  }
  return result;
}
