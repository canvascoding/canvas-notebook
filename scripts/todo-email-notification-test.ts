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
  headers?: Record<string, string>;
};

let accounts: unknown[] = [{
  id: 'local_notify_secondary',
  provider: 'google',
  emailAddress: 'secondary@example.test',
  status: 'active',
  isPrimary: false,
  policy: { readFrom: [], sendTo: [] },
}, {
  id: 'local_notify_test',
  provider: 'google',
  emailAddress: 'owner@example.test',
  status: 'active',
  isPrimary: true,
  policy: { readFrom: [], sendTo: [] },
}];
const drafts: DraftInput[] = [];
const sentDrafts: Array<{ accountId: string; draftId: string }> = [];
const sentMessages: DraftInput[] = [];

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }

  if (request === '@/app/lib/email/service' || request.endsWith('/email/service')) {
    return {
      listEmailAccounts: async (_userId: string) => ({ mode: 'local', accounts }),
      createEmailDraft: async (_userId: string, input: DraftInput) => {
        drafts.push(input);
        return { draft: { id: `draft-${drafts.length}` } };
      },
      sendEmailDraft: async (_userId: string, accountId: string, draftId: string) => {
        sentDrafts.push({ accountId, draftId });
        return { sent: true, draftId };
      },
      sendEmailMessage: async (_userId: string, input: DraftInput) => {
        sentMessages.push(input);
        return { sent: true, messageId: `<todo-message-${sentMessages.length}@example.test>` };
      },
    };
  }

  return originalLoad(request, parent, isMain);
};

async function main() {
  const { db } = await import('../app/lib/db');
  const { emailAccounts, todoEmailReplyWatchers, todoItems, user } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { sendTodoCreatedEmailNotification } = await import('../app/lib/todos/email-notifications');
  const { setUserPreferredLocale } = await import('../app/lib/user-preferences');
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

  await db.insert(emailAccounts).values({
    id: 'local_notify_test',
    userId,
    provider: 'google',
    authType: 'oauth',
    emailAddress: 'owner@example.test',
    displayName: null,
    providerAccountId: 'owner@example.test',
    status: 'active',
    policyJson: JSON.stringify({ readFrom: [], sendTo: [] }),
    secretRef: 'todo-email-test-secret',
    isPrimary: true,
    lastUsedAt: null,
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
  const todoRelations = {
    category: null,
    fileLinks: [],
    createdBy: { id: userId, name: 'Todo Email User', email: 'owner@example.test' },
    assignee: null,
  };

  const result = await sendTodoCreatedEmailNotification(userId, {
    ...agentTodo,
    ...todoRelations,
  });

  assert.equal(result.status, 'sent');
  assert.equal(drafts.length, 0);
  assert.equal(sentDrafts.length, 0);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0].to, ['owner@example.test']);
  assert.equal(sentMessages[0].accountId, 'local_notify_test');
  assert.equal(sentMessages[0].is_HTML, true);
  assert.match(sentMessages[0].subject, /^Neues Canvas To-do:/);
  assert.match(sentMessages[0].subject, /\[CTD-[A-F0-9]{8}\]$/);
  assert.match(sentMessages[0].body, /<html lang="de">/);
  assert.match(sentMessages[0].body, /für dich angelegt/);
  assert.match(sentMessages[0].body, /Priorität/);
  assert.match(sentMessages[0].body, /Fällig/);
  assert.match(sentMessages[0].body, /Antwort-Code/);
  assert.match(sentMessages[0].body, /direkt auf diese E-Mail antworten/);
  assert.match(sentMessages[0].body, /To-do öffnen/);
  assert.doesNotMatch(sentMessages[0].body, /fuer|Prioritaet|Faellig|oeffnen/);
  assert.match(sentMessages[0].body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(sentMessages[0].body, /Check &lt;b&gt;the draft&lt;\/b&gt;<br>Then approve\./);
  assert.doesNotMatch(sentMessages[0].body, /<script>/);
  assert.match(sentMessages[0].headers?.['X-Canvas-Reply-Token'] || '', /^CTD-[A-F0-9]{8}$/);
  assert.equal(sentMessages[0].headers?.['X-Canvas-Todo-Id'], agentTodo.id);

  const watcher = await db.query.todoEmailReplyWatchers.findFirst({
    where: eq(todoEmailReplyWatchers.todoId, agentTodo.id),
  });
  assert.equal(watcher?.status, 'active');
  assert.equal(watcher?.sourceSessionId, 'sess-email');
  assert.equal(watcher?.locale, 'de');
  assert.equal(watcher?.replyToken, sentMessages[0].headers?.['X-Canvas-Reply-Token']);

  const storedSentTodo = await db.query.todoItems.findFirst({ where: eq(todoItems.id, agentTodo.id) });
  assert.ok(storedSentTodo?.emailNotificationSentAt);
  assert.equal(storedSentTodo?.emailNotificationError, null);

  await setUserPreferredLocale(userId, 'en');
  const [englishTodo] = await db.insert(todoItems).values({
    ...agentTodo,
    id: 'todo-email-english',
    title: 'Buy acetone',
    description: null,
    dueAt: new Date('2026-06-08T00:00:00.000Z'),
    emailNotificationSentAt: null,
    emailNotificationError: null,
    createdAt: new Date(now.getTime() + 1),
    updatedAt: new Date(now.getTime() + 1),
  }).returning();

  const englishResult = await sendTodoCreatedEmailNotification(userId, {
    ...englishTodo,
    ...todoRelations,
  });

  assert.equal(englishResult.status, 'sent');
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].subject, /^New Canvas to-do:/);
  assert.match(sentMessages[1].body, /<html lang="en">/);
  assert.match(sentMessages[1].body, /Your Canvas Agent created a new to-do for you\./);
  assert.match(sentMessages[1].body, /Priority/);
  assert.match(sentMessages[1].body, /Due/);
  assert.match(sentMessages[1].body, /Reply code/);
  assert.match(sentMessages[1].body, /reply directly to this email/);
  assert.match(sentMessages[1].body, /Open to-do/);
  assert.match(sentMessages[1].body, /\/en\/todos\?todo=todo-email-english/);

  accounts = [];
  const [skippedTodo] = await db.insert(todoItems).values({
    ...agentTodo,
    id: 'todo-email-no-account',
    title: 'No account',
    emailNotificationSentAt: null,
    emailNotificationError: null,
    createdAt: new Date(now.getTime() + 2),
    updatedAt: new Date(now.getTime() + 2),
  }).returning();

  const skipped = await sendTodoCreatedEmailNotification(userId, {
    ...skippedTodo,
    ...todoRelations,
  });

  assert.equal(skipped.status, 'skipped');
  assert.equal(sentMessages.length, 2);
  const storedSkippedTodo = await db.query.todoItems.findFirst({ where: eq(todoItems.id, skippedTodo.id) });
  assert.equal(storedSkippedTodo?.emailNotificationSentAt, null);
  assert.match(storedSkippedTodo?.emailNotificationError || '', /No active email account/);

  accounts = [{
    id: 'local_notify_test',
    provider: 'google',
    emailAddress: 'owner@example.test',
    status: 'active',
    isPrimary: true,
    policy: { readFrom: [], sendTo: ['allowed@example.test'] },
  }];
  const [policyTodo] = await db.insert(todoItems).values({
    ...agentTodo,
    id: 'todo-email-policy-own-recipient',
    title: 'Policy own recipient',
    emailNotificationSentAt: null,
    emailNotificationError: null,
    createdAt: new Date(now.getTime() + 3),
    updatedAt: new Date(now.getTime() + 3),
  }).returning();

  const policyAllowed = await sendTodoCreatedEmailNotification(userId, {
    ...policyTodo,
    ...todoRelations,
  });

  assert.equal(policyAllowed.status, 'sent');
  assert.equal(sentMessages.length, 3);
  assert.deepEqual(sentMessages[2].to, ['owner@example.test']);
  const storedPolicyTodo = await db.query.todoItems.findFirst({ where: eq(todoItems.id, policyTodo.id) });
  assert.ok(storedPolicyTodo?.emailNotificationSentAt);
  assert.equal(storedPolicyTodo?.emailNotificationError, null);

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
