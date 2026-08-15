import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { emailAccounts, emailInboxEvents, workspaceEmailMailboxes } from '@/app/lib/db/schema';

type InboxMessage = {
  id: string;
  threadId?: string;
  date?: string;
  folder?: string;
  hasAttachments?: boolean;
};

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

function normalizedMessage(value: unknown): InboxMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  return {
    id,
    threadId: typeof record.threadId === 'string' ? record.threadId.trim() || undefined : undefined,
    date: typeof record.date === 'string' ? record.date : undefined,
    folder: typeof record.folder === 'string' ? record.folder : undefined,
    hasAttachments: record.hasAttachments === true,
  };
}

function receivedAt(message: InboxMessage, fallback: Date): Date {
  const parsed = message.date ? new Date(message.date) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
}

function idempotencyKey(mailboxId: string, providerMessageId: string): string {
  return createHash('sha256').update(`${mailboxId}:${providerMessageId}`).digest('hex');
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
            }, { enforceReadPolicy: true, workspaceId: mailbox.workspaceId }) as { messages?: unknown[] };
            return listed.messages || [];
          })();
      for (const rawMessage of rawMessages) {
        const message = normalizedMessage(rawMessage);
        if (!message) continue;
        const messageReceivedAt = receivedAt(message, now);
        if (messageReceivedAt.getTime() < mailbox.createdAt.getTime()) {
          result.historical += 1;
          continue;
        }
        const key = idempotencyKey(mailbox.id, message.id);
        const existing = await db.query.emailInboxEvents.findFirst({
          where: and(eq(emailInboxEvents.mailboxId, mailbox.id), eq(emailInboxEvents.idempotencyKey, key)),
          columns: { id: true },
        });
        if (existing) {
          result.duplicate += 1;
          continue;
        }
        await db.insert(emailInboxEvents).values({
          id: `email-event-${randomUUID()}`,
          mailboxId: mailbox.id,
          workspaceId: mailbox.workspaceId,
          providerMessageId: message.id,
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
          metadataJson: JSON.stringify({ folder: message.folder || 'INBOX', hasAttachments: Boolean(message.hasAttachments) }),
          createdAt: now,
          updatedAt: now,
        });
        result.created += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.warn('[EmailInboxPoll] Failed to poll mailbox', mailbox.id, error instanceof Error ? error.message : error);
    }
  }
  return result;
}
