import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-todo-email-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
delete process.env.CANVAS_DISABLE_TODO_EMAIL_NOTIFICATIONS;

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;

type DraftInput = {
  accountId: string;
  to: string[];
  subject: string;
  body: string;
  is_HTML?: boolean;
};

let accounts: unknown[] = [{ id: 'local_notify_test', provider: 'google', emailAddress: 'owner@example.test', status: 'active' }];
const drafts: DraftInput[] = [];
const sentDrafts: Array<{ accountId: string; draftId: string }> = [];

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }

  if (request === '@/app/lib/email/service' || request.endsWith('/email/service')) {
    return {
      listEmailAccounts: async () => ({ mode: 'local', accounts }),
      createEmailDraft: async (input: DraftInput) => {
        drafts.push(input);
        return { draft: { id: `draft-${drafts.length}` } };
      },
      sendEmailDraft: async (accountId: string, draftId: string) => {
        sentDrafts.push({ accountId, draftId });
        return { sent: true, draftId };
      },
    };
  }

  return originalLoad(request, parent, isMain);
};

async function main() {
  const { db } = await import('../app/lib/db');
  const { todoItems, user } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { sendTodoCreatedEmailNotification } = await import('../app/lib/todos/email-notifications');
  const now = new Date();
  const userId = 'todo-email-user';

  await db.insert(user).values({
    id: userId,
    name: 'Todo Email User',
    email: 'owner@example.test',
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  const [agentTodo] = await db.insert(todoItems).values({
    id: 'todo-email-agent',
    userId,
    categoryId: null,
    title: 'Review <script>alert(1)</script>',
    description: 'Check <b>the draft</b>\nThen approve.',
    status: 'open',
    priority: 'high',
    dueAt: null,
    sourceType: 'agent',
    sourceAgentId: 'canvas-agent',
    sourceSessionId: 'sess-email',
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
  }).returning();

  const result = await sendTodoCreatedEmailNotification(userId, {
    ...agentTodo,
    category: null,
    fileLinks: [],
  });

  assert.equal(result.status, 'sent');
  assert.equal(drafts.length, 1);
  assert.equal(sentDrafts.length, 1);
  assert.deepEqual(drafts[0].to, ['owner@example.test']);
  assert.equal(drafts[0].accountId, 'local_notify_test');
  assert.equal(drafts[0].is_HTML, true);
  assert.match(drafts[0].subject, /^Neues Canvas To-do:/);
  assert.match(drafts[0].body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(drafts[0].body, /Check &lt;b&gt;the draft&lt;\/b&gt;<br>Then approve\./);
  assert.doesNotMatch(drafts[0].body, /<script>/);

  const storedSentTodo = await db.query.todoItems.findFirst({ where: eq(todoItems.id, agentTodo.id) });
  assert.ok(storedSentTodo?.emailNotificationSentAt);
  assert.equal(storedSentTodo?.emailNotificationError, null);

  accounts = [];
  const [skippedTodo] = await db.insert(todoItems).values({
    ...agentTodo,
    id: 'todo-email-no-account',
    title: 'No account',
    emailNotificationSentAt: null,
    emailNotificationError: null,
    createdAt: new Date(now.getTime() + 1),
    updatedAt: new Date(now.getTime() + 1),
  }).returning();

  const skipped = await sendTodoCreatedEmailNotification(userId, {
    ...skippedTodo,
    category: null,
    fileLinks: [],
  });

  assert.equal(skipped.status, 'skipped');
  assert.equal(drafts.length, 1);
  const storedSkippedTodo = await db.query.todoItems.findFirst({ where: eq(todoItems.id, skippedTodo.id) });
  assert.equal(storedSkippedTodo?.emailNotificationSentAt, null);
  assert.match(storedSkippedTodo?.emailNotificationError || '', /No active email account/);

  console.log('Todo email notification test passed.');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
