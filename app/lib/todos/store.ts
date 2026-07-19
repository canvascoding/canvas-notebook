import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import {
  canvasProjectMembers,
  canvasWorkspaces,
  organizationUserPermissions,
  todoCategories,
  todoFileLinks,
  todoItems,
  user,
} from '@/app/lib/db/schema';
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

export const TODO_WORKSPACE_TYPES = ['personal', 'organization', 'team', 'project'] as const;
export type TodoWorkspaceType = typeof TODO_WORKSPACE_TYPES[number];

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
      | 'TODO_NOT_FOUND'
      | 'ORGANIZATION_ACCESS_DENIED'
      | 'ASSIGNEE_NOT_FOUND',
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
  createdBy: TodoUserSummary | null;
  assignee: TodoUserSummary | null;
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
  organizationId?: string | null;
  workspaceId?: string | null;
  workspaceType?: TodoWorkspaceType | null;
  assigneeUserId?: string | null;
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
  completionComment?: string | null;
  followUpSentAt?: Date | null;
  followUpError?: string | null;
  assigneeUserId?: string | null;
  fileLinks?: TodoFileLinkInput[];
};

export type ListTodosOptions = {
  status?: TodoStatus | 'active' | 'all';
  categoryId?: string | null;
  sourceType?: TodoSourceType;
  workspaceType?: TodoWorkspaceType | 'all';
  organizationId?: string | null;
  workspaceId?: string | null;
  assigneeUserId?: string | 'me' | 'unassigned' | null;
  due?: 'overdue' | 'today' | 'upcoming';
  query?: string;
  beforeUpdatedAt?: Date;
  beforeId?: string;
  limit?: number;
};

export type TodoUserSummary = {
  id: string;
  name: string | null;
  email: string | null;
};

type TodoScope = {
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string | null;
  workspaceType: TodoWorkspaceType;
};

type OrganizationPermission = typeof organizationUserPermissions.$inferSelect;
type WorkspaceRecord = typeof canvasWorkspaces.$inferSelect;

async function sendTodoCreatedEmailNotificationIfNeeded(userId: string, todo: TodoWithRelations): Promise<void> {
  if (process.env.CANVAS_DISABLE_TODO_EMAIL_NOTIFICATIONS === 'true') return;
  if (todo.sourceType !== 'agent') return;

  try {
    const { sendTodoCreatedEmailNotification } = await import('./email-notifications');
    await sendTodoCreatedEmailNotification(userId, todo);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send todo email notification.';
    console.warn('[Todos] Failed to run todo email notification:', message);
  }
}

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

function normalizeWorkspaceType(value: TodoWorkspaceType | null | undefined): TodoWorkspaceType {
  if (!value) return 'personal';
  if (!TODO_WORKSPACE_TYPES.includes(value)) {
    throw new TodoStoreError('Invalid todo workspace type', 'INVALID_INPUT');
  }
  return value;
}

function normalizeOptionalId(value: string | null | undefined, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

async function isOrganizationMember(organizationId: string, userId: string): Promise<boolean> {
  const permission = await getActiveOrganizationPermission(organizationId, userId);
  return Boolean(permission && permission.role !== 'external');
}

async function getActiveOrganizationPermission(organizationId: string, userId: string): Promise<OrganizationPermission | null> {
  const permission = await db.query.organizationUserPermissions.findFirst({
    where: and(
      eq(organizationUserPermissions.organizationId, organizationId),
      eq(organizationUserPermissions.userId, userId),
      eq(organizationUserPermissions.status, 'active'),
    ),
  });
  return permission ?? null;
}

async function assertOrganizationMember(organizationId: string, userId: string): Promise<void> {
  if (!(await isOrganizationMember(organizationId, userId))) {
    throw new TodoStoreError('User is not a member of this organization.', 'ORGANIZATION_ACCESS_DENIED');
  }
}

async function isOrganizationWorkspaceWriter(organizationId: string, userId: string): Promise<boolean> {
  const permission = await getActiveOrganizationPermission(organizationId, userId);
  return Boolean(
    permission
    && permission.role !== 'external'
    && (permission.role === 'owner' || permission.role === 'admin' || permission.canWriteTeamWorkspace),
  );
}

async function assertOrganizationWorkspaceWriter(organizationId: string, userId: string): Promise<void> {
  if (!(await isOrganizationWorkspaceWriter(organizationId, userId))) {
    throw new TodoStoreError('User cannot write to this shared workspace.', 'ORGANIZATION_ACCESS_DENIED');
  }
}

async function assertAssignableUser(organizationId: string, assigneeUserId: string): Promise<void> {
  if (!(await isOrganizationMember(organizationId, assigneeUserId))) {
    throw new TodoStoreError('Assignee is not a member of this organization.', 'ASSIGNEE_NOT_FOUND');
  }
}

function isSharedTodoWorkspaceType(workspaceType: TodoWorkspaceType | 'all'): workspaceType is Exclude<TodoWorkspaceType, 'personal'> {
  return workspaceType === 'organization' || workspaceType === 'team' || workspaceType === 'project';
}

function isOrganizationAdminLike(permission: OrganizationPermission | null): boolean {
  return permission?.role === 'owner' || permission?.role === 'admin';
}

async function assertSharedWorkspaceInOrganization(
  organizationId: string,
  workspaceId: string,
  expectedType?: Exclude<TodoWorkspaceType, 'personal'>,
): Promise<WorkspaceRecord> {
  const workspace = await db.query.canvasWorkspaces.findFirst({
    where: and(
      eq(canvasWorkspaces.id, workspaceId),
      eq(canvasWorkspaces.organizationId, organizationId),
      inArray(canvasWorkspaces.type, ['organization', 'team', 'project']),
      eq(canvasWorkspaces.status, 'active'),
    ),
  });
  if (!workspace || (expectedType && workspace.type !== expectedType)) {
    throw new TodoStoreError('Shared workspace not found.', 'INVALID_INPUT');
  }
  return workspace;
}

async function assertProjectWorkspacePermission(
  organizationId: string,
  workspaceId: string,
  userId: string,
  options: { requireWrite?: boolean; deniedCode?: 'ORGANIZATION_ACCESS_DENIED' | 'ASSIGNEE_NOT_FOUND' } = {},
): Promise<WorkspaceRecord> {
  const workspace = await assertSharedWorkspaceInOrganization(organizationId, workspaceId, 'project');
  if (!workspace.projectId) {
    throw new TodoStoreError('Project workspace not found.', 'INVALID_INPUT');
  }

  const organizationPermission = await getActiveOrganizationPermission(organizationId, userId);
  if (isOrganizationAdminLike(organizationPermission)) {
    return workspace;
  }

  const membership = await db.query.canvasProjectMembers.findFirst({
    where: and(
      eq(canvasProjectMembers.organizationId, organizationId),
      eq(canvasProjectMembers.projectId, workspace.projectId),
      eq(canvasProjectMembers.userId, userId),
      eq(canvasProjectMembers.status, 'active'),
    ),
  });
  const canRead = Boolean(membership && (membership.canRead || membership.canWrite || membership.canManage));
  const canWrite = Boolean(membership && (membership.canWrite || membership.canManage));
  if (options.requireWrite ? canWrite : canRead) {
    return workspace;
  }

  throw new TodoStoreError(
    options.requireWrite ? 'User cannot write to this project workspace.' : 'User cannot read this project workspace.',
    options.deniedCode ?? 'ORGANIZATION_ACCESS_DENIED',
  );
}

async function canReadProjectWorkspace(organizationId: string, workspaceId: string, userId: string): Promise<boolean> {
  try {
    await assertProjectWorkspacePermission(organizationId, workspaceId, userId);
    return true;
  } catch {
    return false;
  }
}

async function listReadableProjectWorkspaceIds(organizationId: string, userId: string): Promise<string[]> {
  const organizationPermission = await getActiveOrganizationPermission(organizationId, userId);
  if (isOrganizationAdminLike(organizationPermission)) {
    const rows = await db
      .select({ workspaceId: canvasWorkspaces.id })
      .from(canvasWorkspaces)
      .where(and(
        eq(canvasWorkspaces.organizationId, organizationId),
        eq(canvasWorkspaces.type, 'project'),
        eq(canvasWorkspaces.status, 'active'),
      ));
    return rows.map((row) => row.workspaceId);
  }

  const rows = await db
    .select({ workspaceId: canvasWorkspaces.id })
    .from(canvasWorkspaces)
    .innerJoin(canvasProjectMembers, and(
      eq(canvasProjectMembers.organizationId, organizationId),
      eq(canvasProjectMembers.projectId, canvasWorkspaces.projectId),
      eq(canvasProjectMembers.userId, userId),
      eq(canvasProjectMembers.status, 'active'),
    ))
    .where(and(
      eq(canvasWorkspaces.organizationId, organizationId),
      eq(canvasWorkspaces.type, 'project'),
      eq(canvasWorkspaces.status, 'active'),
      or(
        eq(canvasProjectMembers.canRead, true),
        eq(canvasProjectMembers.canWrite, true),
        eq(canvasProjectMembers.canManage, true),
      )!,
    ));
  return rows.map((row) => row.workspaceId);
}

async function resolveTodoScope(userId: string, input: Pick<CreateTodoInput, 'organizationId' | 'workspaceId' | 'workspaceType'>): Promise<TodoScope> {
  const workspaceType = normalizeWorkspaceType(input.workspaceType);
  if (workspaceType === 'personal') {
    return { organizationId: null, customerId: null, projectId: null, workspaceId: null, workspaceType };
  }

  const organizationId = normalizeOptionalId(input.organizationId);
  if (!organizationId) {
    throw new TodoStoreError('organizationId is required for shared workspace to-dos.', 'INVALID_INPUT');
  }
  const workspaceId = normalizeOptionalId(input.workspaceId);
  if (workspaceType === 'project' && !workspaceId) {
    throw new TodoStoreError('workspaceId is required for project workspace to-dos.', 'INVALID_INPUT');
  }

  if (workspaceType !== 'project') {
    await assertOrganizationMember(organizationId, userId);
  }

  let workspace: WorkspaceRecord | null = null;
  if (workspaceId) {
    workspace = workspaceType === 'project'
      ? await assertProjectWorkspacePermission(organizationId, workspaceId, userId)
      : await assertSharedWorkspaceInOrganization(organizationId, workspaceId, workspaceType);
  }

  return {
    organizationId,
    customerId: workspace?.customerId ?? null,
    projectId: workspace?.projectId ?? null,
    workspaceId,
    workspaceType,
  };
}

async function canReadTodo(userId: string, todo: TodoItem): Promise<boolean> {
  const workspaceType = normalizeWorkspaceType((todo.workspaceType as TodoWorkspaceType | null) ?? 'personal');
  if (workspaceType === 'personal') return todo.userId === userId;
  if (workspaceType === 'project') {
    return Boolean(todo.organizationId && todo.workspaceId && await canReadProjectWorkspace(todo.organizationId, todo.workspaceId, userId));
  }
  return Boolean(todo.organizationId && await isOrganizationMember(todo.organizationId, userId));
}

async function assertCanReadTodo(userId: string, todo: TodoItem): Promise<void> {
  if (!(await canReadTodo(userId, todo))) {
    throw new TodoStoreError('Todo not found', 'TODO_NOT_FOUND');
  }
}

async function assertCanWriteTodo(userId: string, todo: TodoItem): Promise<void> {
  const workspaceType = normalizeWorkspaceType((todo.workspaceType as TodoWorkspaceType | null) ?? 'personal');
  if (workspaceType === 'personal') {
    if (todo.userId !== userId) {
      throw new TodoStoreError('Todo not found', 'TODO_NOT_FOUND');
    }
    return;
  }

  if (!todo.organizationId) {
    throw new TodoStoreError('Shared workspace todo is missing organization scope.', 'INVALID_INPUT');
  }
  if (workspaceType === 'project') {
    if (!todo.workspaceId) {
      throw new TodoStoreError('Project workspace todo is missing workspace scope.', 'INVALID_INPUT');
    }
    await assertProjectWorkspacePermission(todo.organizationId, todo.workspaceId, userId, { requireWrite: true });
    return;
  }
  await assertOrganizationWorkspaceWriter(todo.organizationId, userId);
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

async function replaceFileLinks(
  todoId: string,
  userId: string,
  scope: TodoScope,
  links: Array<{ workspacePath: string; label: string | null }>,
  now: Date,
) {
  await db.delete(todoFileLinks).where(and(eq(todoFileLinks.todoId, todoId), eq(todoFileLinks.userId, userId)));

  if (links.length === 0) {
    return;
  }

  await db.insert(todoFileLinks).values(
    links.map((link) => ({
      id: randomUUID(),
      todoId,
      userId,
      organizationId: scope.organizationId,
      customerId: scope.customerId,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      workspaceType: scope.workspaceType,
      workspacePath: link.workspacePath,
      label: link.label,
      createdAt: now,
    })),
  );
}

export async function createTodo(userId: string, input: CreateTodoInput): Promise<TodoWithRelations> {
  const now = new Date();
  const scope = await resolveTodoScope(userId, input);
  const assigneeUserId = normalizeOptionalId(input.assigneeUserId);
  if (scope.workspaceType === 'project') {
    if (!scope.workspaceId) {
      throw new TodoStoreError('workspaceId is required for project workspace to-dos.', 'INVALID_INPUT');
    }
    await assertProjectWorkspacePermission(scope.organizationId!, scope.workspaceId, userId, { requireWrite: true });
    if (assigneeUserId) {
      await assertProjectWorkspacePermission(scope.organizationId!, scope.workspaceId, assigneeUserId, { deniedCode: 'ASSIGNEE_NOT_FOUND' });
    }
  } else if (isSharedTodoWorkspaceType(scope.workspaceType)) {
    await assertOrganizationWorkspaceWriter(scope.organizationId!, userId);
    if (assigneeUserId) {
      await assertAssignableUser(scope.organizationId!, assigneeUserId);
    }
  } else if (scope.workspaceType === 'personal' && assigneeUserId && assigneeUserId !== userId) {
    throw new TodoStoreError('Personal to-dos can only be assigned to the current user.', 'ASSIGNEE_NOT_FOUND');
  }
  const categoryId = await resolveCategoryId(userId, input);
  const fileLinks = normalizeFileLinks(input.fileLinks);
  const [created] = await db.insert(todoItems).values({
    id: randomUUID(),
    userId,
    createdByUserId: userId,
    assigneeUserId: assigneeUserId || null,
    organizationId: scope.organizationId,
    customerId: scope.customerId,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    workspaceType: scope.workspaceType,
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
    completionComment: null,
    followUpSentAt: null,
    followUpError: null,
    emailNotificationSentAt: null,
    emailNotificationError: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }).returning();

  await replaceFileLinks(created.id, userId, scope, fileLinks, now);
  const hydrated = await getTodo(userId, created.id);
  if (!hydrated) {
    throw new TodoStoreError('Todo not found after creation', 'TODO_NOT_FOUND');
  }
  await sendTodoCreatedEmailNotificationIfNeeded(userId, hydrated);
  return (await getTodo(userId, created.id)) ?? hydrated;
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

  const userIds = Array.from(new Set(rows.flatMap((row) => [
    row.createdByUserId || row.userId,
    row.assigneeUserId,
  ]).filter(Boolean))) as string[];
  const users = userIds.length
    ? await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, userIds))
    : [];
  const userById = new Map(users.map((entry) => [entry.id, entry]));

  return rows.map((row) => ({
    ...row,
    category: row.categoryId ? categoryById.get(row.categoryId) ?? null : null,
    fileLinks: linksByTodoId.get(row.id) ?? [],
    createdBy: userById.get(row.createdByUserId || row.userId) ?? null,
    assignee: row.assigneeUserId ? userById.get(row.assigneeUserId) ?? null : null,
  }));
}

export async function getTodo(userId: string, todoId: string): Promise<TodoWithRelations | null> {
  const todo = await db.query.todoItems.findFirst({
    where: eq(todoItems.id, todoId),
  });
  if (!todo) return null;
  await assertCanReadTodo(userId, todo);
  const [hydrated] = await hydrateTodos([todo]);
  return hydrated;
}

export async function listTodos(userId: string, options: ListTodosOptions = {}): Promise<TodoWithRelations[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const workspaceType = options.workspaceType || 'personal';
  const conditions = [];

  if (isSharedTodoWorkspaceType(workspaceType)) {
    const organizationId = normalizeOptionalId(options.organizationId);
    if (!organizationId) {
      throw new TodoStoreError('organizationId is required for shared workspace to-dos.', 'INVALID_INPUT');
    }
    if (workspaceType !== 'project') {
      await assertOrganizationMember(organizationId, userId);
    }
    conditions.push(eq(todoItems.organizationId, organizationId), eq(todoItems.workspaceType, workspaceType));
    const workspaceId = normalizeOptionalId(options.workspaceId);
    if (workspaceType === 'project') {
      if (!workspaceId) {
        throw new TodoStoreError('workspaceId is required for project workspace to-dos.', 'INVALID_INPUT');
      }
      await assertProjectWorkspacePermission(organizationId, workspaceId, userId);
      conditions.push(eq(todoItems.workspaceId, workspaceId));
    } else if (workspaceId) {
      await assertSharedWorkspaceInOrganization(organizationId, workspaceId, workspaceType);
      conditions.push(eq(todoItems.workspaceId, workspaceId));
    }
  } else if (workspaceType === 'all') {
    const organizationId = normalizeOptionalId(options.organizationId);
    const readableProjectWorkspaceIds = organizationId
      ? await listReadableProjectWorkspaceIds(organizationId, userId)
      : [];
    if (organizationId && (await isOrganizationMember(organizationId, userId) || readableProjectWorkspaceIds.length > 0)) {
      const workspaceConditions = [
        and(eq(todoItems.userId, userId), eq(todoItems.workspaceType, 'personal'))!,
      ];
      if (await isOrganizationMember(organizationId, userId)) {
        workspaceConditions.push(
          and(eq(todoItems.organizationId, organizationId), eq(todoItems.workspaceType, 'organization'))!,
          and(eq(todoItems.organizationId, organizationId), eq(todoItems.workspaceType, 'team'))!,
        );
      }
      if (readableProjectWorkspaceIds.length > 0) {
        workspaceConditions.push(and(
          eq(todoItems.organizationId, organizationId),
          eq(todoItems.workspaceType, 'project'),
          inArray(todoItems.workspaceId, readableProjectWorkspaceIds),
        )!);
      }
      conditions.push(or(...workspaceConditions)!);
    } else {
      conditions.push(eq(todoItems.userId, userId), eq(todoItems.workspaceType, 'personal'));
    }
  } else {
    conditions.push(eq(todoItems.userId, userId), eq(todoItems.workspaceType, 'personal'));
  }

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
  if (options.assigneeUserId === 'me') {
    conditions.push(eq(todoItems.assigneeUserId, userId));
  } else if (options.assigneeUserId === 'unassigned') {
    conditions.push(sql`${todoItems.assigneeUserId} IS NULL`);
  } else if (typeof options.assigneeUserId === 'string' && options.assigneeUserId.trim()) {
    conditions.push(eq(todoItems.assigneeUserId, options.assigneeUserId.trim()));
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
  if (options.query?.trim()) {
    const escaped = options.query.trim().toLocaleLowerCase().replace(/[\\%_]/gu, '\\$&');
    const pattern = `%${escaped}%`;
    conditions.push(sql`(
      lower(${todoItems.title}) LIKE ${pattern} ESCAPE '\'
      OR lower(COALESCE(${todoItems.description}, '')) LIKE ${pattern} ESCAPE '\'
    )`);
  }
  if (options.beforeUpdatedAt && options.beforeId) {
    conditions.push(or(
      lt(todoItems.updatedAt, options.beforeUpdatedAt),
      and(eq(todoItems.updatedAt, options.beforeUpdatedAt), lt(todoItems.id, options.beforeId)),
    )!);
  }

  const rows = await db
    .select()
    .from(todoItems)
    .where(and(...conditions))
    .orderBy(desc(todoItems.updatedAt), desc(todoItems.id))
    .limit(limit);

  return hydrateTodos(rows);
}

export async function updateTodo(userId: string, todoId: string, input: UpdateTodoInput): Promise<TodoWithRelations | null> {
  const current = await db.query.todoItems.findFirst({
    where: eq(todoItems.id, todoId),
  });
  if (!current) return null;
  await assertCanReadTodo(userId, current);
  await assertCanWriteTodo(userId, current);

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
  if (input.completionComment !== undefined) {
    updates.completionComment = normalizeOptionalText(input.completionComment, DESCRIPTION_MAX_LENGTH);
  }
  if (input.followUpSentAt !== undefined) {
    updates.followUpSentAt = normalizeDate(input.followUpSentAt);
  }
  if (input.followUpError !== undefined) {
    updates.followUpError = normalizeOptionalText(input.followUpError, 1000);
  }
  if (input.assigneeUserId !== undefined) {
    const assigneeUserId = normalizeOptionalId(input.assigneeUserId);
    const workspaceType = normalizeWorkspaceType((current.workspaceType as TodoWorkspaceType | null) ?? 'personal');
    if (workspaceType === 'project' && assigneeUserId) {
      if (!current.organizationId || !current.workspaceId) {
        throw new TodoStoreError('Project workspace todo is missing workspace scope.', 'INVALID_INPUT');
      }
      await assertProjectWorkspacePermission(current.organizationId, current.workspaceId, assigneeUserId, { deniedCode: 'ASSIGNEE_NOT_FOUND' });
    } else if (isSharedTodoWorkspaceType(workspaceType) && assigneeUserId) {
      if (!current.organizationId) throw new TodoStoreError('Shared workspace todo is missing organization scope.', 'INVALID_INPUT');
      await assertAssignableUser(current.organizationId, assigneeUserId);
    } else if (workspaceType === 'personal' && assigneeUserId && assigneeUserId !== userId) {
      throw new TodoStoreError('Personal to-dos can only be assigned to the current user.', 'ASSIGNEE_NOT_FOUND');
    }
    updates.assigneeUserId = assigneeUserId;
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
    .where(eq(todoItems.id, todoId));

  if (input.fileLinks !== undefined) {
    await replaceFileLinks(todoId, current.userId, {
      organizationId: current.organizationId,
      customerId: current.customerId,
      projectId: current.projectId,
      workspaceId: current.workspaceId,
      workspaceType: normalizeWorkspaceType((current.workspaceType as TodoWorkspaceType | null) ?? 'personal'),
    }, normalizeFileLinks(input.fileLinks), now);
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
