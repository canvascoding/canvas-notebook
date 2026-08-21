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

export const MOBILE_INBOX_FILTERS = ['all', 'unread', 'chat', 'todos', 'studio', 'automation'] as const;
export type MobileInboxFilter = typeof MOBILE_INBOX_FILTERS[number];

export type MobileInboxItem = {
  id: string;
  type: 'chat.response' | 'todo.attention' | 'studio.completed' | 'studio.failed' | 'automation.failed';
  title: string;
  detail: string | null;
  previewUrl: string | null;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  target:
    | { kind: 'chat'; sessionId: string }
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

type CollectedInboxItem = MobileInboxItem & {
  todoPresentationCandidate?: TodoPresentationCandidate;
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
  occurredAt: string;
  id: string;
};

type AggregateInboxCursor = {
  scopeKey: string;
  filter: MobileInboxFilter;
  groupWorkspaceTodos: boolean;
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
    scopeKind: 'all' as const,
  };
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

function publicInboxItem(item: CollectedInboxItem): MobileInboxItem {
  const { todoPresentationCandidate: _candidate, ...publicItem } = item;
  return publicItem;
}

function publicAggregateInboxItem(item: GroupableAggregateInboxItem): MobileAggregateInboxItem {
  const {
    todoPresentationCandidate: _candidate,
    todoPresentationGroupId: _groupId,
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

async function collectInboxItems(input: { userId: string; workspace: WorkspaceContext }) {
  const state = await readState({ userId: input.userId, workspaceId: input.workspace.workspaceId });
  const [sessionRows, todos, generationRows, automationRows] = await Promise.all([
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
      target: { kind: 'todo', todoId: todo.id },
      todoPresentationCandidate: todoPresentationCandidate(todo),
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
    .sort((left, right) => (
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
    items: page.map(publicInboxItem),
    nextCursor: filtered.length > limit && last
      ? encodeCursor({ workspaceId: input.workspace.workspaceId, filter, occurredAt: last.occurredAt, id: last.id })
      : null,
  };
}

async function collectAggregateInboxItems(input: {
  userId: string;
  workspaces: WorkspaceContext[];
}): Promise<CollectedAggregateInboxItem[]> {
  const items: CollectedAggregateInboxItem[] = [];
  const concurrency = 4;
  for (let index = 0; index < input.workspaces.length; index += concurrency) {
    const batch = input.workspaces.slice(index, index + concurrency);
    const batchItems = await Promise.all(batch.map(async (workspace) => {
      const workspaceItems = await collectInboxItems({ userId: input.userId, workspace });
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
  left: Pick<MobileAggregateInboxItem, 'id' | 'occurredAt' | 'workspaceId'>,
  right: Pick<MobileAggregateInboxItem, 'id' | 'occurredAt' | 'workspaceId'>,
): number {
  return right.occurredAt.localeCompare(left.occurredAt)
    || right.workspaceId.localeCompare(left.workspaceId)
    || right.id.localeCompare(left.id);
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
): MobileAggregateInboxEntry[] {
  const groupItems = new Map<string, GroupableAggregateInboxItem[]>();
  const entries: MobileAggregateInboxEntry[] = [];
  for (const item of items) {
    if (!item.todoPresentationGroupId) {
      entries.push(publicAggregateInboxItem(item));
      continue;
    }
    const members = groupItems.get(item.todoPresentationGroupId) || [];
    members.push(item);
    groupItems.set(item.todoPresentationGroupId, members);
  }
  for (const [groupId, members] of groupItems) {
    if (members.length < 2) {
      entries.push(...members.map(publicAggregateInboxItem));
      continue;
    }
    members.sort(compareAggregateInboxItems);
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
  return entries.sort(compareAggregateInboxItems);
}

export function groupMobileAggregateInboxItemsForPresentation(
  items: CollectedAggregateInboxItem[],
): MobileAggregateInboxEntry[] {
  return createTodoPresentationEntries(assignTodoPresentationGroups(items));
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
  const allItems = assignTodoPresentationGroups(await collectAggregateInboxItems(input));
  const counts = {
    unread: allItems.filter((item) => item.unread).length,
    chat: allItems.filter((item) => item.target.kind === 'chat').length,
    todos: allItems.filter((item) => item.target.kind === 'todo').length,
    studio: allItems.filter((item) => item.target.kind === 'studio').length,
    automation: allItems.filter((item) => item.target.kind === 'automation').length,
  };
  const filteredItems = allItems.filter((item) => matchesFilter(item, filter));
  let filtered: MobileAggregateInboxEntry[] = groupWorkspaceTodos
    ? createTodoPresentationEntries(filteredItems)
    : filteredItems.map(publicAggregateInboxItem);
  if (cursor) {
    filtered = filtered.filter((item) => (
      item.occurredAt < cursor.occurredAt
      || (
        item.occurredAt === cursor.occurredAt
        && (
          item.workspaceId < cursor.workspaceId
          || (item.workspaceId === cursor.workspaceId && item.id < cursor.id)
        )
      )
    ));
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
}) {
  let readAt = new Date().toISOString();
  for (const workspace of input.workspaces) {
    const result = await markMobileInboxRead({
      userId: input.userId,
      workspace,
      action: 'mark_all_read',
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
  itemId?: unknown;
  read?: unknown;
}) {
  const now = new Date();
  if (input.action === 'mark_all_read') {
    const todos = await listTodos(input.userId, {
      ...todoWorkspaceOptions(input.workspace),
      status: 'active',
      limit: MAX_SOURCE_ITEMS,
    });
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
    const items = await collectInboxItems(input);
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
    const items = await collectInboxItems(input);
    if (!items.some((item) => item.id === input.itemId)) {
      throw new MobileInboxError('ITEM_NOT_FOUND', 'The Inbox item was not found.', 404);
    }
    await upsertReadState(input.userId, input.workspace.workspaceId, input.itemId, now);
  } else {
    throw new MobileInboxError('INVALID_ITEM', 'The Inbox item is invalid.', 400);
  }
  return requestedRead
    ? { itemId: input.itemId, readAt: now.toISOString() }
    : { itemId: input.itemId, read: false };
}
