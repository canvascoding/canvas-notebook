import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-session-title-'));
process.env.DATA = dataDir;

const now = new Date('2026-07-14T12:00:00.000Z');
const model = {
  id: 'title-test-model',
  name: 'Title Test Model',
  api: 'openai-completions',
  provider: 'title-test-provider',
  baseUrl: 'http://localhost.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 512,
} satisfies Model<'openai-completions'>;

function assistantCompletion(text: string, stopReason: 'stop' | 'error' = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: stopReason === 'stop' ? [{ type: 'text', text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === 'error' ? { errorMessage: 'Mock title failure' } : {}),
    timestamp: Date.now(),
  };
}

function message(text: string): AgentMessage[] {
  return [{ role: 'user', content: text, timestamp: Date.now() }];
}

async function main() {
  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
    if (request === 'server-only') return {};
    return originalLoad.call(this, request, parent, isMain);
  };

  const { db } = await import('../app/lib/db');
  const { piSessions, sessionChannelLinks, user } = await import('../app/lib/db/schema');
  const { generatePendingPiSessionTitle } = await import('../app/lib/pi/session-title-generator');

  await db.insert(user).values({
    id: 'title-user',
    name: 'Title User',
    email: 'title-user@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const createPendingSession = async (sessionId: string) => {
    await db.insert(piSessions).values({
      sessionId,
      userId: 'title-user',
      agentId: 'canvas-agent',
      provider: model.provider,
      model: model.id,
      thinkingLevel: null,
      title: 'New session',
      titleGenerationState: 'pending',
      channelId: 'app',
      channelSessionKey: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessionChannelLinks).values({
      sessionId,
      userId: 'title-user',
      channelId: 'app',
      channelSessionKey: `web:title-user:${sessionId}`,
      channelThreadKey: '',
      displayName: 'New session',
      isPrimary: true,
      deliveryPolicy: 'last_active',
      lastInboundAt: null,
      lastOutboundAt: null,
      createdAt: now,
      updatedAt: now,
    });
  };

  await createPendingSession('sess-generated-title');
  let promptText = '';
  const successfulStream: StreamFn = async (_requestedModel, context) => {
    promptText = String(context.messages[0]?.content ?? '');
    return { result: async () => assistantCompletion('"Projektplan für Kundenportal"') } as AssistantMessageEventStream;
  };

  const generated = await generatePendingPiSessionTitle({
    agentId: 'canvas-agent',
    messages: message('Erstelle bitte einen detaillierten Projektplan für unser Kundenportal.'),
    model,
    sessionId: 'sess-generated-title',
    streamFn: successfulStream,
    userId: 'title-user',
  });

  assert.equal(generated.updated, true);
  assert.equal(generated.title, 'Projektplan für Kundenportal');
  assert.equal(generated.titleGenerationState, 'generated');
  assert.match(promptText, /Kundenportal/u);

  const generatedRow = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'sess-generated-title'),
  });
  assert.equal(generatedRow?.title, 'Projektplan für Kundenportal');
  assert.equal(generatedRow?.titleGenerationState, 'generated');
  const generatedLink = await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, 'sess-generated-title'),
  });
  assert.equal(generatedLink?.displayName, 'Projektplan für Kundenportal');

  await createPendingSession('sess-manual-wins');
  let releaseCompletion!: () => void;
  const completionReleased = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  let streamStarted!: () => void;
  const streamStartedPromise = new Promise<void>((resolve) => { streamStarted = resolve; });
  const delayedStream: StreamFn = async () => {
    streamStarted();
    return {
      result: async () => {
        await completionReleased;
        return assistantCompletion('Should not overwrite manual title');
      },
    } as AssistantMessageEventStream;
  };

  const pendingGeneration = generatePendingPiSessionTitle({
    agentId: 'canvas-agent',
    messages: message('Plane einen Workshop für das Produktteam.'),
    model,
    sessionId: 'sess-manual-wins',
    streamFn: delayedStream,
    userId: 'title-user',
  });
  await streamStartedPromise;

  await db.update(piSessions)
    .set({ title: 'Produktteam Workshop', titleGenerationState: 'manual', updatedAt: new Date() })
    .where(and(
      eq(piSessions.sessionId, 'sess-manual-wins'),
      eq(piSessions.userId, 'title-user'),
    ));
  releaseCompletion();

  const manualResult = await pendingGeneration;
  assert.equal(manualResult.updated, false);
  const manualRow = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'sess-manual-wins'),
  });
  assert.equal(manualRow?.title, 'Produktteam Workshop');
  assert.equal(manualRow?.titleGenerationState, 'manual');

  await createPendingSession('sess-fallback-title');
  const failedStream: StreamFn = async () => ({
    result: async () => assistantCompletion('', 'error'),
  } as AssistantMessageEventStream);
  const fallback = await generatePendingPiSessionTitle({
    agentId: 'canvas-agent',
    messages: message('Bitte prüfe die Vertragsergänzung für den neuen Lieferanten.'),
    model,
    sessionId: 'sess-fallback-title',
    streamFn: failedStream,
    userId: 'title-user',
  });
  assert.equal(fallback.updated, true);
  assert.equal(fallback.titleGenerationState, 'fallback');
  assert.equal(fallback.title, 'Bitte prüfe die Vertragsergänzung für den neu...');
}

main()
  .then(() => console.log('pi-session-title-test: ok'))
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error('pi-session-title-test: failed', error);
    process.exitCode = 1;
  });
