import assert from 'node:assert/strict';
import Module from 'node:module';

import { eq } from 'drizzle-orm';

import { createPiTestDatabase } from './helpers/pi-test-database';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
const deliveredTodoIds: string[] = [];

moduleInternals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) {
    return testDatabase;
  }
  if (request === '@/app/lib/mobile/push-devices' || /\/app\/lib\/mobile\/push-devices(?:\.ts)?$/u.test(request)) {
    return {
      sendTodoAttentionPush: async ({ todoId }: { todoId: string }) => {
        deliveredTodoIds.push(todoId);
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  testDatabase = await createPiTestDatabase();
  try {
    const { db } = testDatabase;
    const { todoItems, user } = await import('../app/lib/db/schema');
    const { sendDueTodoReminders } = await import('../app/lib/todos/reminders');
    const now = new Date('2026-09-11T10:00:00.000Z');

    await db.insert(user).values({
      id: 'todo-reminder-user',
      name: 'Todo Reminder User',
      email: 'todo-reminder@example.test',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(todoItems).values({
      id: 'todo-reminder-once',
      userId: 'todo-reminder-user',
      createdByUserId: 'todo-reminder-user',
      assigneeUserId: null,
      organizationId: null,
      customerId: null,
      projectId: null,
      workspaceId: null,
      workspaceType: 'personal',
      scopeKind: 'user',
      categoryId: null,
      title: 'At-most-once reminder',
      description: null,
      status: 'open',
      priority: 'normal',
      iconKey: null,
      dueAt: null,
      remindAt: new Date(now.getTime() - 60_000),
      reminderSentAt: null,
      reminderError: null,
      sourceType: 'user',
      sourceAgentId: null,
      sourceSessionId: null,
      seenAt: null,
      completedAt: null,
      completionComment: null,
      followUpSentAt: null,
      followUpError: null,
      emailNotificationSentAt: null,
      emailNotificationError: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const concurrent = await Promise.all([
      sendDueTodoReminders(now),
      sendDueTodoReminders(now),
    ]);
    assert.equal(
      concurrent.filter((result) => result.sent.includes('todo-reminder-once')).length,
      1,
      'parallel scheduler calls must deliver a due to-do reminder only once',
    );
    assert.deepEqual(deliveredTodoIds, ['todo-reminder-once']);

    const [todo] = await db.select().from(todoItems).where(eq(todoItems.id, 'todo-reminder-once'));
    assert.ok(todo?.reminderSentAt instanceof Date, 'the successful claim must be durable before delivery');

    const repeated = await sendDueTodoReminders(now);
    assert.equal(repeated.sent.length, 0, 'a later scheduler pass must not redeliver a claimed reminder');
    assert.deepEqual(deliveredTodoIds, ['todo-reminder-once']);
  } finally {
    await testDatabase?.close();
    testDatabase = undefined;
    moduleInternals._load = originalLoad;
  }
  console.log('To-do reminder idempotency passed.');
}

void main();
