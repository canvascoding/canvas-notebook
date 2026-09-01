import 'server-only';

import { createHash } from 'node:crypto';

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';

import { piSessionReadCursorSql } from '@/app/lib/chat/read-cursor';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { db } from '@/app/lib/db';
import { listEmailAttention } from '@/app/lib/email/inbox-attention';
import {
  automationJobs,
  automationRuns,
  mobileInboxReadStates,
  piSessions,
  studioGenerationOutputs,
  studioGenerations,
} from '@/app/lib/db/schema';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { setTodoReadStateForUser } from '@/app/lib/todos/read-state-actions';
import { getTodo, listTodos, type TodoWithRelations } from '@/app/lib/todos/store';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const BASELINE_KEY = '__baseline__';
const MAX_SOURCE_ITEMS = 200;
const INITIAL_UNREAD_WINDOW_MS = 24 * 60 * 60 * 1_000;
const TODO_PRESENTATION_GROUP_WINDOW_MS = 5 * 60 * 1_000;

export const MOBILE_INBOX_FILTERS = ['all', 'unread', 'notifications', 'chat', 'emails', 'todos', 'studio', 'automation'] as const;
export type MobileInboxFilter = typeof MOBILE_INBOX_FILTERS[number];

export type MobileInboxItem = {
  id: string;
  type: 'chat.response' | 'email.attention' | 'todo.attention' | 'studio.completed' | 'studio.failed' | 'automation.failed';
  title: string;
  detail: string | null;
  previewUrl: string | null;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  todoStatus?: 'open' | 'done' | 'archived';
  attentionRequired?: true;
  target:
    | { kind: 'chat'; sessionId: string }
    | { kind: 'email'; scope: 'personal' | 'workspace'; caseId?: string; draftId?: string }
    | { kind: 'todo'; todoId: string }
    | { kind: 'studio'; generationId: string }
    | { kind: 'automation'; runId: string };
};

export type MobileAggregateInboxItem = MobileInboxItem & {
  workspaceId: string;
};

export type MobileAggregateInboxEntry = MobileAggregateInboxItem & {
  todoGroup?: {
    id: string;
    items: MobileAggregateInboxItem[];
    workspaceCount: number;
  };
};

type TodoPresentationCandidate = {
  createdAt: string;
  fingerprint: string;
};

type TodoSortKey = {
  lifecycleRank: number;
  priorityRank: number;
  dueRank: number;
  dueAt: string | null;
  createdAt: string;
  id: string;
};

type CollectedInboxItem = MobileInboxItem & {
  todoPresentationCandidate?: TodoPresentationCandidate;
  todoSortKey?: TodoSortKey;
};

type CollectedAggregateInboxItem = CollectedInboxItem & {
  workspaceId: string;
};

type GroupableAggregateInboxItem = CollectedAggregateInboxItem & {
  todoPresentationGroupId?: string;
};

type InboxCursor = {
  workspaceId: string;
  filter: MobileInboxFilter;
  sortAsOf: string;
  occurredAt: string;
  id: string;
};

type AggregateInboxCursor = {
  scopeKey: string;
  filter: MobileInboxFilter;
  groupWorkspaceTodos: boolean;
  sortAsOf: string;
  occurredAt: string;
  workspaceId: string;
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
  if (workspace.legacy) {
    return { workspaceType: 'personal' as const, scopeKind: 'user' as const };
  }
  if (workspace.workspaceType === 'organization' || workspace.workspaceType === 'team' || workspace.workspaceType === 'project') {
    return {
      workspaceType: workspace.workspaceType,
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      scopeKind: 'workspace',
    } as const;
  }
  return {
    workspaceType: 'personal' as const,
    workspaceId: workspace.workspaceId,
    scopeKind: 'workspace' as const,
  };
}

async function listInboxTodos(input: { userId: string; workspace: WorkspaceContext }) {
  const workspaceTodos = await listTodos(input.userId, {
    ...todoWorkspaceOptions(input.workspace),
    status: 'open',
    limit: MAX_SOURCE_ITEMS,
  });
  // User-scoped personal To-dos have no concrete workspace. Attach them
  // exactly once to the default personal Inbox source so aggregate views
  // neither omit them nor duplicate them across personal workspaces.
  if (
    input.workspace.workspaceType !== 'personal'
    || input.workspace.legacy
    || !input.workspace.isDefault
  ) return workspaceTodos;
  const personalTodos = await listTodos(input.userId, {
    workspaceType: 'personal',
    scopeKind: 'user',
    status: 'open',
    limit: MAX_SOURCE_ITEMS,
  });
  return Array.from(new Map([...workspaceTodos, ...personalTodos].map((todo) => [todo.id, todo])).values());
}

function todoBelongsToWorkspace(todo: Awaited<ReturnType<typeof getTodo>>, workspace: WorkspaceContext): boolean {
  if (!todo) return false;
  if (workspace.workspaceType === 'personal') {
    return todo.workspaceType === 'personal'
      && (todo.scopeKind === 'user' || todo.workspaceId === workspace.workspaceId);
  }
  return todo.workspaceType === workspace.workspaceType && todo.workspaceId === workspace.workspaceId;
}

function normalizeTodoPresentationText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US') || '';
}

function todoPresentationCandidate(todo: TodoWithRelations): TodoPresentationCandidate | undefined {
  if (todo.scopeKind !== 'workspace') return undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify({
    assigneeUserId: todo.assigneeUserId || null,
    category: normalizeTodoPresentationText(todo.category?.name),
    description: normalizeTodoPresentationText(todo.description),
    dueAt: todo.dueAt?.toISOString() || null,
    priority: todo.priority,
    sourceType: todo.sourceType,
    title: normalizeTodoPresentationText(todo.title),
  })).digest('hex').slice(0, 24);
  return { createdAt: todo.createdAt.toISOString(), fingerprint };
}

function todoSortKey(todo: TodoWithRelations, sortAsOf: Date): TodoSortKey {
  const dueAt = todo.dueAt?.toISOString() || null;
  const dueTimestamp = todo.dueAt?.getTime() ?? null;
  const startOfTomorrow = new Date(sortAsOf);
  startOfTomorrow.setHours(24, 0, 0, 0);
  return {
    lifecycleRank: todo.status === 'open' ? 0 : todo.status === 'done' ? 1 : 2,
    priorityRank: todo.priority === 'high' ? 0 : todo.priority === 'normal' ? 1 : 2,
    dueRank: todo.status !== 'open'
      ? 4
      : dueTimestamp === null
        ? 3
        : dueTimestamp < sortAsOf.getTime()
          ? 0
          : dueTimestamp < startOfTomorrow.getTime()
            ? 1
            : 2,
    dueAt,
    createdAt: todo.createdAt.toISOString(),
    id: todo.id,
  };
}

function compareTodoSortKeys(left: TodoSortKey, right: TodoSortKey): number {
  return left.lifecycleRank - right.lifecycleRank
    || left.priorityRank - right.priorityRank
    || left.dueRank - right.dueRank
    || (left.dueAt || '\uffff').localeCompare(right.dueAt || '\uffff')
    || right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id);
}

function compareInboxItemRecency(
  left: Pick<MobileInboxItem, 'id' | 'occurredAt'>,
  right: Pick<MobileInboxItem, 'id' | 'occurredAt'>,
): number {
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);
}

function compareCollectedInboxItems(left: CollectedInboxItem, right: CollectedInboxItem): number {
  return compareInboxItemRecency(left, right);
}

function compareCollectedTodoItems(left: CollectedInboxItem, right: CollectedInboxItem): number {
  if (left.target.kind === 'todo' && right.target.kind === 'todo' && left.todoSortKey && right.todoSortKey) {
    return compareTodoSortKeys(left.todoSortKey, right.todoSortKey);
  }
  return compareInboxItemRecency(left, right);
}

function publicInboxItem(item: CollectedInboxItem): MobileInboxItem {
  const { todoPresentationCandidate: _candidate, todoSortKey: _sortKey, ...publicItem } = item;
  return publicItem;
}

function publicAggregateInboxItem(item: GroupableAggregateInboxItem): MobileAggregateInboxItem {
  const {
    todoPresentationCandidate: _candidate,
    todoPresentationGroupId: _groupId,
    todoSortKey: _sortKey,
    ...publicItem
  } = item;
  return publicItem;
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
      || typeof parsed.sortAsOf !== 'string'
      || Number.isNaN(new Date(parsed.sortAsOf).getTime())
      || typeof parsed.id !== 'string'
      || typeof parsed.occurredAt !== 'string'
      || Number.isNaN(new Date(parsed.occurredAt).getTime())
    ) throw new Error('Invalid cursor');
    return parsed as InboxCursor;
  } catch {
    throw new MobileInboxError('INVALID_CURSOR', 'The Inbox cursor is invalid for this view.', 400);
  }
}

function aggregateScopeKey(workspaces: WorkspaceContext[]): string {
  return createHash('sha256')
    .update(workspaces.map((workspace) => workspace.workspaceId).sort().join('\n'))
    .digest('hex')
    .slice(0, 24);
}

function encodeAggregateCursor(value: AggregateInboxCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeAggregateCursor(
  value: string | null | undefined,
  scopeKey: string,
  filter: MobileInboxFilter,
  groupWorkspaceTodos: boolean,
): AggregateInboxCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<AggregateInboxCursor>;
    if (
      parsed.scopeKey !== scopeKey
      || parsed.filter !== filter
      || parsed.groupWorkspaceTodos !== groupWorkspaceTodos
      || typeof parsed.sortAsOf !== 'string'
      || Number.isNaN(new Date(parsed.sortAsOf).getTime())
      || typeof parsed.workspaceId !== 'string'
      || typeof parsed.id !== 'string'
      || typeof parsed.occurredAt !== 'string'
      || Number.isNaN(new Date(parsed.occurredAt).getTime())
    ) throw new Error('Invalid cursor');
    return parsed as AggregateInboxCursor;
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
  const rows = await db.select({
    itemKey: mobileInboxReadStates.itemKey,
    readAt: mobileInboxReadStates.readAt,
    dismissedAt: mobileInboxReadStates.dismissedAt,
  })
    .from(mobileInboxReadStates)
    .where(and(
      eq(mobileInboxReadStates.userId, input.userId),
      eq(mobileInboxReadStates.workspaceId, input.workspaceId),
    ));
  return {
    baseline: rows.find((row) => row.itemKey === BASELINE_KEY)?.readAt || baseline,
    dismissedItemKeys: new Set(rows.filter((row) => row.dismissedAt).map((row) => row.itemKey)),
    itemKeys: new Set(rows.map((row) => row.itemKey)),
  };
}

function genericUnread(itemKey: string, occurredAt: Date, state: Awaited<ReturnType<typeof readState>>): boolean {
  return occurredAt > state.baseline && !state.itemKeys.has(itemKey);
}

async function collectInboxItems(input: { userId: string; workspace: WorkspaceContext; sortAsOf: Date }) {
  const state = await readState({ userId: input.userId, workspaceId: input.workspace.workspaceId });
  const [sessionRows, todos, generationRows, automationRows, emailItems] = await Promise.all([
    db.select({
      sessionId: piSessions.sessionId,
      title: piSessions.title,
      lastMessageAt: piSessions.lastMessageAt,
      lastViewedAt: piSessions.lastViewedAt,
    }).from(piSessions).where(and(
      eq(piSessions.userId, input.userId),
      eq(piSessions.sessionKind, 'conversation'),
      workspaceCondition(piSessions.workspaceId, input.workspace),
    )).orderBy(desc(piSessions.lastMessageAt), desc(piSessions.id)).limit(MAX_SOURCE_ITEMS),
    listInboxTodos({ userId: input.userId, workspace: input.workspace }),
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
    listEmailAttention({ userId: input.userId, workspace: input.workspace }),
  ]);

  const imageGenerationIds = generationRows
    .filter((row) => row.mode === 'image')
    .map((row) => row.id);
  const previewOutputRows = imageGenerationIds.length > 0
    ? await db.select({
      generationId: studioGenerationOutputs.generationId,
      outputId: studioGenerationOutputs.id,
    }).from(studioGenerationOutputs).where(and(
      inArray(studioGenerationOutputs.generationId, imageGenerationIds),
      or(
        eq(studioGenerationOutputs.type, 'image'),
        like(studioGenerationOutputs.mimeType, 'image/%'),
      ),
    )).orderBy(
      asc(studioGenerationOutputs.variationIndex),
      asc(studioGenerationOutputs.createdAt),
      asc(studioGenerationOutputs.id),
    )
    : [];
  const previewOutputByGeneration = new Map<string, string>();
  for (const output of previewOutputRows) {
    if (!previewOutputByGeneration.has(output.generationId)) {
      previewOutputByGeneration.set(output.generationId, output.outputId);
    }
  }

  const items: CollectedInboxItem[] = [];
  for (const row of sessionRows) {
    const unread = Boolean(
      row.lastMessageAt
      && hasUnreadAssistantResponse(row.lastMessageAt, row.lastViewedAt),
    );
    if (!row.lastMessageAt || !unread) continue;
    items.push({
      id: `chat:${row.sessionId}`,
      type: 'chat.response',
      title: row.title?.trim() || DEFAULT_SESSION_TITLE,
      detail: 'Agent response ready',
      previewUrl: null,
      occurredAt: row.lastMessageAt.toISOString(),
      unread: true,
      priority: 'normal',
      target: { kind: 'chat', sessionId: row.sessionId },
    });
  }
  for (const email of emailItems) {
    items.push({
      id: email.id,
      type: email.type,
      title: email.title,
      detail: email.detail,
      previewUrl: null,
      occurredAt: email.occurredAt,
      // E-mail attention is derived from its case/draft lifecycle. It remains
      // visible until resolved, rather than being hidden by generic Inbox reads.
      unread: false,
      priority: email.priority,
      attentionRequired: email.attentionRequired,
      target: email.target,
    });
  }
  for (const todo of todos) {
    const itemKey = `todo:${todo.id}`;
    const unread = todo.readState === 'unread';
    items.push({
      id: itemKey,
      type: 'todo.attention',
      title: todo.title,
      detail: todo.category?.name || (todo.status === 'done' ? 'Completed To-do' : 'To-do'),
      previewUrl: null,
      occurredAt: todo.updatedAt.toISOString(),
      unread,
      priority: todo.priority === 'high' ? 'high' : 'normal',
      todoStatus: todo.status as 'open' | 'done' | 'archived',
      target: { kind: 'todo', todoId: todo.id },
      todoPresentationCandidate: todoPresentationCandidate(todo),
      todoSortKey: todoSortKey(todo, input.sortAsOf),
    });
  }
  for (const row of generationRows) {
    const key = `studio:${row.id}`;
    const previewOutputId = row.mode === 'image'
      ? previewOutputByGeneration.get(row.id)
      : undefined;
    items.push({
      id: key,
      type: row.status === 'failed' ? 'studio.failed' : 'studio.completed',
      title: row.presetName?.trim() || `${row.mode} generation`,
      detail: row.status === 'failed' ? 'Studio generation needs review' : 'Studio output ready',
      previewUrl: previewOutputId
        ? `/api/mobile/v1/studio/outputs/${encodeURIComponent(previewOutputId)}/preview`
        : null,
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
      previewUrl: null,
      occurredAt: occurredAt.toISOString(),
      unread: genericUnread(key, occurredAt, state),
      priority: 'high',
      target: { kind: 'automation', runId: row.runId },
    });
  }
  return items
    .filter((item) => !state.dismissedItemKeys.has(item.id))
    .sort(compareCollectedInboxItems);
}

function matchesFilter(item: MobileInboxItem, filter: MobileInboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unread') return item.unread;
  if (filter === 'notifications') return item.target.kind !== 'todo' && item.target.kind !== 'email';
  if (filter === 'chat') return item.target.kind === 'chat';
  if (filter === 'emails') return item.target.kind === 'email';
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
  const sortAsOf = cursor ? new Date(cursor.sortAsOf) : new Date();
  const allItems = await collectInboxItems({ ...input, sortAsOf });
  const counts = {
    unread: allItems.filter((item) => item.unread).length,
    chat: allItems.filter((item) => item.target.kind === 'chat').length,
    emails: allItems.filter((item) => item.target.kind === 'email').length,
    todos: allItems.filter((item) => item.target.kind === 'todo').length,
    todoUnread: allItems.filter((item) => item.target.kind === 'todo' && item.unread).length,
    studio: allItems.filter((item) => item.target.kind === 'studio').length,
    automation: allItems.filter((item) => item.target.kind === 'automation').length,
  };
  let filtered = allItems.filter((item) => matchesFilter(item, filter));
  if (filter === 'todos') filtered.sort(compareCollectedTodoItems);
  if (cursor) {
    const cursorIndex = filtered.findIndex((item) => (
      item.occurredAt === cursor.occurredAt && item.id === cursor.id
    ));
    if (cursorIndex < 0) {
      throw new MobileInboxError('STALE_CURSOR', 'The Inbox changed. Refresh and retry.', 409);
    }
    filtered = filtered.slice(cursorIndex + 1);
  }
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  return {
    counts,
    items: page.map(publicInboxItem),
    nextCursor: filtered.length > limit && last
      ? encodeCursor({ workspaceId: input.workspace.workspaceId, filter, sortAsOf: sortAsOf.toISOString(), occurredAt: last.occurredAt, id: last.id })
      : null,
  };
}

async function collectAggregateInboxItems(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  sortAsOf: Date;
}): Promise<CollectedAggregateInboxItem[]> {
  const items: CollectedAggregateInboxItem[] = [];
  const concurrency = 4;
  for (let index = 0; index < input.workspaces.length; index += concurrency) {
    const batch = input.workspaces.slice(index, index + concurrency);
    const batchItems = await Promise.all(batch.map(async (workspace) => {
      const workspaceItems = await collectInboxItems({ userId: input.userId, workspace, sortAsOf: input.sortAsOf });
      return workspaceItems.map((item) => ({ ...item, workspaceId: workspace.workspaceId }));
    }));
    items.push(...batchItems.flat());
  }
  const seenTodoIds = new Set<string>();
  return items.filter((item) => {
    if (item.target.kind !== 'todo') return true;
    if (seenTodoIds.has(item.target.todoId)) return false;
    seenTodoIds.add(item.target.todoId);
    return true;
  }).sort((left, right) => (
    compareAggregateInboxItems(left, right)
  ));
}

function compareAggregateInboxItems(
  left: Pick<MobileAggregateInboxItem, 'id' | 'occurredAt' | 'workspaceId' | 'target'> & { todoSortKey?: TodoSortKey },
  right: Pick<MobileAggregateInboxItem, 'id' | 'occurredAt' | 'workspaceId' | 'target'> & { todoSortKey?: TodoSortKey },
): number {
  return right.occurredAt.localeCompare(left.occurredAt)
    || right.workspaceId.localeCompare(left.workspaceId)
    || right.id.localeCompare(left.id);
}

function compareAggregateTodoItems(
  left: Pick<MobileAggregateInboxItem, 'id' | 'occurredAt' | 'workspaceId' | 'target'> & { todoSortKey?: TodoSortKey },
  right: Pick<MobileAggregateInboxItem, 'id' | 'occurredAt' | 'workspaceId' | 'target'> & { todoSortKey?: TodoSortKey },
): number {
  if (left.target.kind === 'todo' && right.target.kind === 'todo' && left.todoSortKey && right.todoSortKey) {
    return compareTodoSortKeys(left.todoSortKey, right.todoSortKey);
  }
  return compareAggregateInboxItems(left, right);
}

function assignTodoPresentationGroups(
  items: CollectedAggregateInboxItem[],
): GroupableAggregateInboxItem[] {
  const groupedItems: GroupableAggregateInboxItem[] = items.map((item) => ({ ...item }));
  const candidatesByFingerprint = new Map<string, GroupableAggregateInboxItem[]>();
  for (const item of groupedItems) {
    const candidate = item.todoPresentationCandidate;
    if (item.target.kind !== 'todo' || !candidate) continue;
    const candidates = candidatesByFingerprint.get(candidate.fingerprint) || [];
    candidates.push(item);
    candidatesByFingerprint.set(candidate.fingerprint, candidates);
  }

  const commitCluster = (cluster: GroupableAggregateInboxItem[]) => {
    if (cluster.length < 2 || new Set(cluster.map((item) => item.workspaceId)).size !== cluster.length) return;
    const groupId = createHash('sha256').update([
      cluster[0]?.todoPresentationCandidate?.fingerprint || '',
      ...cluster.map((item) => item.target.kind === 'todo' ? item.target.todoId : item.id).sort(),
    ].join('\n')).digest('hex').slice(0, 24);
    for (const item of cluster) item.todoPresentationGroupId = groupId;
  };

  for (const candidates of candidatesByFingerprint.values()) {
    candidates.sort((left, right) => (
      String(left.todoPresentationCandidate?.createdAt).localeCompare(String(right.todoPresentationCandidate?.createdAt))
      || left.id.localeCompare(right.id)
    ));
    let cluster: GroupableAggregateInboxItem[] = [];
    let clusterStartedAt = 0;
    for (const candidate of candidates) {
      const createdAt = new Date(candidate.todoPresentationCandidate?.createdAt || '').getTime();
      if (cluster.length > 0 && createdAt - clusterStartedAt > TODO_PRESENTATION_GROUP_WINDOW_MS) {
        commitCluster(cluster);
        cluster = [];
      }
      if (cluster.length === 0) clusterStartedAt = createdAt;
      cluster.push(candidate);
    }
    commitCluster(cluster);
  }
  return groupedItems;
}

function createTodoPresentationEntries(
  items: GroupableAggregateInboxItem[],
  compareItems = compareAggregateInboxItems,
): MobileAggregateInboxEntry[] {
  const sortedItems = [...items].sort(compareItems);
  const groupItems = new Map<string, GroupableAggregateInboxItem[]>();
  for (const item of sortedItems) {
    if (!item.todoPresentationGroupId) continue;
    const members = groupItems.get(item.todoPresentationGroupId) || [];
    members.push(item);
    groupItems.set(item.todoPresentationGroupId, members);
  }

  const emittedGroupIds = new Set<string>();
  const entries: MobileAggregateInboxEntry[] = [];
  for (const item of sortedItems) {
    const groupId = item.todoPresentationGroupId;
    if (!groupId) {
      entries.push(publicAggregateInboxItem(item));
      continue;
    }
    if (emittedGroupIds.has(groupId)) continue;
    emittedGroupIds.add(groupId);
    const members = groupItems.get(groupId) || [];
    if (members.length < 2) {
      entries.push(...members.map(publicAggregateInboxItem));
      continue;
    }
    const representative = publicAggregateInboxItem(members[0]!);
    entries.push({
      ...representative,
      id: `todo-group:${groupId}`,
      priority: members.some((item) => item.priority === 'high') ? 'high' : 'normal',
      todoGroup: {
        id: groupId,
        items: members.map(publicAggregateInboxItem),
        workspaceCount: new Set(members.map((item) => item.workspaceId)).size,
      },
      unread: members.some((item) => item.unread),
    });
  }
  return entries;
}

export function groupMobileAggregateInboxItemsForPresentation(
  items: CollectedAggregateInboxItem[],
): MobileAggregateInboxEntry[] {
  return createTodoPresentationEntries(assignTodoPresentationGroups(items), compareAggregateTodoItems);
}

export async function listMobileAggregateInbox(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  filter?: string | null;
  cursor?: string | null;
  limit?: number;
  groupWorkspaceTodos?: boolean;
}) {
  const filter = MOBILE_INBOX_FILTERS.includes(input.filter as MobileInboxFilter)
    ? input.filter as MobileInboxFilter
    : 'all';
  const limit = normalizeLimit(input.limit);
  const scopeKey = aggregateScopeKey(input.workspaces);
  const groupWorkspaceTodos = input.groupWorkspaceTodos === true;
  const cursor = decodeAggregateCursor(input.cursor, scopeKey, filter, groupWorkspaceTodos);
  const sortAsOf = cursor ? new Date(cursor.sortAsOf) : new Date();
  const allItems = assignTodoPresentationGroups(await collectAggregateInboxItems({ ...input, sortAsOf }));
  const counts = {
    unread: allItems.filter((item) => item.unread).length,
    chat: allItems.filter((item) => item.target.kind === 'chat').length,
    emails: allItems.filter((item) => item.target.kind === 'email').length,
    todos: allItems.filter((item) => item.target.kind === 'todo').length,
    todoUnread: allItems.filter((item) => item.target.kind === 'todo' && item.unread).length,
    studio: allItems.filter((item) => item.target.kind === 'studio').length,
    automation: allItems.filter((item) => item.target.kind === 'automation').length,
  };
  const filteredItems = allItems.filter((item) => matchesFilter(item, filter));
  const compareItems = filter === 'todos' ? compareAggregateTodoItems : compareAggregateInboxItems;
  let filtered: MobileAggregateInboxEntry[] = groupWorkspaceTodos
    ? createTodoPresentationEntries(filteredItems, compareItems)
    : [...filteredItems].sort(compareItems).map(publicAggregateInboxItem);
  if (cursor) {
    const cursorIndex = filtered.findIndex((item) => (
      item.occurredAt === cursor.occurredAt
      && item.workspaceId === cursor.workspaceId
      && item.id === cursor.id
    ));
    if (cursorIndex < 0) {
      throw new MobileInboxError('STALE_CURSOR', 'The Inbox changed. Refresh and retry.', 409);
    }
    filtered = filtered.slice(cursorIndex + 1);
  }
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  return {
    scope: {
      workspaceIds: input.workspaces.map((workspace) => workspace.workspaceId),
      workspaceCount: input.workspaces.length,
    },
    counts,
    items: page,
    nextCursor: filtered.length > limit && last
      ? encodeAggregateCursor({
          scopeKey,
          filter,
          groupWorkspaceTodos,
          sortAsOf: sortAsOf.toISOString(),
          occurredAt: last.occurredAt,
          workspaceId: last.workspaceId,
          id: last.id,
        })
      : null,
  };
}

export async function markMobileAggregateInboxRead(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  category?: 'notifications';
}) {
  let readAt = new Date().toISOString();
  for (const workspace of input.workspaces) {
    const result = await markMobileInboxRead({
      userId: input.userId,
      workspace,
      action: input.category ? 'mark_category_read' : 'mark_all_read',
      ...(input.category ? { category: input.category } : {}),
    });
    if ('readAt' in result && typeof result.readAt === 'string') readAt = result.readAt;
  }
  return {
    readAt,
    workspaceIds: input.workspaces.map((workspace) => workspace.workspaceId),
  };
}

export async function countMobileUnreadMessages(input: {
  userId: string;
  workspaces: WorkspaceContext[];
}): Promise<number> {
  if (!input.workspaces.length) return 0;
  const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  const personalWorkspace = input.workspaces.find((workspace) => workspace.workspaceType === 'personal');
  const rows = await db.select({
    workspaceId: piSessions.workspaceId,
    lastMessageAt: piSessions.lastMessageAt,
    lastViewedAt: piSessions.lastViewedAt,
  }).from(piSessions).where(and(
    eq(piSessions.userId, input.userId),
    eq(piSessions.sessionKind, 'conversation'),
    isNotNull(piSessions.lastMessageAt),
    or(
      isNull(piSessions.lastViewedAt),
      gt(piSessions.lastMessageAt, piSessions.lastViewedAt),
    ),
    or(...input.workspaces.map((workspace) => workspaceCondition(piSessions.workspaceId, workspace))),
  ));
  const sessions = rows.flatMap((row) => {
    const workspace = row.workspaceId
      ? workspaceById.get(row.workspaceId)
      : personalWorkspace;
    return workspace && row.lastMessageAt ? [{ ...row, workspace }] : [];
  });
  return sessions.filter((session) => (
    hasUnreadAssistantResponse(session.lastMessageAt, session.lastViewedAt)
  )).length;
}

/**
 * Counts every unread, badge-eligible notification source. To-dos intentionally
 * stay outside this aggregate: their lifecycle count is displayed on their own
 * tab and must never inflate the global Inbox badge.
 */
export async function countMobileUnreadNotifications(input: {
  userId: string;
  workspaces: WorkspaceContext[];
}): Promise<number> {
  const workspaces = [...new Map(input.workspaces.map((workspace) => [workspace.workspaceId, workspace])).values()];
  const counts = await Promise.all(workspaces.map(async (workspace) => {
    const state = await readState({ userId: input.userId, workspaceId: workspace.workspaceId });
    const [sessionRows, generationRows, automationRows] = await Promise.all([
      db.select({
        lastMessageAt: piSessions.lastMessageAt,
        lastViewedAt: piSessions.lastViewedAt,
      }).from(piSessions).where(and(
        eq(piSessions.userId, input.userId),
        eq(piSessions.sessionKind, 'conversation'),
        workspaceCondition(piSessions.workspaceId, workspace),
        isNotNull(piSessions.lastMessageAt),
        or(
          isNull(piSessions.lastViewedAt),
          gt(piSessions.lastMessageAt, piSessions.lastViewedAt),
        ),
      )),
      db.select({
        id: studioGenerations.id,
        updatedAt: studioGenerations.updatedAt,
      }).from(studioGenerations).where(and(
        workspaceCondition(studioGenerations.workspaceId, workspace),
        inArray(studioGenerations.status, ['completed', 'failed']),
        workspace.workspaceType === 'personal' ? eq(studioGenerations.userId, input.userId) : undefined,
      )),
      db.select({
        runId: automationRuns.id,
        occurredAt: automationRuns.finishedAt,
        createdAt: automationRuns.createdAt,
      }).from(automationRuns).innerJoin(automationJobs, eq(automationJobs.id, automationRuns.jobId)).where(and(
        workspaceCondition(automationRuns.workspaceId, workspace),
        eq(automationRuns.status, 'failed'),
        workspace.workspaceType === 'personal'
          ? or(eq(automationRuns.actorUserId, input.userId), eq(automationJobs.ownerUserId, input.userId))
          : undefined,
      )),
    ]);
    const unreadChats = sessionRows.filter((session) => (
      hasUnreadAssistantResponse(session.lastMessageAt, session.lastViewedAt)
    )).length;
    const unreadGenerations = generationRows.filter((generation) => (
      genericUnread(`studio:${generation.id}`, generation.updatedAt, state)
    )).length;
    const unreadAutomations = automationRows.filter((automation) => {
      const occurredAt = automation.occurredAt || automation.createdAt;
      return genericUnread(`automation:${automation.runId}`, occurredAt, state);
    }).length;
    return unreadChats + unreadGenerations + unreadAutomations;
  }));
  return counts.reduce((total, count) => total + count, 0);
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

async function upsertDismissedState(userId: string, workspaceId: string, itemKey: string, dismissedAt: Date) {
  await db.insert(mobileInboxReadStates).values({
    userId,
    workspaceId,
    itemKey,
    readAt: dismissedAt,
    dismissedAt,
    createdAt: dismissedAt,
    updatedAt: dismissedAt,
  }).onConflictDoUpdate({
    target: [mobileInboxReadStates.userId, mobileInboxReadStates.workspaceId, mobileInboxReadStates.itemKey],
    set: { readAt: dismissedAt, dismissedAt, updatedAt: dismissedAt },
  });
}

export async function markMobileInboxRead(input: {
  userId: string;
  workspace: WorkspaceContext;
  action: unknown;
  category?: unknown;
  itemId?: unknown;
  read?: unknown;
}) {
  const now = new Date();
  const markNotificationsRead = input.action === 'mark_category_read';
  if (input.action === 'mark_all_read' || markNotificationsRead) {
    if (markNotificationsRead && input.category !== 'notifications') {
      throw new MobileInboxError('INVALID_CATEGORY', 'The Inbox category is invalid.', 400);
    }
    const todos = input.action === 'mark_all_read'
      ? await listInboxTodos({ userId: input.userId, workspace: input.workspace })
      : [];
    await Promise.all([
      db.update(piSessions).set({ lastViewedAt: piSessionReadCursorSql(), updatedAt: now }).where(and(
        eq(piSessions.userId, input.userId),
        eq(piSessions.sessionKind, 'conversation'),
        workspaceCondition(piSessions.workspaceId, input.workspace),
        isNotNull(piSessions.lastMessageAt),
      )),
      ...todos
        .filter((todo) => todo.readState === 'unread')
        .map((todo) => setTodoReadStateForUser({
          userId: input.userId,
          todoId: todo.id,
          read: true,
          readAt: now,
        })),
      upsertReadState(input.userId, input.workspace.workspaceId, BASELINE_KEY, now),
    ]);
    return { readAt: now.toISOString() };
  }
  if (input.action === 'dismiss_item') {
    if (typeof input.itemId !== 'string') {
      throw new MobileInboxError('INVALID_ITEM', 'The Inbox item is invalid.', 400);
    }
    const [kind, entityId] = input.itemId.split(':', 2);
    if (!entityId || (kind !== 'studio' && kind !== 'automation')) {
      throw new MobileInboxError('ITEM_NOT_DISMISSIBLE', 'This Inbox item cannot be dismissed.', 400);
    }
    const items = await collectInboxItems({ ...input, sortAsOf: now });
    if (!items.some((item) => item.id === input.itemId)) {
      throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
    }
    await upsertDismissedState(input.userId, input.workspace.workspaceId, input.itemId, now);
    return { itemId: input.itemId, dismissedAt: now.toISOString() };
  }
  const requestedRead = input.action === 'mark_item_read'
    ? true
    : input.action === 'set_item_read_state' && typeof input.read === 'boolean'
      ? input.read
      : null;
  if (requestedRead === null || typeof input.itemId !== 'string') {
    throw new MobileInboxError('INVALID_ACTION', 'The Inbox read action is invalid.', 400);
  }
  const [kind, entityId] = input.itemId.split(':', 2);
  if (!entityId) throw new MobileInboxError('INVALID_ITEM', 'The Inbox item is invalid.', 400);
  if (kind === 'chat') {
    if (!requestedRead) {
      throw new MobileInboxError('ITEM_READ_STATE_NOT_SUPPORTED', 'Chat items can only be marked read.', 400);
    }
    const result = await db.update(piSessions).set({ lastViewedAt: piSessionReadCursorSql(), updatedAt: now }).where(and(
      eq(piSessions.userId, input.userId),
      eq(piSessions.sessionId, entityId),
      eq(piSessions.sessionKind, 'conversation'),
      workspaceCondition(piSessions.workspaceId, input.workspace),
    )).returning({ id: piSessions.id });
    if (!result.length) throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
  } else if (kind === 'todo') {
    const todo = await getTodo(input.userId, entityId);
    if (!todoBelongsToWorkspace(todo, input.workspace)) {
      throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
    }
    await setTodoReadStateForUser({
      userId: input.userId,
      todoId: entityId,
      read: requestedRead,
      readAt: now,
    });
  } else if (kind === 'studio' || kind === 'automation') {
    if (!requestedRead) {
      throw new MobileInboxError('ITEM_READ_STATE_NOT_SUPPORTED', 'Only To-dos can be marked unread.', 400);
    }
    const items = await collectInboxItems({ ...input, sortAsOf: now });
    if (!items.some((item) => item.id === input.itemId)) {
      throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
    }
    await upsertReadState(input.userId, input.workspace.workspaceId, input.itemId, now);
  } else {
    throw new MobileInboxError('INVALID_ITEM', 'The Inbox item is invalid.', 400);
  }
  return requestedRead
    ? { itemId: input.itemId, read: true, readAt: now.toISOString() }
    : { itemId: input.itemId, read: false, readAt: null };
}
