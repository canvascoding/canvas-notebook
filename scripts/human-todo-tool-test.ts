import assert from 'node:assert/strict';

import { createHumanTodoTool, createHumanTodoTools } from '@/app/lib/pi/human-todo-tool';
import { db } from '@/app/lib/db';
import { todoCategories, todoFileLinks, todoItems, user } from '@/app/lib/db/schema';
import { DEFAULT_TODO_CATEGORY_NAME, getDefaultTodoCategoryKey } from '@/app/lib/todos/store';
import { and, eq } from 'drizzle-orm';

process.env.CANVAS_DISABLE_TODO_EMAIL_NOTIFICATIONS = 'true';

async function main() {
  const userId = `human-todo-tool-${Date.now()}`;
  await db.insert(user).values({
    id: userId,
    name: 'Human Todo Tool Test',
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const tool = createHumanTodoTool({ userId, agentId: 'canvas-agent', sessionId: 'session-from-runtime' });
  const tools = createHumanTodoTools({ userId, agentId: 'canvas-agent', sessionId: 'session-from-runtime' });
  assert.deepEqual(tools.map((entry) => entry.name), [
    'create_human_todo',
    'list_human_todos',
    'inspect_human_todo',
    'update_human_todo',
  ]);
  const parameterSchema = tool.parameters as unknown as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.equal(parameterSchema.required?.includes('assigneeUserId'), true);
  assert.equal(parameterSchema.properties?.leaveUnassigned, undefined);

  const result = await tool.execute('tool-test', {
    title: 'Review generated summary',
    assigneeUserId: 'me',
    description: 'Human review is required before publishing.',
    categoryName: 'Prüfen',
    priority: 'high',
    iconKey: 'eye',
    remindAt: '2026-12-01T09:00:00.000Z',
    fileLinks: [],
  });

  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
  assert.match(text, /Human to-do created/);

  const rows = await db.select().from(todoItems).where(eq(todoItems.userId, userId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Review generated summary');
  assert.equal(rows[0].sourceType, 'agent');
  assert.equal(rows[0].sourceAgentId, 'bradley');
  assert.equal(rows[0].sourceSessionId, 'session-from-runtime');
  assert.equal(rows[0].seenAt, null);
  assert.equal(rows[0].priority, 'high');
  assert.equal(rows[0].iconKey, 'eye');
  assert.equal(rows[0].remindAt?.toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(rows[0].assigneeUserId, userId);

  const listTool = tools.find((entry) => entry.name === 'list_human_todos');
  const inspectTool = tools.find((entry) => entry.name === 'inspect_human_todo');
  const updateTool = tools.find((entry) => entry.name === 'update_human_todo');
  assert.ok(listTool);
  assert.ok(inspectTool);
  assert.ok(updateTool);

  const listResult = await listTool.execute('tool-test-list', { query: 'generated summary', status: 'open' });
  assert.match(listResult.content?.[0]?.type === 'text' ? listResult.content[0].text : '', /Review generated summary/);

  const inspectResult = await inspectTool.execute('tool-test-inspect', { todoId: rows[0].id });
  const inspectText = inspectResult.content?.[0]?.type === 'text' ? inspectResult.content[0].text : '';
  assert.match(inspectText, new RegExp(`ID: ${rows[0].id}`));
  assert.match(inspectText, new RegExp(`Updated at: ${rows[0].updatedAt.toISOString()}`));

  const updateResult = await updateTool.execute('tool-test-update', {
    todoId: rows[0].id,
    expectedUpdatedAt: rows[0].updatedAt.toISOString(),
    title: 'Approve generated summary',
    description: null,
    categoryName: 'Freigabe',
    priority: 'low',
    iconKey: null,
    dueAt: '2026-12-02T10:00:00.000Z',
    remindAt: null,
    assigneeUserId: null,
    fileLinks: [{ workspacePath: 'reviews/summary.md', label: 'Summary' }],
    status: 'done',
  });
  assert.match(updateResult.content?.[0]?.type === 'text' ? updateResult.content[0].text : '', /Human to-do updated/);
  const updated = await db.query.todoItems.findFirst({ where: eq(todoItems.id, rows[0].id) });
  assert.ok(updated);
  assert.equal(updated.title, 'Approve generated summary');
  assert.equal(updated.description, null);
  assert.equal(updated.priority, 'low');
  assert.equal(updated.iconKey, null);
  assert.equal(updated.dueAt?.toISOString(), '2026-12-02T10:00:00.000Z');
  assert.equal(updated.remindAt, null);
  assert.equal(updated.assigneeUserId, null);
  assert.equal(updated.status, 'done');
  const updatedCategory = updated.categoryId
    ? await db.query.todoCategories.findFirst({ where: eq(todoCategories.id, updated.categoryId) })
    : null;
  assert.equal(updatedCategory?.name, 'Approval');
  const updatedLinks = await db.select().from(todoFileLinks).where(eq(todoFileLinks.todoId, rows[0].id));
  assert.deepEqual(updatedLinks.map((link) => ({ path: link.workspacePath, label: link.label })), [
    { path: 'reviews/summary.md', label: 'Summary' },
  ]);

  const concurrentUpdatedAt = new Date(updated.updatedAt.getTime() + 1_000);
  await db.update(todoItems).set({ title: 'Changed by another actor', updatedAt: concurrentUpdatedAt }).where(eq(todoItems.id, rows[0].id));
  const staleUpdateResult = await updateTool.execute('tool-test-stale-update', {
    todoId: rows[0].id,
    expectedUpdatedAt: updated.updatedAt.toISOString(),
    title: 'Overwrite concurrent change',
    fileLinks: [],
  });
  assert.match(staleUpdateResult.content?.[0]?.type === 'text' ? staleUpdateResult.content[0].text : '', /changed since it was inspected/);
  const afterStaleUpdate = await db.query.todoItems.findFirst({ where: eq(todoItems.id, rows[0].id) });
  assert.equal(afterStaleUpdate?.title, 'Changed by another actor');
  assert.equal((await db.select().from(todoFileLinks).where(eq(todoFileLinks.todoId, rows[0].id))).length, 1);

  const category = await db.query.todoCategories.findFirst({
    where: and(eq(todoCategories.id, rows[0].categoryId!), eq(todoCategories.userId, userId)),
  });
  assert.equal(category?.name, 'Review');
  assert.equal(getDefaultTodoCategoryKey(category), 'review');

  const fallbackResult = await tool.execute('tool-test-fallback', {
    title: 'Fallback category test',
    assigneeUserId: 'me',
    categoryName: 'Does not exist',
  });
  const fallbackText = fallbackResult.content?.[0]?.type === 'text' ? fallbackResult.content[0].text : '';
  assert.match(fallbackText, /Human to-do created/);
  const fallback = await db.query.todoItems.findFirst({
    where: and(eq(todoItems.userId, userId), eq(todoItems.title, 'Fallback category test')),
  });
  assert.ok(fallback?.categoryId);
  const fallbackCategory = await db.query.todoCategories.findFirst({
    where: and(eq(todoCategories.id, fallback.categoryId), eq(todoCategories.userId, userId)),
  });
  assert.equal(fallbackCategory?.name, DEFAULT_TODO_CATEGORY_NAME);

  const explicitSessionResult = await tool.execute('tool-test-explicit-session', {
    title: 'Explicit session is ignored when runtime session exists',
    assigneeUserId: 'me',
    sourceSessionId: 'manual-session',
  });
  const explicitSessionText = explicitSessionResult.content?.[0]?.type === 'text' ? explicitSessionResult.content[0].text : '';
  assert.match(explicitSessionText, /Human to-do created/);
  const explicitSessionTodo = await db.query.todoItems.findFirst({
    where: and(eq(todoItems.userId, userId), eq(todoItems.title, 'Explicit session is ignored when runtime session exists')),
  });
  assert.equal(explicitSessionTodo?.sourceSessionId, 'session-from-runtime');

  const missingAssigneeResult = await tool.execute('tool-test-missing-assignee', {
    title: 'Missing responsible person',
  });
  assert.match(
    missingAssigneeResult.content?.[0]?.type === 'text' ? missingAssigneeResult.content[0].text : '',
    /assigneeUserId is required/,
  );
  const missingAssigneeTodo = await db.query.todoItems.findFirst({
    where: and(eq(todoItems.userId, userId), eq(todoItems.title, 'Missing responsible person')),
  });
  assert.equal(missingAssigneeTodo, undefined);

  await db.delete(todoFileLinks).where(eq(todoFileLinks.userId, userId));
  await db.delete(todoItems).where(eq(todoItems.userId, userId));
  await db.delete(todoCategories).where(eq(todoCategories.userId, userId));
  await db.delete(user).where(eq(user.id, userId));

  console.log('[Human Todo Tool Test] passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
