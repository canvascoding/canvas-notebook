import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { todoCategories, todoFileLinks, todoItems } from '@/app/lib/db/schema';
import { validatePath } from '@/app/lib/filesystem/workspace-files';
import {
  DEFAULT_TODO_CATEGORIES,
  DEFAULT_TODO_CATEGORY_NAME,
  getDefaultTodoCategoryKey,
  resolveDefaultTodoCategoryName,
} from './default-categories';

export {
  DEFAULT_TODO_CATEGORIES,
  DEFAULT_TODO_CATEGORY_NAME,
  getDefaultTodoCategoryKey,
} from './default-categories';

export const TODO_STATUSES = ['open', 'done', 'archived'] as const;
export type TodoStatus = typeof TODO_STATUSES[number];

export const TODO_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TodoPriority = typeof TODO_PRIORITIES[number];

export const TODO_SOURCE_TYPES = ['user', 'agent'] as const;
export type TodoSourceType = typeof TODO_SOURCE_TYPES[number];

const TITLE_MAX_LENGTH = 180;
const DESCRIPTION_MAX_LENGTH = 5000;
const CATEGORY_NAME_MAX_LENGTH = 80;
const LABEL_MAX_LENGTH = 120;
const MAX_FILE_LINKS = 20;

export class TodoStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_WORKSPACE_PATH'
      | 'CATEGORY_NOT_FOUND'
      | 'TODO_NOT_FOUND',
  ) {
    super(message);
    this.name = 'TodoStoreError';
  }
}

export type TodoCategory = typeof todoCategories.$inferSelect;
export type TodoItem = typeof todoItems.$inferSelect;
export type TodoFileLink = typeof todoFileLinks.$inferSelect;

export type TodoWithRelations = TodoItem & {
  category: TodoCategory | null;
  fileLinks: TodoFileLink[];
};

export type TodoFileLinkInput = string | {
  workspacePath: string;
  label?: string | null;
};

export type CreateTodoInput = {
  title: string;
  description?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  priority?: TodoPriority | null;
  dueAt?: Date | null;
  sourceType?: TodoSourceType;
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  seenAt?: Date | null;
  fileLinks?: TodoFileLinkInput[];
};

export type UpdateTodoInput = {
  title?: string;
  description?: string | null;
  categoryId?: string | null;
  priority?: TodoPriority;
  dueAt?: Date | null;
  status?: TodoStatus;
  seenAt?: Date | null;
  fileLinks?: TodoFileLinkInput[];
};

export type ListTodosOptions = {
  status?: TodoStatus | 'active' | 'all';
  categoryId?: string | null;
  sourceType?: TodoSourceType;
  due?: 'overdue' | 'today' | 'upcoming';
  limit?: number;
};

function normalizeRequiredText(value: string, fieldName: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new TodoStoreError(`${fieldName} is required`, 'INVALID_INPUT');
  }
  return normalized.slice(0, maxLength);
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeTodoStatus(value: TodoStatus | undefined): TodoStatus {
  if (!value) return 'open';
  if (!TODO_STATUSES.includes(value)) {
    throw new TodoStoreError('Invalid todo status', 'INVALID_INPUT');
  }
  return value;
}

function normalizeTodoPriority(value: TodoPriority | null | undefined): TodoPriority {
  if (!value) return 'normal';
  if (!TODO_PRIORITIES.includes(value)) {
    throw new TodoStoreError('Invalid todo priority', 'INVALID_INPUT');
  }
  return value;
}

function normalizeTodoSourceType(value: TodoSourceType | undefined): TodoSourceType {
  if (!value) return 'user';
  if (!TODO_SOURCE_TYPES.includes(value)) {
    throw new TodoStoreError('Invalid todo source type', 'INVALID_INPUT');
  }
  return value;
}

function normalizeDate(value: Date | null | undefined): Date | null {
  if (!value) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TodoStoreError('Invalid date', 'INVALID_INPUT');
  }
  return value;
}

export function normalizeWorkspaceTodoPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TodoStoreError('Workspace path is required', 'INVALID_WORKSPACE_PATH');
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || path.isAbsolute(trimmed)) {
    throw new TodoStoreError('Workspace path must be relative to the workspace', 'INVALID_WORKSPACE_PATH');
  }

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.') {
    throw new TodoStoreError('Workspace path is required', 'INVALID_WORKSPACE_PATH');
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new TodoStoreError('Workspace path must stay inside the workspace', 'INVALID_WORKSPACE_PATH');
  }

  validatePath(normalized);
  return normalized;
}

function normalizeFileLinks(input: TodoFileLinkInput[] | undefined): Array<{ workspacePath: string; label: string | null }> {
  if (!input?.length) return [];

  const seen = new Set<string>();
  const links: Array<{ workspacePath: string; label: string | null }> = [];

  for (const entry of input.slice(0, MAX_FILE_LINKS)) {
    const workspacePath = normalizeWorkspaceTodoPath(typeof entry === 'string' ? entry : entry.workspacePath);
    if (seen.has(workspacePath)) continue;
    seen.add(workspacePath);
    links.push({
      workspacePath,
      label: typeof entry === 'string' ? null : normalizeOptionalText(entry.label, LABEL_MAX_LENGTH),
    });
  }

  return links;
}

async function ensureCategoriesSeeded(userId: string): Promise<void> {
  const existing = await db
    .select({ id: todoCategories.id })
    .from(todoCategories)
    .where(eq(todoCategories.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    return;
  }

  const now = new Date();
  await db.insert(todoCategories).values(
    DEFAULT_TODO_CATEGORIES.map((category, index) => ({
      id: randomUUID(),
      userId,
      name: category.name,
      color: category.color,
      icon: category.icon,
      sortOrder: index,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

export async function ensureTodoCategories(userId: string): Promise<TodoCategory[]> {
  await ensureCategoriesSeeded(userId);
  return listTodoCategories(userId);
}

export async function listTodoCategories(userId: string, options: { includeArchived?: boolean } = {}): Promise<TodoCategory[]> {
  const conditions = [
    eq(todoCategories.userId, userId),
    ...(options.includeArchived ? [] : [eq(todoCategories.isArchived, false)]),
  ];

  return db
    .select()
    .from(todoCategories)
    .where(and(...conditions))
    .orderBy(asc(todoCategories.sortOrder), asc(todoCategories.name));
}

export async function createTodoCategory(userId: string, input: {
  name: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
}): Promise<TodoCategory> {
  const now = new Date();
  const [created] = await db.insert(todoCategories).values({
    id: randomUUID(),
    userId,
    name: normalizeRequiredText(input.name, 'Category name', CATEGORY_NAME_MAX_LENGTH),
    color: normalizeOptionalText(input.color, 24),
    icon: normalizeOptionalText(input.icon, 48),
    sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return created;
}

export async function updateTodoCategory(userId: string, categoryId: string, input: {
  name?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
}): Promise<TodoCategory | null> {
  const updates: Partial<typeof todoCategories.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) {
    updates.name = normalizeRequiredText(input.name, 'Category name', CATEGORY_NAME_MAX_LENGTH);
  }
  if (input.color !== undefined) {
    updates.color = normalizeOptionalText(input.color, 24);
  }
  if (input.icon !== undefined) {
    updates.icon = normalizeOptionalText(input.icon, 48);
  }
  if (input.sortOrder !== undefined) {
    updates.sortOrder = Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0;
  }

  const [updated] = await db
    .update(todoCategories)
    .set(updates)
    .where(and(eq(todoCategories.id, categoryId), eq(todoCategories.userId, userId)))
    .returning();

  return updated ?? null;
}

export async function archiveTodoCategory(userId: string, categoryId: string): Promise<TodoCategory | null> {
  const now = new Date();
  const [updated] = await db
    .update(todoCategories)
    .set({ isArchived: true, updatedAt: now })
    .where(and(eq(todoCategories.id, categoryId), eq(todoCategories.userId, userId)))
    .returning();

  return updated ?? null;
}

async function resolveCategoryId(userId: string, input: Pick<CreateTodoInput, 'categoryId' | 'categoryName'>): Promise<string | null> {
  await ensureCategoriesSeeded(userId);

  if (input.categoryId) {
    const category = await db.query.todoCategories.findFirst({
      where: and(
        eq(todoCategories.id, input.categoryId),
        eq(todoCategories.userId, userId),
        eq(todoCategories.isArchived, false),
      ),
    });
    if (!category) {
      throw new TodoStoreError('Category not found', 'CATEGORY_NOT_FOUND');
    }
    return category.id;
  }

  const requestedName = normalizeOptionalText(input.categoryName, CATEGORY_NAME_MAX_LENGTH);
  const preferredName = resolveDefaultTodoCategoryName(requestedName) || DEFAULT_TODO_CATEGORY_NAME;
  const preferredDefaultKey = getDefaultTodoCategoryKey(requestedName || preferredName);
  const categories = await listTodoCategories(userId);
  const matched = categories.find((category) => category.name.toLowerCase() === preferredName.toLowerCase())
    ?? (preferredDefaultKey
      ? categories.find((category) => getDefaultTodoCategoryKey(category) === preferredDefaultKey)
      : null)
    ?? categories.find((category) => category.name.toLowerCase() === DEFAULT_TODO_CATEGORY_NAME.toLowerCase())
    ?? categories.find((category) => getDefaultTodoCategoryKey(category) === 'todo');

  return matched?.id ?? null;
}

async function replaceFileLinks(todoId: string, userId: string, links: Array<{ workspacePath: string; label: string | null }>, now: Date) {
  await db.delete(todoFileLinks).where(and(eq(todoFileLinks.todoId, todoId), eq(todoFileLinks.userId, userId)));

  if (links.length === 0) {
    return;
  }

  await db.insert(todoFileLinks).values(
    links.map((link) => ({
      id: randomUUID(),
      todoId,
      userId,
      workspacePath: link.workspacePath,
      label: link.label,
      createdAt: now,
    })),
  );
}

export async function createTodo(userId: string, input: CreateTodoInput): Promise<TodoWithRelations> {
  const now = new Date();
  const categoryId = await resolveCategoryId(userId, input);
  const fileLinks = normalizeFileLinks(input.fileLinks);
  const [created] = await db.insert(todoItems).values({
    id: randomUUID(),
    userId,
    categoryId,
    title: normalizeRequiredText(input.title, 'Title', TITLE_MAX_LENGTH),
    description: normalizeOptionalText(input.description, DESCRIPTION_MAX_LENGTH),
    status: 'open',
    priority: normalizeTodoPriority(input.priority),
    dueAt: normalizeDate(input.dueAt),
    sourceType: normalizeTodoSourceType(input.sourceType),
    sourceAgentId: normalizeOptionalText(input.sourceAgentId, 120),
    sourceSessionId: normalizeOptionalText(input.sourceSessionId, 160),
    seenAt: normalizeDate(input.seenAt),
    completedAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }).returning();

  await replaceFileLinks(created.id, userId, fileLinks, now);
  const hydrated = await getTodo(userId, created.id);
  if (!hydrated) {
    throw new TodoStoreError('Todo not found after creation', 'TODO_NOT_FOUND');
  }
  return hydrated;
}

async function hydrateTodos(rows: TodoItem[]): Promise<TodoWithRelations[]> {
  if (rows.length === 0) return [];

  const categoryIds = Array.from(new Set(rows.map((row) => row.categoryId).filter(Boolean))) as string[];
  const categories = categoryIds.length
    ? await db.select().from(todoCategories).where(inArray(todoCategories.id, categoryIds))
    : [];
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const links = await db
    .select()
    .from(todoFileLinks)
    .where(inArray(todoFileLinks.todoId, rows.map((row) => row.id)))
    .orderBy(asc(todoFileLinks.createdAt));
  const linksByTodoId = new Map<string, TodoFileLink[]>();
  for (const link of links) {
    const current = linksByTodoId.get(link.todoId) ?? [];
    current.push(link);
    linksByTodoId.set(link.todoId, current);
  }

  return rows.map((row) => ({
    ...row,
    category: row.categoryId ? categoryById.get(row.categoryId) ?? null : null,
    fileLinks: linksByTodoId.get(row.id) ?? [],
  }));
}

export async function getTodo(userId: string, todoId: string): Promise<TodoWithRelations | null> {
  const todo = await db.query.todoItems.findFirst({
    where: and(eq(todoItems.id, todoId), eq(todoItems.userId, userId)),
  });
  if (!todo) return null;
  const [hydrated] = await hydrateTodos([todo]);
  return hydrated;
}

export async function listTodos(userId: string, options: ListTodosOptions = {}): Promise<TodoWithRelations[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const conditions = [eq(todoItems.userId, userId)];

  if (options.status && options.status !== 'all' && options.status !== 'active') {
    conditions.push(eq(todoItems.status, options.status));
  } else if (options.status !== 'all') {
    conditions.push(ne(todoItems.status, 'archived'));
  }

  if (options.categoryId) {
    conditions.push(eq(todoItems.categoryId, options.categoryId));
  }
  if (options.sourceType) {
    conditions.push(eq(todoItems.sourceType, normalizeTodoSourceType(options.sourceType)));
  }
  if (options.due) {
    const now = new Date();
    const startOfTomorrow = new Date(now);
    startOfTomorrow.setHours(24, 0, 0, 0);
    if (options.due === 'overdue') {
      conditions.push(sql`${todoItems.dueAt} IS NOT NULL AND ${todoItems.dueAt} < ${now}`);
    } else if (options.due === 'today') {
      conditions.push(sql`${todoItems.dueAt} IS NOT NULL AND ${todoItems.dueAt} < ${startOfTomorrow}`);
    } else if (options.due === 'upcoming') {
      conditions.push(sql`${todoItems.dueAt} IS NOT NULL AND ${todoItems.dueAt} >= ${startOfTomorrow}`);
    }
  }

  const rows = await db
    .select()
    .from(todoItems)
    .where(and(...conditions))
    .orderBy(desc(todoItems.updatedAt))
    .limit(limit);

  return hydrateTodos(rows);
}

export async function updateTodo(userId: string, todoId: string, input: UpdateTodoInput): Promise<TodoWithRelations | null> {
  const current = await db.query.todoItems.findFirst({
    where: and(eq(todoItems.id, todoId), eq(todoItems.userId, userId)),
  });
  if (!current) return null;

  const now = new Date();
  const updates: Partial<typeof todoItems.$inferInsert> = {
    updatedAt: now,
  };

  if (input.title !== undefined) {
    updates.title = normalizeRequiredText(input.title, 'Title', TITLE_MAX_LENGTH);
  }
  if (input.description !== undefined) {
    updates.description = normalizeOptionalText(input.description, DESCRIPTION_MAX_LENGTH);
  }
  if (input.categoryId !== undefined) {
    updates.categoryId = input.categoryId
      ? await resolveCategoryId(userId, { categoryId: input.categoryId })
      : null;
  }
  if (input.priority !== undefined) {
    updates.priority = normalizeTodoPriority(input.priority);
  }
  if (input.dueAt !== undefined) {
    updates.dueAt = normalizeDate(input.dueAt);
  }
  if (input.seenAt !== undefined) {
    updates.seenAt = normalizeDate(input.seenAt);
  }
  if (input.status !== undefined) {
    const nextStatus = normalizeTodoStatus(input.status);
    updates.status = nextStatus;
    if (nextStatus === 'done') {
      updates.completedAt = current.completedAt ?? now;
      updates.archivedAt = null;
    } else if (nextStatus === 'archived') {
      updates.archivedAt = current.archivedAt ?? now;
    } else {
      updates.completedAt = null;
      updates.archivedAt = null;
    }
  }

  await db
    .update(todoItems)
    .set(updates)
    .where(and(eq(todoItems.id, todoId), eq(todoItems.userId, userId)));

  if (input.fileLinks !== undefined) {
    await replaceFileLinks(todoId, userId, normalizeFileLinks(input.fileLinks), now);
  }

  return getTodo(userId, todoId);
}

export async function archiveTodo(userId: string, todoId: string): Promise<TodoWithRelations | null> {
  return updateTodo(userId, todoId, { status: 'archived' });
}

export async function restoreTodo(userId: string, todoId: string): Promise<TodoWithRelations | null> {
  return updateTodo(userId, todoId, { status: 'open' });
}

export async function markTodoSeen(userId: string, todoId: string, seenAt = new Date()): Promise<TodoWithRelations | null> {
  return updateTodo(userId, todoId, { seenAt });
}
