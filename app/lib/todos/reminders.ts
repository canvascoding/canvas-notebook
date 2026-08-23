import 'server-only';

import { and, eq, isNull, lte } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { todoItems } from '@/app/lib/db/schema';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';
import { sendTodoAttentionPush } from '@/app/lib/mobile/push-devices';

/** Delivers each due open to-do reminder at most once. Called by the internal scheduler. */
export async function sendDueTodoReminders(now = new Date()): Promise<{ sent: string[]; failed: string[] }> {
  const due = await db.select().from(todoItems).where(and(
    eq(todoItems.status, 'open'),
    lte(todoItems.remindAt, now),
    isNull(todoItems.reminderSentAt),
  ));
  const sent: string[] = [];
  const failed: string[] = [];

  for (const todo of due) {
    // Claim before delivery. The conditional update is the concurrency boundary
    // for overlapping scheduler invocations; only the invocation that obtains
    // the row may send a push notification.
    const claim = await db.update(todoItems).set({
      reminderSentAt: now,
      reminderError: null,
      updatedAt: now,
    }).where(and(
      eq(todoItems.id, todo.id),
      eq(todoItems.status, 'open'),
      isNull(todoItems.reminderSentAt),
    )).returning({ id: todoItems.id });
    if (claim.length === 0) continue;

    const recipientUserId = todo.assigneeUserId || todo.userId;
    try {
      await sendTodoAttentionPush({
        userId: recipientUserId,
        workspaceId: todo.workspaceId || LEGACY_PERSONAL_WORKSPACE_ID,
        todoId: todo.id,
      });
      sent.push(todo.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send to-do reminder.';
      await db.update(todoItems).set({ reminderError: message.slice(0, 1000), updatedAt: now }).where(eq(todoItems.id, todo.id));
      failed.push(todo.id);
    }
  }
  return { sent, failed };
}
