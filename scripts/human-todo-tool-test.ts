import assert from 'node:assert/strict';

import { createHumanTodoTool } from '@/app/lib/pi/human-todo-tool';
import { db } from '@/app/lib/db';
import { todoCategories, todoFileLinks, todoItems, user } from '@/app/lib/db/schema';
import { DEFAULT_TODO_CATEGORY_NAME } from '@/app/lib/todos/store';
import { and, eq } from 'drizzle-orm';

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

  const tool = createHumanTodoTool({ userId, agentId: 'canvas-agent' });

  const result = await tool.execute('tool-test', {
    title: 'Review generated summary',
    description: 'Human review is required before publishing.',
    categoryName: 'Pruefen',
    priority: 'high',
    fileLinks: [],
  });

  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
  assert.match(text, /Human to-do created/);

  const rows = await db.select().from(todoItems).where(eq(todoItems.userId, userId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Review generated summary');
  assert.equal(rows[0].sourceType, 'agent');
  assert.equal(rows[0].sourceAgentId, 'canvas-agent');
  assert.equal(rows[0].seenAt, null);
  assert.equal(rows[0].priority, 'high');

  const category = await db.query.todoCategories.findFirst({
    where: and(eq(todoCategories.id, rows[0].categoryId!), eq(todoCategories.userId, userId)),
  });
  assert.equal(category?.name, 'Pruefen');

  const fallbackResult = await tool.execute('tool-test-fallback', {
    title: 'Fallback category test',
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
