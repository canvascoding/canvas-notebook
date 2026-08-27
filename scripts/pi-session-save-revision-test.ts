import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-pi-session-revision-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
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

async function main(): Promise<void> {
  const { db } = await import('../app/lib/db');
  const { user } = await import('../app/lib/db/schema');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const {
    finalizePiSessionAfterNoop,
    loadPiSessionWithSummary,
    savePiSession,
  } = await import('../app/lib/pi/session-store');
  const now = new Date('2026-08-27T12:00:00.000Z');
  const userId = 'user-session-revision';
  const sessionId = 'session-revision';
  await db.insert(user).values({
    id: userId,
    name: 'Session Revision Tester',
    email: 'session-revision@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });
  const firstMessage = {
    role: 'user',
    content: 'first message',
    timestamp: now.getTime(),
  } as AgentMessage;
  const initial = await savePiSession(
    sessionId,
    userId,
    'test-provider',
    'test-model',
    [firstMessage],
    undefined,
    { systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('test prompt', now) },
  );
  assert.equal(initial.sequenceCheckpoint, 1);
  assert.equal(initial.summaryRevision, 0);

  const summaryRevisionOne = {
    summaryText: 'Revision one summary',
    summaryUpdatedAt: now,
    summaryThroughTimestamp: now.getTime(),
    summaryThroughSequence: 1,
    summaryRevision: 0,
  };
  const summarySave = await savePiSession(
    sessionId,
    userId,
    'test-provider',
    'test-model',
    [firstMessage],
    summaryRevisionOne,
    { persistedLength: 1, expectedSummaryRevision: 0 },
  );
  assert.equal(summarySave.sequenceCheckpoint, 1);
  assert.equal(summarySave.summaryRevision, 1);
  assert.equal((await loadPiSessionWithSummary(sessionId, userId))?.summary.summaryRevision, 1);

  await assert.rejects(
    savePiSession(
      sessionId,
      userId,
      'test-provider',
      'test-model',
      [firstMessage],
      {
        ...summaryRevisionOne,
        summaryText: 'Stale overwrite',
        summaryThroughSequence: 2,
      },
      { persistedLength: 1, expectedSummaryRevision: 0 },
    ),
    /revision conflict/u,
  );
  const afterStale = await loadPiSessionWithSummary(sessionId, userId);
  assert.equal(afterStale?.summary.summaryText, 'Revision one summary');
  assert.equal(afterStale?.summary.summaryRevision, 1);

  await assert.rejects(
    savePiSession(
      sessionId,
      userId,
      'test-provider',
      'test-model',
      [firstMessage],
      {
        ...summaryRevisionOne,
        summaryRevision: 1,
        summaryText: 'Unfenced overwrite',
      },
      { persistedLength: 1 },
    ),
    /expectedSummaryRevision/u,
  );

  const secondMessage = {
    role: 'user',
    content: 'second message',
    timestamp: now.getTime() + 1_000,
  } as AgentMessage;
  const append = await savePiSession(
    sessionId,
    userId,
    'test-provider',
    'test-model',
    [firstMessage, secondMessage],
    {
      ...summaryRevisionOne,
      summaryRevision: 1,
    },
    { persistedLength: 1, expectedSummaryRevision: 1 },
  );
  assert.equal(append.persistedMessageCount, 1);
  assert.equal(append.sequenceCheckpoint, 2);
  assert.equal((secondMessage as unknown as { sequence?: number }).sequence, 2);
  assert.equal(append.summaryRevision, 1, 'an unchanged summary must not consume another revision');

  await assert.rejects(
    finalizePiSessionAfterNoop({
      sessionId,
      userId,
      retainedMessageCount: 1,
      summary: {
        ...summaryRevisionOne,
        summaryRevision: 1,
        summaryText: 'Stale no-op finalization',
      },
      expectedSummaryRevision: 0,
    }),
    /revision conflict/u,
  );
  const afterNoopConflict = await loadPiSessionWithSummary(sessionId, userId);
  assert.equal(afterNoopConflict?.messages.length, 2, 'a failed no-op CAS must roll back message deletion');
  assert.equal(afterNoopConflict?.summary.summaryRevision, 1);

  const finalizedRevision = await finalizePiSessionAfterNoop({
    sessionId,
    userId,
    retainedMessageCount: 1,
    summary: {
      ...summaryRevisionOne,
      summaryRevision: 1,
      summaryText: 'Committed no-op finalization',
    },
    expectedSummaryRevision: 1,
  });
  assert.equal(finalizedRevision, 2);
  const afterNoopCommit = await loadPiSessionWithSummary(sessionId, userId);
  assert.equal(afterNoopCommit?.messages.length, 1);
  assert.equal(afterNoopCommit?.summary.summaryRevision, 2);
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
