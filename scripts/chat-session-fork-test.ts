import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, asc, eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { piMetadataFixture, piToolMetadataFixture } from './helpers/pi-message-fixture';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-chat-session-fork-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
moduleInternals._load = (request, parent, isMain) => {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request))) return testDatabase;
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

function persistedMessage(role: string, content: unknown, timestamp: number): string {
  return JSON.stringify({ role, content, timestamp });
}

function persistedAssistant(text: string, timestamp: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test-provider',
    model: 'test-model',
    stopReason: 'stop',
    timestamp,
    ...extra,
  });
}

async function main(): Promise<void> {
  testDatabase = await createPiTestDatabase();
  const { db } = testDatabase;
  const { piMessages, piSessions, sessionChannelLinks, user } = await import('../app/lib/db/schema');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const {
    forkPiSession,
    formatForkSessionTitle,
    PiSessionForkError,
    resolveForkSessionTitle,
  } = await import('../app/lib/pi/session-fork');

  assert.equal(resolveForkSessionTitle({
    sourceTitle: 'Research',
    sourceIsFork: false,
    existingTitles: ['Research', 'Research (2)'],
  }), 'Research (3)');
  assert.equal(resolveForkSessionTitle({
    sourceTitle: 'Research (2)',
    sourceIsFork: true,
    existingTitles: ['Research', 'Research (2)'],
  }), 'Research (3)');
  assert.equal(resolveForkSessionTitle({
    sourceTitle: 'Research (2)',
    sourceIsFork: false,
    existingTitles: ['Research (2)'],
  }), 'Research (2) (2)');
  assert.equal(formatForkSessionTitle('x'.repeat(120), 2).length, 120);

  const now = new Date('2026-09-07T12:00:00.000Z');
  const userId = 'user-chat-fork';
  const agentId = 'agent-chat-fork';
  const workspaceId = 'workspace-chat-fork';
  await db.insert(user).values({
    id: userId,
    name: 'Chat Fork Tester',
    email: 'chat-fork@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const [source] = await db.insert(piSessions).values({
    sessionId: 'source-session',
    userId,
    agentId,
    provider: 'test-provider',
    model: 'test-model',
    thinkingLevel: 'medium',
    title: 'Research',
    titleGenerationState: 'manual',
    createdAt: now,
    updatedAt: now,
    summaryText: 'The first two turns were summarized.',
    summaryUpdatedAt: now,
    summaryThroughTimestamp: now.getTime() + 4_000,
    summaryThroughSequence: 4,
    summaryRevision: 2,
    systemPromptSnapshot: 'Original system prompt',
    systemPromptSnapshotHash: 'original-hash',
    systemPromptSnapshotCreatedAt: now,
    lastMessageAt: new Date(now.getTime() + 6_000),
    lastViewedAt: new Date(now.getTime() + 6_000),
    channelId: 'app',
    channelSessionKey: null,
    organizationId: 'organization-chat-fork',
    workspaceId,
    workspaceType: 'personal',
    workspaceName: 'Personal',
    workspaceRootRelativePath: 'workspaces/personal',
    runtimeProviderInstallationId: 'provider-installation',
    runtimeCatalogRevision: 3,
    runtimePolicyRevision: 4,
    runtimeSelectionSource: 'session',
  }).returning({ id: piSessions.id });
  await db.insert(piSessions).values({
    sessionId: 'existing-numbered-session',
    userId,
    agentId,
    provider: 'test-provider',
    model: 'test-model',
    title: 'Research (2)',
    titleGenerationState: 'manual',
    createdAt: now,
    updatedAt: now,
    workspaceId,
    workspaceType: 'personal',
  });

  const messageRows = [
    { role: 'user', content: persistedMessage('user', 'Question one', now.getTime() + 1_000), timestamp: now.getTime() + 1_000 },
    { role: 'assistant', content: persistedAssistant('Answer one', now.getTime() + 2_000), timestamp: now.getTime() + 2_000 },
    { role: 'user', content: persistedMessage('user', 'Question two', now.getTime() + 3_000), timestamp: now.getTime() + 3_000 },
    {
      role: 'assistant',
      content: JSON.stringify({ ...piMetadataFixture, timestamp: now.getTime() + 4_000 }),
      timestamp: now.getTime() + 4_000,
    },
    { role: 'toolResult', content: JSON.stringify({ ...piToolMetadataFixture, timestamp: now.getTime() + 5_000 }), timestamp: now.getTime() + 5_000 },
    { role: 'assistant', content: persistedAssistant('Answer two', now.getTime() + 6_000), timestamp: now.getTime() + 6_000 },
  ].map((message, index) => ({
    piSessionDbId: source.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    sequence: index + 1,
  }));
  await db.insert(piMessages).values(messageRows);
  await db.insert(sessionChannelLinks).values({
    sessionId: 'source-session',
    userId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:123',
    channelThreadKey: '',
    displayName: 'External source link',
    isPrimary: true,
    deliveryPolicy: 'last_active',
    createdAt: now,
    updatedAt: now,
  });

  const runtimeSnapshot = {
    selection: {
      providerInstallationId: 'provider-installation',
      providerId: 'test-provider',
      modelId: 'test-model',
      thinkingLevel: 'medium' as const,
    },
    catalogRevision: 5,
    policyRevision: 6,
    selectionSource: 'session' as const,
  };
  const systemPromptSnapshot = buildPiSystemPromptSnapshotFromText('Original system prompt', now);

  const firstFork = await forkPiSession({
    sourceSessionId: 'source-session',
    targetSessionId: 'fork-session-1',
    clientRequestId: 'fork-request-1',
    userId,
    agentId,
    workspaceId,
    workspaceType: 'personal',
    throughSequence: 2,
    runtimeSnapshot,
    systemPromptSnapshot,
    now: new Date(now.getTime() + 10_000),
  });
  assert.equal(firstFork.created, true);
  assert.equal(firstFork.session.title, 'Research (3)');
  assert.equal(firstFork.session.titleGenerationState, 'manual');
  assert.equal(firstFork.session.forkedFromSessionId, 'source-session');
  assert.equal(firstFork.session.forkedFromSequence, 2);
  assert.equal(firstFork.session.summaryText, null, 'a summary beyond the fork point must not be copied');
  assert.equal(firstFork.session.summaryRevision, 0);
  assert.equal(firstFork.copiedMessageCount, 2);

  const firstForkMessages = await db.select({
    role: piMessages.role,
    content: piMessages.content,
    sequence: piMessages.sequence,
  }).from(piMessages)
    .where(eq(piMessages.piSessionDbId, firstFork.session.id))
    .orderBy(asc(piMessages.sequence));
  assert.deepEqual(firstForkMessages, messageRows.slice(0, 2).map((message) => ({
    role: message.role,
    content: message.content,
    sequence: message.sequence,
  })));

  const targetLinks = await db.select().from(sessionChannelLinks)
    .where(eq(sessionChannelLinks.sessionId, firstFork.session.sessionId));
  assert.equal(targetLinks.length, 1);
  assert.equal(targetLinks[0].channelId, 'web');
  assert.equal(targetLinks[0].isPrimary, true);

  const retriedFork = await forkPiSession({
    sourceSessionId: 'source-session',
    targetSessionId: 'fork-session-should-not-exist',
    clientRequestId: 'fork-request-1',
    userId,
    agentId,
    workspaceId,
    workspaceType: 'personal',
    throughSequence: 2,
    runtimeSnapshot,
    systemPromptSnapshot,
  });
  assert.equal(retriedFork.created, false);
  assert.equal(retriedFork.session.sessionId, 'fork-session-1');

  const fullFork = await forkPiSession({
    sourceSessionId: 'source-session',
    targetSessionId: 'fork-session-full',
    clientRequestId: 'fork-request-full',
    userId,
    agentId,
    workspaceId,
    workspaceType: 'personal',
    throughSequence: 6,
    runtimeSnapshot,
    systemPromptSnapshot,
    now: new Date(now.getTime() + 20_000),
  });
  assert.equal(fullFork.session.title, 'Research (4)');
  assert.equal(fullFork.session.summaryText, 'The first two turns were summarized.');
  assert.equal(fullFork.session.summaryThroughSequence, 4);
  assert.equal(fullFork.session.summaryRevision, 2);
  assert.equal(fullFork.copiedMessageCount, 6);
  const fullForkMessages = await db.select({ content: piMessages.content }).from(piMessages)
    .where(eq(piMessages.piSessionDbId, fullFork.session.id)).orderBy(asc(piMessages.sequence));
  assert.deepEqual(fullForkMessages.map((message) => message.content), messageRows.map((message) => message.content), 'fork must preserve raw metadata bytes, including the summarized prefix');

  const nestedFork = await forkPiSession({
    sourceSessionId: firstFork.session.sessionId,
    targetSessionId: 'fork-session-nested',
    clientRequestId: 'fork-request-nested',
    userId,
    agentId,
    workspaceId,
    workspaceType: 'personal',
    throughSequence: 2,
    runtimeSnapshot,
    systemPromptSnapshot,
    now: new Date(now.getTime() + 30_000),
  });
  assert.equal(nestedFork.session.title, 'Research (5)');

  await assert.rejects(
    forkPiSession({
      sourceSessionId: 'source-session',
      targetSessionId: 'fork-session-user-point',
      clientRequestId: 'fork-request-user-point',
      userId,
      agentId,
      workspaceId,
      workspaceType: 'personal',
      throughSequence: 1,
      runtimeSnapshot,
      systemPromptSnapshot,
    }),
    (error: unknown) => error instanceof PiSessionForkError && error.code === 'INVALID_FORK_POINT',
  );
  await assert.rejects(
    forkPiSession({
      sourceSessionId: 'source-session',
      targetSessionId: 'fork-session-tool-point',
      clientRequestId: 'fork-request-tool-point',
      userId,
      agentId,
      workspaceId,
      workspaceType: 'personal',
      throughSequence: 4,
      runtimeSnapshot,
      systemPromptSnapshot,
    }),
    (error: unknown) => error instanceof PiSessionForkError && error.code === 'INVALID_FORK_POINT',
  );

  const sourceAfterForks = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, 'source-session'), eq(piSessions.userId, userId)),
  });
  assert.equal(sourceAfterForks?.title, 'Research');
  assert.equal(sourceAfterForks?.summaryRevision, 2);
  const sourceMessagesAfterForks = await db.select().from(piMessages)
    .where(eq(piMessages.piSessionDbId, source.id));
  assert.equal(sourceMessagesAfterForks.length, 6);
}

main()
  .then(() => {
    console.log('[Chat Session Fork Test] passed');
  })
  .finally(async () => {
    moduleInternals._load = originalLoad;
    await testDatabase?.close();
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error('[Chat Session Fork Test] failed:', error);
    process.exitCode = 1;
  });
