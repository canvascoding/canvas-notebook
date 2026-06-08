import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';

import { db } from '@/app/lib/db';
import { todoEmailReplyWatchers } from '@/app/lib/db/schema';

type TodoEmailReplyWatcher = typeof todoEmailReplyWatchers.$inferSelect;

export type CreateTodoEmailReplyWatcherInput = {
  todoId: string;
  userId: string;
  accountId: string;
  replyToken: string;
  outboundMessageId?: string | null;
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  locale?: string | null;
  sentAt?: Date;
};

function normalizeLocale(value: string | null | undefined): 'de' | 'en' {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'de';
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function createTodoEmailReplyToken(): string {
  return `CTD-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function appendTodoEmailReplyTokenToSubject(subject: string, replyToken: string): string {
  const suffix = ` [${replyToken}]`;
  const normalized = subject.trim() || 'Canvas To-do';
  if (normalized.includes(replyToken)) return normalized.slice(0, 120);
  return `${normalized.slice(0, Math.max(1, 120 - suffix.length)).trimEnd()}${suffix}`;
}

export function todoEmailReplyTrackingHeaders(todoId: string, replyToken: string): Record<string, string> {
  return {
    'X-Canvas-Todo-Id': todoId,
    'X-Canvas-Reply-Token': replyToken,
  };
}

export async function createTodoEmailReplyWatcher(input: CreateTodoEmailReplyWatcherInput): Promise<TodoEmailReplyWatcher> {
  const now = new Date();
  const [created] = await db.insert(todoEmailReplyWatchers).values({
    id: `todo-reply-watch-${randomUUID()}`,
    todoId: input.todoId,
    userId: input.userId,
    accountId: input.accountId,
    status: 'active',
    replyToken: input.replyToken,
    outboundMessageId: normalizeText(input.outboundMessageId, 500),
    sourceAgentId: normalizeText(input.sourceAgentId, 120),
    sourceSessionId: normalizeText(input.sourceSessionId, 160),
    locale: normalizeLocale(input.locale),
    sentAt: input.sentAt || now,
    lastCheckedAt: null,
    completedAt: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return created;
}
