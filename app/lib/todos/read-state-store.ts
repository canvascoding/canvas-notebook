import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { todoReadStates } from '@/app/lib/db/schema';

export type TodoReadState = typeof todoReadStates.$inferSelect;

export async function listTodoReadStates(userId: string, todoIds: string[]): Promise<Map<string, Date>> {
  const uniqueTodoIds = [...new Set(todoIds)];
  if (uniqueTodoIds.length === 0) return new Map();

  const rows = await db
    .select({ todoId: todoReadStates.todoId, readAt: todoReadStates.readAt })
    .from(todoReadStates)
    .where(and(
      eq(todoReadStates.userId, userId),
      inArray(todoReadStates.todoId, uniqueTodoIds),
    ));

  return new Map(rows.map((row) => [row.todoId, row.readAt]));
}

export async function getTodoReadState(userId: string, todoId: string): Promise<Date | null> {
  const [state] = await db
    .select({ readAt: todoReadStates.readAt })
    .from(todoReadStates)
    .where(and(eq(todoReadStates.userId, userId), eq(todoReadStates.todoId, todoId)))
    .limit(1);

  return state?.readAt ?? null;
}

export async function setTodoReadState(userId: string, todoId: string, readAt = new Date()): Promise<Date> {
  await db.insert(todoReadStates).values({
    userId,
    todoId,
    readAt,
    createdAt: readAt,
    updatedAt: readAt,
  }).onConflictDoUpdate({
    target: [todoReadStates.userId, todoReadStates.todoId],
    set: { readAt, updatedAt: readAt },
  });

  return readAt;
}

export async function clearTodoReadState(userId: string, todoId: string): Promise<void> {
  await db.delete(todoReadStates).where(and(
    eq(todoReadStates.userId, userId),
    eq(todoReadStates.todoId, todoId),
  ));
}
