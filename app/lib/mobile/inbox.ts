import 'server-only';

import {
  and,
  count as countRows,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';

import { piSessionReadCursorSql } from '@/app/lib/chat/read-cursor';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { db } from '@/app/lib/db';
import {
  automationJobs,
  automationRuns,
  mobileInboxReadStates,
  piSessions,
  studioGenerations,
  todoItems,
} from '@/app/lib/db/schema';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { getTodo, listTodos, markTodoSeen } from '@/app/lib/todos/store';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const BASELINE_KEY = '__baseline__';
const MAX_SOURCE_ITEMS = 200;
const INITIAL_UNREAD_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const MOBILE_INBOX_FILTERS = ['all', 'unread', 'chat', 'todos', 'studio', 'automation'] as const;
export type MobileInboxFilter = typeof MOBILE_INBOX_FILTERS[number];

export type MobileInboxItem = {
  id: string;
  type: 'chat.response' | 'todo.attention' | 'studio.completed' | 'studio.failed' | 'automation.failed';
  title: string;
  detail: string | null;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  target:
    | { kind: 'chat'; sessionId: string }
    | { kind: 'todo'; todoId: string }
    | { kind: 'studio'; generationId: string }
    | { kind: 'automation'; runId: string };
};

type InboxCursor = {
  workspaceId: string;
  filter: MobileInboxFilter;
  occurredAt: string;
  id: string;
};

export class MobileInboxError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'MobileInboxError';
  }
}

function workspaceCondition(column: AnyColumn, workspace: WorkspaceContext): SQL {
  return workspace.workspaceType === 'personal'
    ? or(eq(column, workspace.workspaceId), isNull(column))!
    : eq(column, workspace.workspaceId);
}

function todoWorkspaceOptions(workspace: WorkspaceContext) {
  if (workspace.workspaceType === 'organization' || workspace.workspaceType === 'team' || workspace.workspaceType === 'project') {
    return {
      workspaceType: workspace.workspaceType,
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
    } as const;
  }
  return { workspaceType: 'personal' as const };
}

function todoBelongsToWorkspace(todo: Awaited<ReturnType<typeof getTodo>>, workspace: WorkspaceContext): boolean {
  if (!todo) return false;
  if (workspace.workspaceType === 'personal') {
    return todo.workspaceType === 'personal' && (!todo.workspaceId || todo.workspaceId === workspace.workspaceId);
  }
  return todo.workspaceType === workspace.workspaceType && todo.workspaceId === workspace.workspaceId;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MobileInboxError('INVALID_LIMIT', 'The Inbox page size is invalid.', 400);
  }
  return Math.min(value, 50);
}

function encodeCursor(value: InboxCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null | undefined, workspaceId: string, filter: MobileInboxFilter): InboxCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<InboxCursor>;
    if (
      parsed.workspaceId !== workspaceId
      || parsed.filter !== filter
      || typeof parsed.id !== 'string'
      || typeof parsed.occurredAt !== 'string'
      || Number.isNaN(new Date(parsed.occurredAt).getTime())
    ) throw new Error('Invalid cursor');
    return parsed as InboxCursor;
  } catch {
    throw new MobileInboxError('INVALID_CURSOR', 'The Inbox cursor is invalid for this view.', 400);
  }
}

async function readState(input: { userId: string; workspaceId: string }) {
  const now = new Date();
  const baseline = new Date(now.getTime() - INITIAL_UNREAD_WINDOW_MS);
  await db.insert(mobileInboxReadStates).values({
    userId: input.userId,
    workspaceId: input.workspaceId,
    itemKey: BASELINE_KEY,
    readAt: baseline,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const rows = await db.select({ itemKey: mobileInboxReadStates.itemKey, readAt: mobileInboxReadStates.readAt })
    .from(mobileInboxReadStates)
    .where(and(
      eq(mobileInboxReadStates.userId, input.userId),
      eq(mobileInboxReadStates.workspaceId, input.workspaceId),
    ));
  return {
    baseline: rows.find((row) => row.itemKey === BASELINE_KEY)?.readAt || baseline,
    itemKeys: new Set(rows.map((row) => row.itemKey)),
  };
}

function genericUnread(itemKey: string, occurredAt: Date, state: Awaited<ReturnType<typeof readState>>): boolean {
  return occurredAt > state.baseline && !state.itemKeys.has(itemKey);
}

async function collectInboxItems(input: { userId: string; workspace: WorkspaceContext }) {
  const state = await readState({ userId: input.userId, workspaceId: input.workspace.workspaceId });
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const [sessionRows, todos, generationRows, automationRows] = await Promise.all([
    db.select({
      sessionId: piSessions.sessionId,
      title: piSessions.title,
      lastMessageAt: piSessions.lastMessageAt,
      lastViewedAt: piSessions.lastViewedAt,
    }).from(piSessions).where(and(
      eq(piSessions.userId, input.userId),
      workspaceCondition(piSessions.workspaceId, input.workspace),
    )).orderBy(desc(piSessions.lastMessageAt), desc(piSessions.id)).limit(MAX_SOURCE_ITEMS),
    listTodos(input.userId, {
      ...todoWorkspaceOptions(input.workspace),
      status: 'active',
      limit: MAX_SOURCE_ITEMS,
    }),
    db.select({
      id: studioGenerations.id,
      status: studioGenerations.status,
      presetName: studioGenerations.studioPresetName,
      mode: studioGenerations.mode,
      updatedAt: studioGenerations.updatedAt,
    }).from(studioGenerations).where(and(
      workspaceCondition(studioGenerations.workspaceId, input.workspace),
      inArray(studioGenerations.status, ['completed', 'failed']),
      input.workspace.workspaceType === 'personal' ? eq(studioGenerations.userId, input.userId) : undefined,
    )).orderBy(desc(studioGenerations.updatedAt)).limit(MAX_SOURCE_ITEMS),
    db.select({
      runId: automationRuns.id,
      jobName: automationJobs.name,
      errorMessage: automationRuns.errorMessage,
      occurredAt: automationRuns.finishedAt,
      createdAt: automationRuns.createdAt,
    }).from(automationRuns).innerJoin(automationJobs, eq(automationJobs.id, automationRuns.jobId)).where(and(
      workspaceCondition(automationRuns.workspaceId, input.workspace),
      eq(automationRuns.status, 'failed'),
      input.workspace.workspaceType === 'personal'
        ? or(eq(automationRuns.actorUserId, input.userId), eq(automationJobs.ownerUserId, input.userId))
        : undefined,
    )).orderBy(desc(automationRuns.finishedAt), desc(automationRuns.createdAt)).limit(MAX_SOURCE_ITEMS),
  ]);

  const items: MobileInboxItem[] = [];
  for (const row of sessionRows) {
    if (!row.lastMessageAt || !hasUnreadAssistantResponse(row.lastMessageAt, row.lastViewedAt)) continue;
    items.push({
      id: `chat:${row.sessionId}`,
      type: 'chat.response',
      title: row.title?.trim() || DEFAULT_SESSION_TITLE,
      detail: 'Agent response ready',
      occurredAt: row.lastMessageAt.toISOString(),
      unread: true,
      priority: 'normal',
      target: { kind: 'chat', sessionId: row.sessionId },
    });
  }
  for (const todo of todos) {
    const isDue = todo.status === 'open' && Boolean(todo.dueAt && todo.dueAt <= endOfToday);
    const itemKey = `todo:${todo.id}`;
    const unread = input.workspace.workspaceType === 'personal'
      ? !todo.seenAt
      : genericUnread(itemKey, todo.updatedAt, state);
    if (todo.status !== 'open' || (!unread && !isDue)) continue;
    items.push({
      id: itemKey,
      type: 'todo.attention',
      title: todo.title,
      detail: todo.category?.name || (isDue ? 'Due today' : 'To-do'),
      occurredAt: todo.updatedAt.toISOString(),
      unread,
      priority: todo.priority === 'high' || isDue ? 'high' : 'normal',
      target: { kind: 'todo', todoId: todo.id },
    });
  }
  for (const row of generationRows) {
    const key = `studio:${row.id}`;
    items.push({
      id: key,
      type: row.status === 'failed' ? 'studio.failed' : 'studio.completed',
      title: row.presetName?.trim() || `${row.mode} generation`,
      detail: row.status === 'failed' ? 'Studio generation needs review' : 'Studio output ready',
      occurredAt: row.updatedAt.toISOString(),
      unread: genericUnread(key, row.updatedAt, state),
      priority: row.status === 'failed' ? 'high' : 'normal',
      target: { kind: 'studio', generationId: row.id },
    });
  }
  for (const row of automationRows) {
    const occurredAt = row.occurredAt || row.createdAt;
    const key = `automation:${row.runId}`;
    items.push({
      id: key,
      type: 'automation.failed',
      title: row.jobName,
      detail: row.errorMessage?.trim().slice(0, 240) || 'Automation run failed',
      occurredAt: occurredAt.toISOString(),
      unread: genericUnread(key, occurredAt, state),
      priority: 'high',
      target: { kind: 'automation', runId: row.runId },
    });
  }
  return items.sort((left, right) => (
    right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
  ));
}

function matchesFilter(item: MobileInboxItem, filter: MobileInboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unread') return item.unread;
  if (filter === 'chat') return item.target.kind === 'chat';
  if (filter === 'todos') return item.target.kind === 'todo';
  if (filter === 'studio') return item.target.kind === 'studio';
  return item.target.kind === 'automation';
}

export async function listMobileInbox(input: {
  userId: string;
  workspace: WorkspaceContext;
  filter?: string | null;
  cursor?: string | null;
  limit?: number;
}) {
  const filter = MOBILE_INBOX_FILTERS.includes(input.filter as MobileInboxFilter)
    ? input.filter as MobileInboxFilter
    : 'all';
  const limit = normalizeLimit(input.limit);
  const cursor = decodeCursor(input.cursor, input.workspace.workspaceId, filter);
  const allItems = await collectInboxItems(input);
  const counts = {
    unread: allItems.filter((item) => item.unread).length,
    chat: allItems.filter((item) => item.target.kind === 'chat').length,
    todos: allItems.filter((item) => item.target.kind === 'todo').length,
    studio: allItems.filter((item) => item.target.kind === 'studio').length,
    automation: allItems.filter((item) => item.target.kind === 'automation').length,
  };
  let filtered = allItems.filter((item) => matchesFilter(item, filter));
  if (cursor) {
    filtered = filtered.filter((item) => (
      item.occurredAt < cursor.occurredAt || (item.occurredAt === cursor.occurredAt && item.id < cursor.id)
    ));
  }
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  return {
    counts,
    items: page,
    nextCursor: filtered.length > limit && last
      ? encodeCursor({ workspaceId: input.workspace.workspaceId, filter, occurredAt: last.occurredAt, id: last.id })
      : null,
  };
}

export async function countMobileUnreadMessages(userId: string): Promise<number> {
  const [result] = await db.select({ count: countRows() })
    .from(piSessions)
    .where(and(
      eq(piSessions.userId, userId),
      isNotNull(piSessions.lastMessageAt),
      or(
        isNull(piSessions.lastViewedAt),
        gt(piSessions.lastMessageAt, piSessions.lastViewedAt),
      ),
    ));
  return result?.count ?? 0;
}

async function upsertReadState(userId: string, workspaceId: string, itemKey: string, readAt: Date) {
  await db.insert(mobileInboxReadStates).values({
    userId,
    workspaceId,
    itemKey,
    readAt,
    createdAt: readAt,
    updatedAt: readAt,
  }).onConflictDoUpdate({
    target: [mobileInboxReadStates.userId, mobileInboxReadStates.workspaceId, mobileInboxReadStates.itemKey],
    set: { readAt, updatedAt: readAt },
  });
}

export async function markMobileInboxRead(input: {
  userId: string;
  workspace: WorkspaceContext;
  action: unknown;
  itemId?: unknown;
}) {
  const now = new Date();
  if (input.action === 'mark_all_read') {
    await Promise.all([
      db.update(piSessions).set({ lastViewedAt: piSessionReadCursorSql(), updatedAt: now }).where(and(
        eq(piSessions.userId, input.userId),
        workspaceCondition(piSessions.workspaceId, input.workspace),
        isNotNull(piSessions.lastMessageAt),
      )),
      db.update(todoItems).set({ seenAt: now, updatedAt: now }).where(and(
        eq(todoItems.userId, input.userId),
        eq(todoItems.workspaceType, 'personal'),
        eq(todoItems.status, 'open'),
        isNull(todoItems.seenAt),
      )),
      upsertReadState(input.userId, input.workspace.workspaceId, BASELINE_KEY, now),
    ]);
    return { readAt: now.toISOString() };
  }
  if (input.action !== 'mark_item_read' || typeof input.itemId !== 'string') {
    throw new MobileInboxError('INVALID_ACTION', 'The Inbox read action is invalid.', 400);
  }
  const [kind, entityId] = input.itemId.split(':', 2);
  if (!entityId) throw new MobileInboxError('INVALID_ITEM', 'The Inbox item is invalid.', 400);
  if (kind === 'chat') {
    const result = await db.update(piSessions).set({ lastViewedAt: piSessionReadCursorSql(), updatedAt: now }).where(and(
      eq(piSessions.userId, input.userId),
      eq(piSessions.sessionId, entityId),
      workspaceCondition(piSessions.workspaceId, input.workspace),
    )).returning({ id: piSessions.id });
    if (!result.length) throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
  } else if (kind === 'todo') {
    const todo = await getTodo(input.userId, entityId);
    if (!todoBelongsToWorkspace(todo, input.workspace)) {
      throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
    }
    if (input.workspace.workspaceType === 'personal') {
      await markTodoSeen(input.userId, entityId, now);
    } else {
      await upsertReadState(input.userId, input.workspace.workspaceId, input.itemId, now);
    }
  } else if (kind === 'studio' || kind === 'automation') {
    const items = await collectInboxItems(input);
    if (!items.some((item) => item.id === input.itemId)) {
      throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
    }
    await upsertReadState(input.userId, input.workspace.workspaceId, input.itemId, now);
  } else {
    throw new MobileInboxError('INVALID_ITEM', 'The Inbox item is invalid.', 400);
  }
  return { itemId: input.itemId, readAt: now.toISOString() };
}
