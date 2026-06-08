import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-todo-reply-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;

const outboundMessageId = '<todo-outbound@example.test>';
let activeToken = 'CTD-DEADBEEF';
let activeSubject = `Re: Neues Canvas To-do [${activeToken}]`;
let activeBody = [
  'Hier ist meine Antwort für den Agenten.',
  '',
  'Am 08.06.2026 schrieb Canvas:',
  `Antwort-Code ${activeToken}`,
  'Originaler To-do-Text',
].join('\n');
let activeDate = '2026-06-08T12:00:00.000Z';
let activeInReplyTo: string | null = outboundMessageId;
const dispatches: Array<{
  sessionId: string;
  userId: string;
  message: { role: string; content: string; timestamp: number };
  context?: Record<string, unknown>;
}> = [];

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }

  if (request === '@/app/lib/email/service' || request.endsWith('/email/service')) {
    return {
      listEmailMessages: async (_userId: string, input: { accountId: string; query?: string }) => ({
        account: { id: input.accountId },
        folder: 'INBOX',
        messages: [{
          id: `${activeToken}-msg`,
          uid: `${activeToken}-msg`,
          folder: 'INBOX',
          threadId: `${activeToken}-thread`,
          from: 'owner@example.test',
          subject: activeSubject,
          date: activeDate,
          snippet: activeBody.slice(0, 200),
        }],
      }),
      readEmailMessage: async (_userId: string, _accountId: string, messageId: string, folder?: string) => ({
        account: { id: _accountId },
        message: {
          id: messageId,
          folder: folder || 'INBOX',
          threadId: `${activeToken}-thread`,
          from: 'owner@example.test',
          subject: activeSubject,
          date: activeDate,
          messageId: `<${messageId}@example.test>`,
          inReplyTo: activeInReplyTo || '',
          references: activeInReplyTo ? [activeInReplyTo] : [],
          body: activeBody,
          snippet: activeBody.slice(0, 200),
        },
      }),
    };
  }

  if (request === '@/app/lib/pi/runtime-service' || request.endsWith('/pi/runtime-service')) {
    return {
      sendFollowUpMessage: async (
        sessionId: string,
        userId: string,
        message: { role: string; content: string; timestamp: number },
        context?: Record<string, unknown>,
      ) => {
        dispatches.push({ sessionId, userId, message, context });
        return { sessionId, phase: 'running' };
      },
    };
  }

  return originalLoad(request, parent, isMain);
};

function accountIdFor(userId: string): string {
  return `reply-account-${userId}`;
}

async function seedBase(userId: string, todoId: string, sessionId: string) {
  const { db } = await import('../app/lib/db');
  const { emailAccounts, piSessions, todoItems, user } = await import('../app/lib/db/schema');
  const now = new Date();

  await db.insert(user).values({
    id: userId,
    name: 'Todo Reply User',
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(emailAccounts).values({
    id: accountIdFor(userId),
    userId,
    provider: 'smtp_imap',
    authType: 'smtp_imap',
    emailAddress: 'owner@example.test',
    displayName: null,
    providerAccountId: 'owner@example.test',
    status: 'active',
    policyJson: JSON.stringify({ readFrom: [], sendTo: [] }),
    secretRef: 'test-secret',
    isPrimary: true,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(piSessions).values({
    sessionId,
    userId,
    agentId: 'canvas-agent',
    provider: 'openai',
    model: 'gpt-test',
    thinkingLevel: null,
    title: 'Reply session',
    createdAt: now,
    updatedAt: now,
    summaryText: null,
    summaryUpdatedAt: null,
    summaryThroughTimestamp: null,
    summaryThroughSequence: null,
    systemPromptSnapshot: null,
    systemPromptSnapshotHash: null,
    systemPromptSnapshotCreatedAt: null,
    lastMessageAt: null,
    lastViewedAt: null,
    channelId: 'app',
    channelSessionKey: null,
  });

  await db.insert(todoItems).values({
    id: todoId,
    userId,
    categoryId: null,
    title: `Reply todo ${todoId}`,
    description: 'Bitte eine Antwort per E-Mail einsammeln.',
    status: 'open',
    priority: 'normal',
    dueAt: null,
    sourceType: 'agent',
    sourceAgentId: 'canvas-agent',
    sourceSessionId: sessionId,
    seenAt: null,
    completedAt: null,
    completionComment: null,
    followUpSentAt: null,
    followUpError: null,
    emailNotificationSentAt: now,
    emailNotificationError: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function main() {
  const { db } = await import('../app/lib/db');
  const { todoEmailReplyEvents, todoEmailReplyWatchers } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const {
    extractTodoEmailReplyText,
    pollTodoEmailReplies,
  } = await import('../app/lib/todos/email-reply-watchers');
  const { createTodoEmailReplyWatcher } = await import('../app/lib/todos/email-reply-tracking');

  assert.equal(
    extractTodoEmailReplyText(activeBody, activeToken),
    'Hier ist meine Antwort für den Agenten.',
  );

  await seedBase('reply-user-de', 'reply-todo-de', 'reply-session-de');
  await createTodoEmailReplyWatcher({
    todoId: 'reply-todo-de',
    userId: 'reply-user-de',
    accountId: accountIdFor('reply-user-de'),
    replyToken: activeToken,
    outboundMessageId,
    sourceAgentId: 'canvas-agent',
    sourceSessionId: 'reply-session-de',
    locale: 'de',
    sentAt: new Date('2026-06-08T11:58:00.000Z'),
  });

  const firstPoll = await pollTodoEmailReplies({ now: new Date('2026-06-08T12:01:00.000Z') });
  assert.equal(firstPoll.processed, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].sessionId, 'reply-session-de');
  assert.equal(dispatches[0].userId, 'reply-user-de');
  assert.equal(dispatches[0].context?.channelId, 'email');
  assert.match(dispatches[0].message.content, /Eine Antwort auf die To-do-E-Mail ist eingegangen/);
  assert.match(dispatches[0].message.content, /Hier ist meine Antwort für den Agenten\./);
  assert.match(dispatches[0].message.content, /externe Nutzereingabe/);
  assert.doesNotMatch(dispatches[0].message.content, /Originaler To-do-Text/);

  const deWatcher = await db.query.todoEmailReplyWatchers.findFirst({
    where: eq(todoEmailReplyWatchers.todoId, 'reply-todo-de'),
  });
  assert.equal(deWatcher?.status, 'completed');

  const deEvent = await db.query.todoEmailReplyEvents.findFirst({
    where: eq(todoEmailReplyEvents.todoId, 'reply-todo-de'),
  });
  assert.equal(deEvent?.status, 'dispatched');

  const secondPoll = await pollTodoEmailReplies({ now: new Date('2026-06-08T12:03:00.000Z') });
  assert.equal(secondPoll.processed, 0);
  assert.equal(dispatches.length, 1);

  activeToken = 'CTD-ABCDEF12';
  activeSubject = `Re: New Canvas to-do [${activeToken}]`;
  activeBody = [
    'This is my answer for the agent.',
    '',
    'On Monday Canvas wrote:',
    `Reply code ${activeToken}`,
  ].join('\n');
  activeDate = '2026-06-08T12:10:00.000Z';
  activeInReplyTo = outboundMessageId;

  await seedBase('reply-user-en', 'reply-todo-en', 'reply-session-en');
  await createTodoEmailReplyWatcher({
    todoId: 'reply-todo-en',
    userId: 'reply-user-en',
    accountId: accountIdFor('reply-user-en'),
    replyToken: activeToken,
    outboundMessageId,
    sourceAgentId: 'canvas-agent',
    sourceSessionId: 'reply-session-en',
    locale: 'en',
    sentAt: new Date('2026-06-08T12:05:00.000Z'),
  });

  const englishPoll = await pollTodoEmailReplies({ now: new Date('2026-06-08T12:11:00.000Z') });
  assert.equal(englishPoll.processed, 1);
  assert.equal(dispatches.length, 2);
  assert.match(dispatches[1].message.content, /A reply to the to-do email arrived/);
  assert.match(dispatches[1].message.content, /This is my answer for the agent\./);
  assert.match(dispatches[1].message.content, /external user-provided content/);

  activeToken = 'CTD-IGNORE1';
  activeSubject = `New Canvas to-do [${activeToken}]`;
  activeBody = `Original notification body with ${activeToken}`;
  activeDate = '2026-06-08T12:20:00.000Z';
  activeInReplyTo = null;

  await seedBase('reply-user-ignore', 'reply-todo-ignore', 'reply-session-ignore');
  await createTodoEmailReplyWatcher({
    todoId: 'reply-todo-ignore',
    userId: 'reply-user-ignore',
    accountId: accountIdFor('reply-user-ignore'),
    replyToken: activeToken,
    outboundMessageId: null,
    sourceAgentId: 'canvas-agent',
    sourceSessionId: 'reply-session-ignore',
    locale: 'en',
    sentAt: new Date('2026-06-08T12:19:00.000Z'),
  });

  const ignoredPoll = await pollTodoEmailReplies({ now: new Date('2026-06-08T12:21:00.000Z') });
  assert.equal(ignoredPoll.processed, 0);
  assert.equal(dispatches.length, 2);

  console.log('Todo email reply watcher test passed.');
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
